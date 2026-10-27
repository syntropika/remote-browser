//! Field-aligned human editing through native Chromium input, scoped to a live document.
use super::{Call, Engine, SETTLE, pump_for};
use serde_json::{Value, json};
use std::sync::atomic::{AtomicU64, Ordering};

static GENERATIONS: AtomicU64 = AtomicU64::new(1);

pub(super) struct Editor {
    page: u64,
    object: String,
    generation: u64,
}

impl Engine {
    fn editor_call(
        &mut self,
        at: usize,
        function: &str,
        arguments: Value,
    ) -> Result<Value, String> {
        let page = self.tabs[at].shared.pages.load(Ordering::Acquire);
        if self.tabs[at]
            .editor
            .as_ref()
            .is_none_or(|editor| editor.page != page)
        {
            let generation = GENERATIONS.fetch_add(1, Ordering::Relaxed);
            let expression =
                include_str!("editor.js").replace("EDITOR_GENERATION", &format!("{generation}"));
            let result = self.protocol(
                at,
                "Runtime.evaluate",
                json!({"expression":expression,"returnByValue":false}),
            )?;
            let object = result["result"]["objectId"]
                .as_str()
                .ok_or("The field bridge could not start")?
                .to_owned();
            self.tabs[at].editor = Some(Editor {
                page,
                object,
                generation,
            });
        }
        let object = self.tabs[at]
            .editor
            .as_ref()
            .ok_or("No field bridge")?
            .object
            .clone();
        let args: Vec<_> = arguments
            .as_array()
            .into_iter()
            .flatten()
            .map(|value| json!({"value":value}))
            .collect();
        let result = match self.protocol(at, "Runtime.callFunctionOn", json!({"objectId":object,"functionDeclaration":function,"arguments":args,"returnByValue":true})) {
            Ok(result) => result,
            Err(_) => {
                self.tabs[at].editor = None;
                return Err("The page changed; tap the field again".into());
            }
        };
        if result.get("exceptionDetails").is_some() {
            return Err("The field changed or lost focus; tap it again".into());
        }
        Ok(result["result"]["value"].clone())
    }

