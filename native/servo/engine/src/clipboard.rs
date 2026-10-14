//! Profile-scoped text clipboard shared with Servo's native editing commands.
use servo::{ClipboardDelegate, StringRequest, WebView};
use std::cell::RefCell;
#[derive(Default)]
pub struct Clipboard(RefCell<String>);
impl Clipboard {
    pub fn text(&self) -> String {
        self.0.borrow().clone()
    }
    pub fn write(&self, value: &str) -> Result<(), String> {
        if value.len() > 8192 {
            return Err("Clipboard text exceeds 8192 bytes".into());
        }
        *self.0.borrow_mut() = value.into();
        Ok(())
    }
}
impl ClipboardDelegate for Clipboard {
    fn clear(&self, _: WebView) {
        self.0.borrow_mut().clear();
    }
    fn get_text(&self, _: WebView, request: StringRequest) {
        request.success(self.text());
    }
    fn set_text(&self, _: WebView, text: String) {
        let _ = self.write(&text);
    }
}
