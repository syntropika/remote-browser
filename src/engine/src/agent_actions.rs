//! Native page actions shared by individual MCP tools and JavaScript batches.
use super::*;

const LOCATE: &str = r#"(target) => {
  if (typeof target === 'string') {
    const nodes = document.querySelectorAll(target);
    if (nodes.length !== 1) throw Error('Target must match exactly one element');
    return nodes[0];
  }
  const role = e => e.getAttribute('role') || ({button:'button',a:'link',select:'combobox',textarea:'textbox',input:({checkbox:'checkbox',radio:'radio',submit:'button',button:'button'}[e.type] || 'textbox')}[e.localName]);
  const name = e => {
    const ids = e.getAttribute('aria-labelledby');
    return String((ids && ids.split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ')) || e.getAttribute('aria-label') || (e.labels?.length && Array.from(e.labels).map(l => l.textContent).join(' ')) || e.getAttribute('alt') || e.getAttribute('placeholder') || e.innerText || e.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
  };
  const nodes = Array.from(document.querySelectorAll('*')).slice(0, 3000).filter(e => role(e) === target.role && name(e) === target.name);
  if (nodes.length !== 1) throw Error('Role and name must match exactly one element');
  return nodes[0];
}"#;
const BOUNDS: &str = r#"function(scroll = true) {
  if (!this.isConnected || this.disabled || this.getAttribute('aria-disabled') === 'true') throw Error('Target is detached or disabled');
  if (scroll) this.scrollIntoView({block:'center', inline:'center', behavior:'instant'});
  const r = this.getBoundingClientRect(), s = getComputedStyle(this);
  if (!r.width || !r.height || s.display === 'none' || s.visibility !== 'visible') throw Error('Target is not visible');
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const hit = document.elementFromPoint(x, y);
  if (!hit || !(hit === this || this.contains(hit))) throw Error('Target is covered by another element');
  return {x, y, width:r.width, height:r.height};
}"#;

