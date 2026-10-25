//! Optional, versioned bridge to the native CEF installation prompt.
//!
//! Only a CEF build carrying `cef/install_bridge` exports these functions. Loading a
//! stock CEF library leaves the bridge unavailable; it never substitutes a test hook.
use libloading::Library;
use serde::Deserialize;
use std::ffi::{CString, c_char, c_int};
use std::marker::PhantomData;
use std::rc::Rc;

type Enable = unsafe extern "C" fn() -> c_int;
type Poll = unsafe extern "C" fn(*mut c_char, usize) -> usize;
type Resolve = unsafe extern "C" fn(*const c_char, c_int, c_int) -> c_int;
type Cancel = unsafe extern "C" fn(c_int);
const MAX_RESPONSE: usize = 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum InstallError {
    InvalidResponse,
    Changed,
    InvalidId,
    Stale,
}

impl std::fmt::Display for InstallError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::InvalidResponse => "The extension installer returned an invalid response",
            Self::Changed => "The extension installation requests changed; try again",
            Self::InvalidId => "Invalid extension installation request",
            Self::Stale => "This extension installation request has expired or changed",
        })
    }
}

impl std::error::Error for InstallError {}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Pending {
    pub id: String,
    pub browser_id: i32,
    pub extension_id: String,
    pub name: String,
    pub version: String,
    pub origin: String,
    pub permissions: Vec<String>,
    pub seconds_remaining: u64,
}

pub(crate) struct InstallBridge {
    // Function pointers may only be called while this library is retained.
    _library: Library,
    poll: Poll,
    resolve: Resolve,
    cancel: Cancel,
    // Native requests and callbacks belong to the initializing CEF UI thread.
    _thread: PhantomData<Rc<()>>,
}

impl InstallBridge {
    /// Enables the bridge on CEF's UI thread, after initialization. All calls to this
    /// object must remain on that thread and precede CEF shutdown.
    pub(crate) fn discover() -> Option<Self> {
        #[cfg(target_os = "linux")]
        let path = std::env::current_exe().ok()?.parent()?.join("libcef.so");
        #[cfg(not(target_os = "linux"))]
        return None;
        #[cfg(target_os = "linux")]
        // SAFETY: This is the CEF library already loaded by this engine, located beside
        // the executable. Only the pinned v1 C ABI is used; no internal symbols or data
        // offsets are inspected. The library outlives every function pointer below.
        unsafe {
            let library = Library::new(path).ok()?;
            let enable = *library
                .get::<Enable>(b"rb_extension_install_enable_v1\0")
                .ok()?;
            let poll = *library
                .get::<Poll>(b"rb_extension_install_poll_v1\0")
                .ok()?;
            let resolve = *library
                .get::<Resolve>(b"rb_extension_install_resolve_v1\0")
                .ok()?;
            let cancel = *library
                .get::<Cancel>(b"rb_extension_install_cancel_v1\0")
                .ok()?;
            if enable() != 1 {
                return None;
            }
            Some(Self {
                _library: library,
                poll,
                resolve,
                cancel,
                _thread: PhantomData,
            })
        }
    }

    /// Reads pending native prompts. A failed read does not resolve any decision.
    pub(crate) fn pending(&self) -> Result<Vec<Pending>, InstallError> {
        // SAFETY: The v1 poll contract permits a null buffer for the size query.
        let length = unsafe { (self.poll)(std::ptr::null_mut(), 0) };
        if length == 0 || length > MAX_RESPONSE {
            return Err(InstallError::InvalidResponse);
        }
        let mut data = vec![0u8; length];
        // SAFETY: `data` is writable for the advertised capacity. Native poll does not
        // retain it, and never writes when its response exceeds that capacity.
        let written = unsafe { (self.poll)(data.as_mut_ptr().cast(), data.len()) };
        if written == 0 || written > data.len() {
            return Err(InstallError::Changed);
        }
        serde_json::from_slice(&data[..written]).map_err(|_| InstallError::InvalidResponse)
    }

