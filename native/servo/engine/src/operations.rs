use super::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use remote_browser_servo::{
    health::{CookieMetadata, Evidence, HealthPolicy, assess},
    snapshot::SCRIPT,
    webdriver::ELEMENT_KEY,
};
use servo::{
    Code, CookieSource, Key, KeyState, KeyboardEvent, Location, Modifiers, MouseButton,
    MouseButtonAction, MouseButtonEvent, MouseMoveEvent, NamedKey,
};
use std::time::{SystemTime, UNIX_EPOCH};
impl Engine {
    pub(super) fn execute(self: &Rc<Self>, request: &Request) -> Result<(), String> {
        if self.file_request(request)? {
            return Ok(());
        }
        let id = request.id;
        let tab_id = request.tab_id.as_deref().unwrap_or("");
        match request.op.as_str() {
            "status" => {
                let uncertain = self.tabs.borrow().values().any(|t| t.uncertain);
                self.reply(id, Ok(json!({"owner":"agent","uncertain":uncertain,"privateStateTokens":servo_private_state_tokens::diagnostics()})));
                return Ok(());
            }
            "tabs" => {
                let visible = self.visible.borrow();
                let tabs: Vec<_> = self
                    .tabs
                    .borrow()
                    .iter()
                    .map(|(id, tab)| {
                        json!({
                            "id": id,
                            "active": id == &*visible,
                            "owned": tab.owned,
                            "title": tab.view.page_title().map(|title| metadata::bounded(&title, metadata::TITLE_BYTES)),
                            "url": tab.view.url().map(|url| metadata::bounded(url.as_str(), metadata::URL_BYTES)),
                            "owner": if tab.human { "human" } else { "agent" },
                            "busy": tab.busy,
                            "filePicker": tab.file_picker.is_some(),
                            "uncertain": tab.uncertain,
                            "canGoBack":tab.history.1>0,
                            "canGoForward":tab.history.1+1<tab.history.0,
                            "reservation": self.reservations.borrow_mut().info(id, Instant::now()),
                        })
                    })
                    .collect();
                self.reply(id, Ok(json!(tabs)));
                return Ok(());
            }
            "open" => {
                if self.tabs.borrow().len() >= 32 {
                    return Err("At most 32 tabs may be open".into());
                }
                self.reply(id, Ok(json!(self.add_tab(true))));
                return Ok(());
            }
            "view" if request.human => {
                if !self.tabs.borrow().contains_key(tab_id) {
                    return Err("Unknown tab".into());
                }
                *self.visible.borrow_mut() = tab_id.into();
                self.reply(id, Ok(json!({"ok":true})));
                return Ok(());
            }
            "take" if request.human => {
                let mut tabs = self.tabs.borrow_mut();
                let t = tabs.get_mut(tab_id).ok_or("Unknown tab")?;
                if t.uncertain {
                    return Err("uncertain".into());
                }
                if t.takeover.is_some() {
                    return Err("busy".into());
                }
                if t.busy {
                    t.takeover = Some(id);
                } else {
                    t.human = true;
                    t.refs.clear();

                    self.reply(id, Ok(json!({"ok":true})));
                }
                return Ok(());
            }
            "return" if request.human => {
                let mut tabs = self.tabs.borrow_mut();
                let t = tabs.get_mut(tab_id).ok_or("Unknown tab")?;
                if t.busy {
                    return Err("busy".into());
                }
                t.human = false;
                t.refs.clear();
                self.reply(id, Ok(json!({"ok":true})));
                return Ok(());
            }
            "reserve" | "renew" | "release" => {
                {
                    let tabs = self.tabs.borrow();
                    let t = tabs.get(tab_id).ok_or("Unknown tab")?;
                    if t.uncertain {
                        return Err("uncertain".into());
                    }
                    if t.human || t.takeover.is_some() {
                        return Err("humanControl".into());
                    }
                    if t.busy {
                        return Err("busy".into());
                    }
                }
                let ttl = request.args["ttlMs"].as_u64().unwrap_or(300000);
                let mut registry = self.reservations.borrow_mut();
                let value = match request.op.as_str() {
                    "reserve" => serde_json::to_value(
                        registry
                            .reserve_named_for(
                                tab_id,
                                request.args["task"].as_str().ok_or("task is required")?,
                                request.args["agentName"].as_str().unwrap_or_else(|| {
                                    request.args["task"].as_str().unwrap_or("Agent")
                                }),
                                ttl,
                                &request.client_id,
                                Instant::now(),
                            )
                            .map_err(|e| e.to_string())?,
                    )
                    .map_err(|e| e.to_string())?,
                    "renew" => serde_json::to_value(
                        registry
                            .renew_for(
                                tab_id,
                                request.lease_id.as_deref().ok_or("leaseId is required")?,
                                ttl,
                                &request.client_id,
                                Instant::now(),
                            )
                            .map_err(|e| e.to_string())?,
                    )
                    .map_err(|e| e.to_string())?,
                    _ => {
                        registry
                            .release_for(
                                tab_id,
                                request.lease_id.as_deref().ok_or("leaseId is required")?,
                                &request.client_id,
                                Instant::now(),
                            )
                            .map_err(|e| e.to_string())?;
                        json!({"ok":true})
                    }
                };
                self.reply(id, Ok(value));
                return Ok(());
            }
            "shutdown" => {
                self.reply(id, Ok(json!({"ok":true})));
                self.quitting.set(true);
                return Ok(());
            }
            _ => {}
        }
        let view = self.begin(request)?;
        match request.op.as_str() {
            "upload" => self.upload(request)?,
            "choose_files" => self.choose_files(request)?,
            "download" => self.download(request)?,
            "record_check" => self.complete(id, Ok(json!({"ok":true}))),
            "select" => self.complete(id, Ok(json!({"ok":true}))),
            "close" => {
                if !self.tabs.borrow()[tab_id].owned {
                    return Err("Only API-created tabs can be closed".into());
                }
                self.complete(id, Ok(json!({"ok":true})));
                self.tabs.borrow_mut().remove(tab_id);
                self.reservations.borrow_mut().remove(tab_id);
                if *self.visible.borrow() == tab_id {
                    *self.visible.borrow_mut() = self
                        .tabs
                        .borrow()
                        .keys()
                        .next()
                        .cloned()
                        .unwrap_or_default();
                }
            }
            "back" | "forward" | "reload" => {
                self.invalidate(id);
                let mut tabs = self.tabs.borrow_mut();
                let tab = tabs.get_mut(tab_id).unwrap();
                let available = request.op == "reload"
                    || (request.op == "back" && tab.history.1 > 0)
                    || (request.op == "forward" && tab.history.1 + 1 < tab.history.0);
                if !available {
                    drop(tabs);
                    self.complete(id, Ok(json!({"ok":true})));
                } else {
                    tab.load_request = Some(id);
                    // Servo reload sets Started internally without notifying the delegate.
                    tab.load_started = request.op == "reload";
                    drop(tabs);
                    match request.op.as_str() {
                        "back" => {
                            view.go_back(1);
                        }
                        "forward" => {
                            view.go_forward(1);
                        }
                        _ => view.reload(),
                    }
                }
            }
            "navigate" => {
                let text = request.args["url"].as_str().ok_or("url is required")?;
                let url = Url::parse(text).map_err(|_| "Invalid page URL")?;
                if !(matches!(url.scheme(), "http" | "https") || text == "about:blank")
                    || !url.username().is_empty()
                    || url.password().is_some()
                {
                    return Err("Use an HTTP(S) URL without credentials, or about:blank".into());
                }
                self.invalidate(id);
                let ready = {
                    let mut tabs = self.tabs.borrow_mut();
                    let tab = tabs.get_mut(tab_id).unwrap();
                    tab.load_request = Some(id);
                    tab.load_started = tab.initialized;
                    tab.requested_url = Some(url.as_str().into());
                    if !tab.initialized {
                        tab.queued_navigation = Some(url.clone());
                    }
                    tab.initialized
                };
                if ready {
                    view.load(url);
                }
            }
            "snapshot" => {
                let limit = request.args["maxElements"].as_u64().unwrap_or(80);
                if !(1..=120).contains(&limit) {
                    return Err("maxElements must be between 1 and 120".into());
                }
                self.invalidate(id);
                let tab_id = tab_id.to_owned();
                self.evaluate(id, SCRIPT, json!([limit]), move |engine, mut value| {
                    value["tabId"] = json!(tab_id);
                    let Some(elements) = value["elements"].as_array_mut() else {
                        engine.complete(id, Err("Invalid snapshot".into()));
                        return;
                    };
                    let mut refs = HashMap::new();
                    for (index, e) in elements.iter_mut().enumerate() {
                        let Some(native) = e["element"][ELEMENT_KEY].as_str() else {
                            engine.complete(id, Err("Invalid element identity".into()));
                            return;
                        };
                        let reference = format!("r{id}e{index}");
                        refs.insert(reference.clone(), native.to_owned());
                        e["reference"] = json!(reference);
                        e.as_object_mut().unwrap().remove("element");
                    }
                    if let Some(tab) = engine.tabs.borrow_mut().get_mut(&tab_id) {
                        tab.refs = refs;
                    }
                    engine.complete(id, Ok(value));
                });
            }
            "evaluate" => {
                let script = request.args["script"]
                    .as_str()
                    .ok_or("script is required")?;
                if script.is_empty() || script.len() > 32768 {
                    return Err("Script must contain 1 to 32768 bytes".into());
                }
                self.invalidate(id);
                self.evaluate(id, script, json!([]), move |engine, value| {
                    if value.to_string().len() > 32768 {
                        engine.complete(id, Err("Script result exceeds 32 KiB".into()));
                    } else {
                        engine.complete(id, Ok(value));
                    }
                });
            }
            "scroll" => {
                let x = request.args["x"].as_i64().unwrap_or(0);
                let y = request.args["y"].as_i64().ok_or("y is required")?;
                if x.unsigned_abs() > 10000 || y.unsigned_abs() > 10000 {
                    return Err("Scroll deltas must be within 10000 pixels".into());
                }
                self.evaluate(
                    id,
                    "window.scrollBy(arguments[0],arguments[1]);return {x:scrollX,y:scrollY};",
                    json!([x, y]),
                    move |engine, value| engine.complete(id, Ok(value)),
                );
            }
            "click" => {
                let native = self.reference(request)?;
                self.command(
                    id,
                    move |sender| WebDriverScriptCommand::ElementClick(native, sender),
                    move |engine, element| {
                        let Some(element) = element else {
                            engine.complete(id, Ok(json!({"ok":true})));
                            return;
                        };
                        engine.command(
                            id,
                            move |sender| {
                                WebDriverScriptCommand::ScrollAndGetBoundingClientRect(
                                    element, sender,
                                )
                            },
                            move |engine, rect| {
                                let point = servo::DevicePoint::new(
                                    rect.origin.x + rect.size.width / 2.0,
                                    rect.origin.y + rect.size.height / 2.0,
                                )
                                .into();
                                engine.input(id, mouse_events(point));
                            },
                        );
                    },
                );
            }
            "fill" => {
                let element = self.reference(request)?;
                let text = request.args["text"]
                    .as_str()
                    .ok_or("text is required")?
                    .to_owned();
                if text.chars().count() > 8192 {
                    return Err("Text exceeds 8192 characters".into());
                }
                let target = element.clone();
                self.command(
                    id,
                    move |sender| WebDriverScriptCommand::ElementClear(element, sender),
                    move |engine, _| engine.type_text(id, target, text),
                );
            }
            "press" => {
                let element = self.reference(request)?;
                let key = named_key(request.args["key"].as_str().ok_or("key is required")?)?;
                self.command(
                    id,
                    move |sender| {
                        WebDriverScriptCommand::WillSendKeys(element, String::new(), false, sender)
                    },
                    move |engine, _| engine.input(id, key_events(key, Modifiers::empty())),
                );
            }
            "input" if request.human => match request.args["kind"].as_str() {
                Some("click") => {
                    let x = request.args["x"].as_f64().ok_or("x is required")?;
                    let y = request.args["y"].as_f64().ok_or("y is required")?;
                    if !x.is_finite()
                        || !y.is_finite()
                        || !(0.0..=1024.0).contains(&x)
                        || !(0.0..=768.0).contains(&y)
                    {
                        return Err("Input point is outside the viewport".into());
                    }
                    self.input(
                        id,
                        mouse_events(servo::DevicePoint::new(x as f32, y as f32).into()),
                    );
                }
                Some("text") => {
                    let text = request.args["text"].as_str().ok_or("text is required")?;
                    if text.chars().count() > 8192 {
                        return Err("Text exceeds 8192 characters".into());
                    }
                    self.input(
                        id,
                        text.chars()
                            .flat_map(|c| {
                                key_events(Key::Character(c.to_string()), Modifiers::empty())
                            })
                            .collect(),
                    );
                }
                Some("key") => {
                    let value = request.args["key"].as_str().ok_or("key is required")?;
                    let key = if value.chars().count() == 1 {
                        Key::Character(value.into())
                    } else {
                        named_key(value)?
                    };
                    let mut modifiers = Modifiers::empty();
                    for (name, m) in [
                        ("ctrl", Modifiers::CONTROL),
                        ("alt", Modifiers::ALT),
                        ("shift", Modifiers::SHIFT),
                        ("meta", Modifiers::META),
                    ] {
                        if request.args[name].as_bool().unwrap_or(false) {
                            modifiers.insert(m);
                        }
                    }
                    self.input(id, key_events(key, modifiers));
                }
                _ => return Err("Unknown human input kind".into()),
            },
            "clipboard_read" => self.complete(id, Ok(json!({"text":self.clipboard.text()}))),
            "clipboard_write" => {
                self.clipboard
                    .write(request.args["text"].as_str().ok_or("text is required")?)?;
                self.complete(id, Ok(json!({"ok":true})));
            }
            "clipboard_copy" | "clipboard_cut" | "clipboard_paste" => {
                let action = match request.op.as_str() {
                    "clipboard_copy" => servo::ClipboardAction::Copy,
                    "clipboard_cut" => servo::ClipboardAction::Cut,
                    _ => servo::ClipboardAction::Paste,
                };
                self.input(id, vec![InputEvent::EditingAction(action)]);
            }
            "screenshot" | "save_screenshot" => {
                let name = if request.op == "save_screenshot" {
                    let name = request.args["name"].as_str().unwrap_or("Page capture.png");
                    remote_browser_servo::files::validate_name(name).map_err(|e| e.to_string())?;
                    if !name.ends_with(".png") {
                        return Err("Use a .png filename".into());
                    }
                    Some(name.to_owned())
                } else {
                    None
                };
                // Capture the current rendered viewport without waiting for network idle.
                let context = view.rendering_context();
                context
                    .make_current()
                    .map_err(|_| "Screenshot context unavailable")?;
                view.paint();
                let mut rect = servo::ScreenGeometry::default().window_rect;
                let size = context.size2d().to_i32();
                rect.max.x = size.width;
                rect.max.y = size.height;
                let image = context
                    .read_to_image(rect)
                    .ok_or("Screenshot unavailable")?;
                let mut bytes = std::io::Cursor::new(Vec::new());
                image::DynamicImage::ImageRgba8(image)
                    .write_to(&mut bytes, image::ImageFormat::Png)
                    .map_err(|_| "PNG encoding failed")?;
                let bytes = bytes.into_inner();
                if let Some(name) = name {
                    let result = self
                        .files
                        .save("captures", &name, &bytes)
                        .map(|file| serde_json::to_value(file).unwrap())
                        .map_err(|error| error.to_string());
                    self.complete(id, result);
                } else {
                    let encoded = STANDARD.encode(bytes);
                    if encoded.len() > 6 * 1024 * 1024 {
                        self.complete(id, Err("Screenshot exceeds 6 MiB".into()));
                    } else {
                        self.complete(id, Ok(json!(encoded)));
                    }
                }
            }

            "health" => {
                let policy: HealthPolicy = serde_json::from_value(request.args.clone())
                    .map_err(|_| "Invalid health policy")?;
                policy.validate().map_err(|e| e.to_string())?;
                let url = view.url().ok_or("Page URL unavailable")?;
                if url.origin()
                    != Url::parse(&policy.origin)
                        .map_err(|_| "Invalid origin")?
                        .origin()
                {
                    return Err(
                        "Open a page on the configured service origin before checking health"
                            .into(),
                    );
                }
                let weak = Rc::downgrade(self);
                self.servo.site_data_manager().cookies_for_url_async(
                    url,
                    CookieSource::HTTP,
                    move |cookies| {
                        let Some(engine) = weak.upgrade() else { return };
                        let metadata: Vec<_> = cookies.into_iter().map(|cookie| CookieMetadata {
                            name: cookie.name().into(),
                            expiry: cookie.expires_datetime().map(|date| date.unix_timestamp().max(0) as u64),
                        }).collect();
                        let args = json!([policy.authenticated_selector, policy.login_selector]);
                        engine.evaluate(
                            id,
                            "const visible=s=>s&&Array.from(document.querySelectorAll(s)).some(e=>{const c=getComputedStyle(e);return c.display!=='none'&&c.visibility!=='hidden'&&e.getClientRects().length>0});return {authenticated:!!visible(arguments[0]),loginRequired:!!visible(arguments[1])};",
                            args,
                            move |engine, value| {
                                let evidence: Evidence = serde_json::from_value(value).unwrap_or_default();
                                let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|time| time.as_secs()).unwrap_or(0);
                                let health = assess(&policy, &metadata, evidence, now);
                                engine.complete(id, Ok(serde_json::to_value(health).unwrap()));
                            },
                        );
                    },
                );
            }
            _ => return Err("Unknown operation".into()),
        }
        Ok(())
    }
    fn type_text(self: &Rc<Self>, id: u64, element: String, text: String) {
        let keys = text.clone();
        self.command(
            id,
            move |sender| WebDriverScriptCommand::WillSendKeys(element, text, false, sender),
            move |engine, handled| {
                if !handled {
                    engine.complete(id, Ok(json!({"ok":true})));
                } else {
                    engine.input(
                        id,
                        keys.chars()
                            .flat_map(|c| {
                                key_events(Key::Character(c.to_string()), Modifiers::empty())
                            })
                            .collect(),
                    );
                }
            },
        );
    }
}
fn mouse_events(point: servo::WebViewPoint) -> Vec<InputEvent> {
    vec![
        InputEvent::MouseMove(MouseMoveEvent::new(point)),
        InputEvent::MouseButton(MouseButtonEvent::new(
            MouseButtonAction::Down,
            MouseButton::Primary,
            point,
        )),
        InputEvent::MouseButton(MouseButtonEvent::new(
            MouseButtonAction::Up,
            MouseButton::Primary,
            point,
        )),
    ]
}
fn key_events(key: Key, modifiers: Modifiers) -> Vec<InputEvent> {
    [KeyState::Down, KeyState::Up]
        .into_iter()
        .map(|state| {
            InputEvent::Keyboard(KeyboardEvent::new_without_event(
                state,
                key.clone(),
                Code::Unidentified,
                Location::Standard,
                modifiers,
                false,
                false,
            ))
        })
        .collect()
}
fn named_key(key: &str) -> Result<Key, String> {
    Ok(Key::Named(match key {
        "Enter" => NamedKey::Enter,
        "Tab" => NamedKey::Tab,
        "Escape" => NamedKey::Escape,
        "Backspace" => NamedKey::Backspace,
        "Delete" => NamedKey::Delete,
        "ArrowLeft" => NamedKey::ArrowLeft,
        "ArrowRight" => NamedKey::ArrowRight,
        "ArrowUp" => NamedKey::ArrowUp,
        "ArrowDown" => NamedKey::ArrowDown,
        "Home" => NamedKey::Home,
        "End" => NamedKey::End,
        _ => return Err("Unsupported key".into()),
    }))
}