impl Engine {
    fn target_object(&mut self, at: usize, target: &Value) -> Result<String, String> {
        let result = if let Some(reference) = target.as_str().filter(|s| {
            s.split_once(':')
                .is_some_and(|(a, b)| a.parse::<u64>().is_ok() && b.parse::<usize>().is_ok())
        }) {
            let (object, index) = self.element(at, reference)?;
            self.protocol(at, "Runtime.callFunctionOn", json!({"objectId":object,"functionDeclaration":"function(index) { const e = this.elements[index]?.element; if (!e?.isConnected) throw Error('Target is detached'); return e; }","arguments":[{"value":index}],"returnByValue":false}))?
        } else {
            let encoded = serde_json::to_string(target).map_err(|e| e.to_string())?;
            self.protocol(
                at,
                "Runtime.evaluate",
                json!({"expression":format!("({LOCATE})({encoded})"),"returnByValue":false}),
            )?
        };
        Self::action_result(&result)?;
        result["result"]["objectId"]
            .as_str()
            .map(str::to_owned)
            .ok_or("Target is not a DOM element".into())
    }
    fn action_result(result: &Value) -> Result<Value, String> {
        if let Some(exception) = result.get("exceptionDetails") {
            return Err(exception["exception"]["description"]
                .as_str()
                .or_else(|| exception["text"].as_str())
                .unwrap_or("Page action failed")
                .chars()
                .take(2048)
                .collect());
        }
        Ok(result["result"]["value"].clone())
    }
    fn target_call(
        &mut self,
        at: usize,
        object: &str,
        function: &str,
        args: Value,
    ) -> Result<Value, String> {
        let args: Vec<_> = args
            .as_array()
            .into_iter()
            .flatten()
            .map(|value| json!({"value":value}))
            .collect();
        let result = self.protocol(at, "Runtime.callFunctionOn", json!({"objectId":object,"functionDeclaration":function,"arguments":args,"returnByValue":true}))?;
        Self::action_result(&result)
    }
    fn target_bounds(&mut self, at: usize, object: &str) -> Result<Value, String> {
        let first = self.target_call(at, object, BOUNDS, json!([]))?;
        pump_for(Duration::from_millis(32));
        let second = self.target_call(at, object, BOUNDS, json!([]))?;
        if ["x", "y", "width", "height"].iter().any(|key| {
            (first[key].as_f64().unwrap_or_default() - second[key].as_f64().unwrap_or_default())
                .abs()
                > 1.0
        }) {
            return Err("Target is moving; wait and try again".into());
        }
        Ok(second)
    }
    fn drag_bounds(&mut self, at: usize, source: &str, destination: &str) -> Result<Value, String> {
        // Scroll both endpoints before reading either coordinate. Never press until
        // both centers are visible, hit-tested and stable in the same viewport.
        let arguments = json!([{"objectId":destination}]);
        let prepared = self.protocol(at, "Runtime.callFunctionOn", json!({
            "objectId":source,"arguments":arguments,"returnByValue":true,
            "functionDeclaration":"function(destination) { for (const element of [this, destination]) element.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'}); }"
        }))?;
        Self::action_result(&prepared)?;
        let function = format!(
            "function(destination) {{ const bounds = {BOUNDS}; return [bounds.call(this, false), bounds.call(destination, false)]; }}"
        );
        let mut read = || -> Result<Value, String> {
            let result = self.protocol(at, "Runtime.callFunctionOn", json!({"objectId":source,"arguments":arguments,"functionDeclaration":function,"returnByValue":true}))?;
            Self::action_result(&result)
        };
        let first = read()?;
        pump_for(Duration::from_millis(32));
        let second = read()?;
        if (0..2).any(|index| {
            ["x", "y", "width", "height"].iter().any(|key| {
                (first[index][key].as_f64().unwrap_or_default()
                    - second[index][key].as_f64().unwrap_or_default())
                .abs()
                    > 1.0
            })
        }) {
            return Err("Drag endpoints are moving; wait and try again".into());
        }
        Ok(second)
    }
    fn resolve_dialog(&mut self, at: usize, args: &Value, human: bool) -> Result<Value, String> {
        let accept = args["accept"].as_bool().ok_or("accept must be a boolean")?;
        let prompt = match args.get("promptText") {
            None | Some(Value::Null) => "",
            Some(value) => value.as_str().ok_or("promptText must be text")?,
        };
        if prompt.len() > 32768 {
            return Err("promptText exceeds 32768 bytes".into());
        }
        let mut pending = self.tabs[at].dialog.borrow_mut();
        let dialog = pending.as_ref().ok_or("No JavaScript dialog is pending")?;
        if human && args["id"].as_str() != Some(dialog.id.as_str()) {
            return Err(
                "This JavaScript dialog is no longer current; refresh and try again".into(),
            );
        }
        let dialog = pending.take().ok_or("No JavaScript dialog is pending")?;
        drop(pending);
        dialog
            .callback
            .cont(i32::from(accept), Some(&CefString::from(prompt)));
        Ok(Value::Null)
    }
    fn agent_target_action(&mut self, at: usize, op: &str, args: &Value) -> Result<Value, String> {
        let object = self.target_object(at, &args["target"])?;
        let outcome = (|| {
            match op {
                "agent_click" | "agent_hover" => {
                    let bounds = self.target_bounds(at, &object)?;
                    let point = MouseEvent {
                        x: bounds["x"].as_f64().unwrap_or_default() as i32,
                        y: bounds["y"].as_f64().unwrap_or_default() as i32,
                        modifiers: 0,
                    };
                    let host = self.tabs[at].browser.host().ok_or("the tab has no host")?;
                    host.send_mouse_move_event(Some(&point), 0);
                    if op == "agent_click" {
                        host.set_focus(1);
                        host.send_mouse_click_event(Some(&point), MouseButtonType::LEFT, 0, 1);
                        host.send_mouse_click_event(Some(&point), MouseButtonType::LEFT, 1, 1);
                    }
                    self.tabs[at].pointer = (point.x, point.y);
                }
                "agent_type" => {
                    self.target_bounds(at, &object)?;
                    self.target_call(at, &object, "function() { if (!this.isConnected || this.disabled || this.readOnly || !(this.isContentEditable || this.localName === 'textarea' || (this.localName === 'input' && !['checkbox','radio','file','button','submit','range','color'].includes(this.type)))) throw Error('Target is not an editable text field'); this.focus(); if (this.isContentEditable) { const r = document.createRange(); r.selectNodeContents(this); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } else this.select(); return true; }", json!([]))?;
                    let text = args["text"].as_str().unwrap_or_default();
                    if args["slowly"].as_bool() == Some(true) {
                        self.input(at, &json!({"kind":"key","key":"Delete"}))?;
                        for ch in text.chars() {
                            self.input(at, &json!({"kind":"key","key":ch.to_string()}))?;
                        }
                    } else if text.is_empty() {
                        self.input(at, &json!({"kind":"key","key":"Delete"}))?;
                    } else {
                        self.protocol(at, "Input.insertText", json!({"text":text}))?;
                    }
                    if args["submit"].as_bool() == Some(true) {
                        self.input(at, &json!({"kind":"key","key":"Enter"}))?;
                    }
                }
                "agent_select" => {
                    self.target_bounds(at, &object)?;
                    self.target_call(at, &object, "function(values) { if (!this.isConnected || this.disabled || this.localName !== 'select') throw Error('Target is not an enabled select'); if (!this.multiple && values.length > 1) throw Error('Target does not allow multiple values'); const options = Array.from(this.options); if (values.some(value => !options.some(option => option.value === value && !option.disabled && !(option.parentElement.localName === 'optgroup' && option.parentElement.disabled)))) throw Error('An option is missing or disabled'); for (const option of options) option.selected = values.includes(option.value); this.dispatchEvent(new Event('input', {bubbles:true})); this.dispatchEvent(new Event('change', {bubbles:true})); return true; }", json!([args["values"]]))?;
                }
                _ => return Err("Unsupported target action".into()),
            }
            Ok(Value::Null)
        })();
        let _ = self.protocol(at, "Runtime.releaseObject", json!({"objectId":object}));
        outcome
    }
    pub(super) fn agent_action(&mut self, at: usize, call: &Call) -> Option<Result<Value, String>> {
        let args = &call.args;
        Some(match call.op.as_str() {
            "validate_lease" => {
                if call.lease_id.is_some() {
                    Ok(Value::Null)
                } else {
                    Err("A leaseId is required".into())
                }
            }
            "agent_click" | "agent_hover" | "agent_type" | "agent_select" => {
                self.agent_target_action(at, &call.op, args)
            }
            "agent_press" => (|| {
                if !args["target"].is_null() {
                    let object = self.target_object(at, &args["target"])?;
                    let outcome=self.target_call(at,&object,"function() { if (!this.isConnected || this.disabled) throw Error('Target is detached or disabled'); this.focus(); return true; }",json!([]));
                    let _ = self.protocol(at, "Runtime.releaseObject", json!({"objectId":object}));
                    outcome?;
                }
                self.input(at, &json!({"kind":"key","key":args["key"]}))
            })(),
            "agent_upload" => (|| {
                let paths = self.staged(&args["fileIds"])?;
                let object = self.target_object(at, &args["target"])?;
                let outcome = self.protocol(
                    at,
                    "DOM.setFileInputFiles",
                    json!({"objectId":object,"files":paths}),
                );
                let _ = self.protocol(at, "Runtime.releaseObject", json!({"objectId":object}));
                outcome?;
                Ok(Value::Null)
            })(),
            "agent_drag" => (|| {
                let source = self.target_object(at, &args["startTarget"])?;
                let destination = match self.target_object(at, &args["endTarget"]) {
                    Ok(value) => value,
                    Err(error) => {
                        let _ =
                            self.protocol(at, "Runtime.releaseObject", json!({"objectId":source}));
                        return Err(error);
                    }
                };
                let outcome = (|| {
                    let bounds = self.drag_bounds(at, &source, &destination)?;
                    let start = &bounds[0];
                    let end = &bounds[1];
                    let (x, y) = (
                        start["x"].as_f64().unwrap_or_default(),
                        start["y"].as_f64().unwrap_or_default(),
                    );
                    self.input(at, &json!({"kind":"move","x":x,"y":y}))?;
                    self.input(at, &json!({"kind":"down","x":x,"y":y}))?;
                    for step in 1..=12 {
                        let fraction = f64::from(step) / 12.;
                        let point = MouseEvent {
                            x: (x + (end["x"].as_f64().unwrap_or_default() - x) * fraction) as i32,
                            y: (y + (end["y"].as_f64().unwrap_or_default() - y) * fraction) as i32,
                            modifiers: 1 << 4,
                        };
                        let host = self.tabs[at].browser.host().ok_or("the tab has no host")?;
                        host.send_mouse_move_event(Some(&point), 0);
                        self.tabs[at].pointer = (point.x, point.y);
                        pump_for(Duration::from_millis(8));
                    }
                    self.input(at, &json!({"kind":"up","x":end["x"],"y":end["y"]}))
                })();
                let _ = self.protocol(at, "Runtime.releaseObject", json!({"objectId":source}));
                let _ = self.protocol(at, "Runtime.releaseObject", json!({"objectId":destination}));
                outcome
            })(),
            "agent_text" => self.evaluate(
                at,
                "document.body?.innerText?.slice(0, 100000) || ''",
                false,
            ),
            "agent_wait" => {
                let encoded = serde_json::to_string(args).unwrap_or_else(|_| "{}".into());
                self.evaluate(at, &format!("((args) => {{ const text = document.body?.innerText || ''; return (args.text == null || text.includes(args.text)) && (args.textGone == null || !text.includes(args.textGone)); }})({encoded})"), false)
            }
            "agent_evaluate" => {
                self.release(at);
                self.evaluate(
                    at,
                    &format!("({})()", args["function"].as_str().unwrap_or_default()),
                    true,
                )
            }
            "agent_screenshot" => (|| {
                let layout = self.protocol(at, "Page.getLayoutMetrics", json!({}))?;
                let size = &layout["cssContentSize"];
                let w = size["width"].as_f64().unwrap_or(0.);
                let h = size["height"].as_f64().unwrap_or(0.);
                let scale = f64::from(self.surface.scale);
                let pixels_w = (w * scale).ceil();
                let pixels_h = (h * scale).ceil();
                if w <= 0.
                    || h <= 0.
                    || pixels_w > 16384.
                    || pixels_h > 16384.
                    || pixels_w * pixels_h > 32_000_000.
                {
                    return Err(
                        "Full-page capture exceeds 32 million pixels or 16384 pixels per side"
                            .into(),
                    );
                }
                let result = self.protocol(at,"Page.captureScreenshot",json!({"format":"png","captureBeyondViewport":true,"clip":{"x":0,"y":0,"width":w,"height":h,"scale":1}}))?;
                Ok(result["data"].clone())
            })(),
            "agent_dialog" => self.resolve_dialog(at, args, false),
            "js_dialog" if call.human => self.resolve_dialog(at, args, true),
            _ => return None,
        })
    }
}