    pub(super) fn editor_action(
        &mut self,
        at: usize,
        call: &Call,
    ) -> Option<Result<Value, String>> {
        if !call.op.starts_with("editor_") {
            return None;
        }
        Some((|| {
            if !call.human {
                return Err("Field editing requires the controlling dashboard".into());
            }
            let args = &call.args;
            if call.op == "editor_fields" {
                let fields = self.editor_call(at, "function(){return this.scan()}", json!([]))?;
                let view = *self.tabs[at].shared.size.lock().unwrap();
                return Ok(json!({"fields":fields,"width":view.width,"height":view.height}));
            }
            let reference = args["reference"]
                .as_str()
                .ok_or("A field reference is required")?;
            // A page generation prevents a queued edit from targeting a different document.
            let page = self.tabs[at].shared.pages.load(Ordering::Acquire);
            if self.tabs[at].editor.as_ref().is_none_or(|editor| {
                editor.page != page || !reference.starts_with(&format!("{}:", editor.generation))
            }) {
                return Err("This field belongs to an earlier page".into());
            }
            match call.op.as_str() {
                "editor_focus" => {
                    let rect = self.editor_call(
                        at,
                        "function(ref){return this.prepare(ref)}",
                        json!([reference]),
                    )?;
                    let x = args["x"].as_f64().unwrap_or(
                        rect["x"].as_f64().unwrap_or(0.)
                            + rect["width"].as_f64().unwrap_or(0.) / 2.,
                    );
                    let y = args["y"].as_f64().unwrap_or(
                        rect["y"].as_f64().unwrap_or(0.)
                            + rect["height"].as_f64().unwrap_or(0.) / 2.,
                    );
                    let inside = |coordinate: f64, start: &Value, length: &Value| {
                        coordinate >= start.as_f64().unwrap_or(0.)
                            && coordinate
                                <= start.as_f64().unwrap_or(0.) + length.as_f64().unwrap_or(0.)
                    };
                    if !inside(x, &rect["x"], &rect["width"])
                        || !inside(y, &rect["y"], &rect["height"])
                    {
                        return Err("This field moved; tap it again".into());
                    }
                    self.input(at, &json!({"kind":"click","x":x,"y":y}))?;
                    self.editor_call(
                        at,
                        "function(ref){return this.focus(ref)}",
                        json!([reference]),
                    )
                }
                "editor_update" => {
                    let expected = args["expected"]
                        .as_str()
                        .ok_or("The previous field value is required")?;
                    let desired = args["value"].as_str().ok_or("A field value is required")?;
                    if expected.len() > 16384
                        || desired.len() > 16384
                        || desired.encode_utf16().count() > 4096
                    {
                        return Err("Field text exceeds the editing limit".into());
                    }
                    let current = self.editor_call(
                        at,
                        "function(ref){return this.state(ref)}",
                        json!([reference]),
                    )?;
                    if current["value"].as_str() != Some(expected) {
                        return Err("The page changed this field; tap it again".into());
                    }
                    let (start, end, text) = replacement(expected, desired);
                    if expected != desired {
                        let ranged = self
                            .editor_call(
                                at,
                                "function(ref,start,end){return this.range(ref,start,end)}",
                                json!([reference, start, end]),
                            )?
                            .as_bool()
                            == Some(true);
                        if !ranged {
                            self.input(at, &json!({"kind":"key","key":"a","ctrl":!cfg!(target_os = "macos"),"meta":cfg!(target_os = "macos")}))?;
                        }
                        if (ranged && text.is_empty()) || (!ranged && desired.is_empty()) {
                            self.input(at, &json!({"kind":"key","key":"Delete"}))?;
                        } else {
                            self.protocol(
                                at,
                                "Input.insertText",
                                json!({"text":if ranged {text} else {desired}}),
                            )?;
                        }
                    }
                    let current = self.editor_call(
                        at,
                        "function(ref){return this.state(ref)}",
                        json!([reference]),
                    )?;
                    if current["value"].as_str() == Some(desired) {
                        self.editor_call(at,"function(ref,start,end){this.range(ref,start,end);return this.state(ref)}",json!([reference,args["start"].as_u64().unwrap_or(desired.encode_utf16().count() as u64),args["end"].as_u64().unwrap_or(desired.encode_utf16().count() as u64)]))
                    } else {
                        Ok(current)
                    }
                }
                "editor_key" => {
                    let key = args["key"].as_str().ok_or("A key is required")?;
                    if !matches!(key, "Enter" | "Tab" | "Escape") {
                        return Err("Unsupported field key".into());
                    }
                    self.editor_call(
                        at,
                        "function(ref){return this.state(ref)}",
                        json!([reference]),
                    )?;
                    self.input(at, &json!({"kind":"key","key":key}))?;
                    pump_for(SETTLE);
                    Ok(self
                        .editor_call(
                            at,
                            "function(ref){return this.state(ref)}",
                            json!([reference]),
                        )
                        .unwrap_or(Value::Null))
                }
                "editor_blur" => self.editor_call(
                    at,
                    "function(ref){return this.blur(ref)}",
                    json!([reference]),
                ),
                _ => Err("Unknown field operation".into()),
            }
        })())
    }
}

/// Find the minimal replacement without splitting UTF-16 surrogate pairs.
fn replacement<'a>(old: &str, new: &'a str) -> (usize, usize, &'a str) {
    let prefix = old
        .chars()
        .zip(new.chars())
        .take_while(|(a, b)| a == b)
        .map(|(c, _)| c.len_utf8())
        .sum::<usize>();
    let suffix = old[prefix..]
        .chars()
        .rev()
        .zip(new[prefix..].chars().rev())
        .take_while(|(a, b)| a == b)
        .map(|(c, _)| c.len_utf8())
        .sum::<usize>();
    (
        old[..prefix].encode_utf16().count(),
        old[..old.len() - suffix].encode_utf16().count(),
        &new[prefix..new.len() - suffix],
    )
}

#[cfg(test)]
mod tests {
    use super::replacement;
    #[test]
    fn replacements_preserve_unicode_and_selection_offsets() {
        assert_eq!(replacement("a😀b", "a😁b"), (1, 3, "😁"));
        assert_eq!(replacement("café", "cafe"), (3, 4, "e"));
        assert_eq!(replacement("日本語", "日本"), (2, 3, ""));
        assert_eq!(
            replacement("hello world", "hello brave world"),
            (6, 6, "brave ")
        );
    }
}
