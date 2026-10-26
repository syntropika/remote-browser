//! Optional native extension inventory and user-requested management.
use libloading::Library;
use serde_json::Value;
use std::ffi::{CString, c_char, c_int};
use std::marker::PhantomData;
use std::rc::Rc;

const CAPACITY: usize = 1024 * 1024;
type Manage = unsafe extern "C" fn(c_int, *const c_char, *mut c_char, usize) -> usize;

pub(crate) struct Manager {
    _library: Library,
    manage: Manage,
    _thread: PhantomData<Rc<()>>,
}

impl Manager {
    pub(crate) fn discover() -> Option<Self> {
        #[cfg(not(target_os = "linux"))]
        return None;
        #[cfg(target_os = "linux")]
        {
            let path = std::env::current_exe().ok()?.parent()?.join("libcef.so");
            // SAFETY: This loads the engine's already-linked adjacent CEF library. Only
            // the independent v1 ABI is used, on CEF's initializing UI thread.
            unsafe {
                let library = Library::new(path).ok()?;
                let manage = *library.get::<Manage>(b"rb_extensions_manage_v1\0").ok()?;
                Some(Self {
                    _library: library,
                    manage,
                    _thread: PhantomData,
                })
            }
        }
    }

    pub(crate) fn request(&self, browser: i32, request: Value) -> Result<Value, String> {
        let request = serde_json::to_string(&request).map_err(|error| error.to_string())?;
        if request.len() > 4096 {
            return Err("The extension request is too large".into());
        }
        let request = CString::new(request).map_err(|error| error.to_string())?;
        let mut data = vec![0u8; CAPACITY];
        // SAFETY: Both buffers are valid for the call and the library outlives the
        // function pointer. A mutation is executed exactly once, without a size query.
        let written = unsafe {
            (self.manage)(
                browser,
                request.as_ptr(),
                data.as_mut_ptr().cast(),
                data.len(),
            )
        };
        if written == 0 || written > data.len() {
            return Err("The extension manager returned an invalid response".into());
        }
        let result: Value = serde_json::from_slice(&data[..written])
            .map_err(|_| "The extension manager returned invalid JSON".to_string())?;
        if let Some(error) = result.get("error").and_then(Value::as_str) {
            return Err(error.to_string());
        }
        Ok(result)
    }
}