    /// Resolves a pending prompt once. Native CEF verifies the browser and page
    /// lifetime before consuming the decision. Success authorizes or refuses the
    /// installation; it does not establish that download or installation succeeded.
    pub(crate) fn decide(&self, id: &str, browser: i32, allow: bool) -> Result<(), InstallError> {
        let id = CString::new(id).map_err(|_| InstallError::InvalidId)?;
        // SAFETY: The id is NUL terminated and borrowed only for this synchronous call.
        // All native validation, callback ownership and expiration remain inside CEF.
        match unsafe { (self.resolve)(id.as_ptr(), browser, i32::from(allow)) } {
            1 => Ok(()),
            _ => Err(InstallError::Stale),
        }
    }

    /// Aborts unresolved decisions for a browser; zero aborts all decisions. This
    /// does not undo an installation whose decision has already been consumed.
    pub(crate) fn cancel(&self, browser: i32) {
        // SAFETY: Called on CEF's UI thread before closing a browser or CEF itself.
        unsafe { (self.cancel)(browser) }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    const RESPONSE: &[u8] = br#"[{"id":"opaque-token","browserId":7,"extensionId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","name":"Example","version":"1.0","origin":"https://chromewebstore.google.com","permissions":["Read example.test"],"secondsRemaining":120}]"#;
    static CONSUMED: AtomicBool = AtomicBool::new(false);

    unsafe extern "C" fn poll(data: *mut c_char, capacity: usize) -> usize {
        if !data.is_null() && capacity >= RESPONSE.len() {
            // SAFETY: The caller promises a writable buffer of `capacity` bytes.
            unsafe {
                std::ptr::copy_nonoverlapping(RESPONSE.as_ptr(), data.cast(), RESPONSE.len())
            };
        }
        RESPONSE.len()
    }

    unsafe extern "C" fn resolve(id: *const c_char, browser: c_int, allow: c_int) -> c_int {
        // SAFETY: The bridge passes a borrowed NUL-terminated CString.
        let id = unsafe { std::ffi::CStr::from_ptr(id) };
        i32::from(
            id.to_bytes() == b"opaque-token"
                && browser == 7
                && allow == 1
                && !CONSUMED.swap(true, Ordering::SeqCst),
        )
    }

    unsafe extern "C" fn cancel(_browser: c_int) {}

    fn bridge(poll: Poll) -> InstallBridge {
        InstallBridge {
            _library: libloading::os::unix::Library::this().into(),
            poll,
            resolve,
            cancel,
            _thread: PhantomData,
        }
    }

    #[test]
    fn native_abi_carries_identity_and_reports_consumed_or_invalid_decisions() {
        let bridge = bridge(poll);
        let pending = bridge.pending().unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].browser_id, 7);
        assert_eq!(pending[0].permissions, ["Read example.test"]);
        assert_eq!(
            bridge.decide("opaque-token", 8, true),
            Err(InstallError::Stale)
        );
        assert_eq!(
            bridge.decide("opaque\0token", 7, true),
            Err(InstallError::InvalidId)
        );
        assert_eq!(bridge.decide("opaque-token", 7, true), Ok(()));
        assert_eq!(
            bridge.decide("opaque-token", 7, true),
            Err(InstallError::Stale)
        );
    }

    #[test]
    fn changing_or_oversized_native_buffers_are_refused_before_decoding() {
        unsafe extern "C" fn oversized(_data: *mut c_char, _capacity: usize) -> usize {
            MAX_RESPONSE + 1
        }
        unsafe extern "C" fn changed(data: *mut c_char, _capacity: usize) -> usize {
            if data.is_null() { 2 } else { 1024 }
        }
        assert!(matches!(
            bridge(oversized).pending(),
            Err(InstallError::InvalidResponse)
        ));
        assert!(matches!(
            bridge(changed).pending(),
            Err(InstallError::Changed)
        ));
    }
}