pub(super) struct PendingDialog {
    pub callback: JsdialogCallback,
    id: String,
    kind: &'static str,
    origin: String,
    message: String,
    default_prompt: String,
}
impl PendingDialog {
    pub(super) fn describe(&self) -> Value {
        json!({"id":self.id,"type":self.kind,"origin":self.origin,"message":self.message,"defaultPromptText":self.default_prompt})
    }
}
wrap_jsdialog_handler! {
    pub(super) struct Dialogs { pending: Rc<RefCell<Option<PendingDialog>>>, }
    impl JsdialogHandler {
        fn on_jsdialog(&self, _browser: Option<&mut Browser>, origin: Option<&CefString>, kind: JsdialogType, message: Option<&CefString>, default: Option<&CefString>, callback: Option<&mut JsdialogCallback>, _suppress: Option<&mut i32>) -> i32 {
            let Some(callback) = callback else { return 0; };
            let brief = |value: Option<&CefString>| value.map(ToString::to_string).unwrap_or_default().chars().take(8192).collect::<String>();
            *self.pending.borrow_mut() = Some(PendingDialog {
                callback:callback.clone(), id:uuid::Uuid::new_v4().to_string(),
                kind: if kind == JsdialogType::PROMPT { "prompt" } else if kind == JsdialogType::CONFIRM { "confirm" } else { "alert" },
                origin: url::Url::parse(&brief(origin)).map(|url| {
                    if url.scheme() == "chrome-extension" { format!("chrome-extension://{}", url.host_str().unwrap_or_default()) } else { url.origin().ascii_serialization() }
                }).unwrap_or_else(|_| "Website".into()).chars().take(1024).collect(),
                message:brief(message), default_prompt:brief(default),
            });
            1
        }
        fn on_reset_dialog_state(&self, _browser: Option<&mut Browser>) { self.pending.borrow_mut().take(); }
    }
}
