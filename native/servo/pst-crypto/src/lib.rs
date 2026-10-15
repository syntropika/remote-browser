//! Small, ownership-safe interface to pinned BoringSSL PST V1 VOPRF.
//! No issuer private keys, web policy, storage or networking live in this crate.
use std::{ffi::c_void, ptr::NonNull};

unsafe extern "C" {
    fn servo_pst_new(batch: usize) -> *mut c_void;
    fn servo_pst_drop(client: *mut c_void);
    fn servo_pst_free(data: *mut u8);
    fn servo_pst_add_key(client: *mut c_void, key: *const u8, len: usize, index: *mut usize)
    -> i32;
    fn servo_pst_begin(
        client: *mut c_void,
        count: usize,
        out: *mut *mut u8,
        len: *mut usize,
    ) -> i32;
    fn servo_pst_finish(
        client: *mut c_void,
        response: *const u8,
        response_len: usize,
        out: *mut *mut u8,
        len: *mut usize,
        key_index: *mut usize,
    ) -> i32;
    fn servo_pst_redeem(
        token: *const u8,
        token_len: usize,
        data: *const u8,
        data_len: usize,
        out: *mut *mut u8,
        len: *mut usize,
    ) -> i32;
}

#[derive(Debug, Clone, Copy)]
pub struct CryptoError;
impl std::fmt::Display for CryptoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Private State Token cryptographic operation failed")
    }
}
impl std::error::Error for CryptoError {}

struct Buffer(*mut u8, usize);
impl Buffer {
    fn new() -> Self {
        Self(std::ptr::null_mut(), 0)
    }
    fn copy(&self, success: i32) -> Result<Vec<u8>, CryptoError> {
        if success != 1 || self.0.is_null() || self.1 == 0 || self.1 > 1_048_576 {
            return Err(CryptoError);
        }
        // SAFETY: the bridge returns an allocation of exactly this length, owned by Buffer.
        Ok(unsafe { std::slice::from_raw_parts(self.0, self.1) }.to_vec())
    }
}
impl Drop for Buffer {
    fn drop(&mut self) {
        // SAFETY: bridge outputs use OPENSSL allocation; free accepts null.
        unsafe { servo_pst_free(self.0) };
    }
}

/// Exclusive ownership of an in-flight issuance. It cannot be cloned or shared.
pub struct Issuance(NonNull<c_void>);
// SAFETY: BoringSSL contexts have no thread affinity and are exclusively owned.
// All mutations require &mut self; no Sync implementation is provided.
unsafe impl Send for Issuance {}
impl Drop for Issuance {
    fn drop(&mut self) {
        // SAFETY: constructed by servo_pst_new and uniquely owned until this drop.
        unsafe { servo_pst_drop(self.0.as_ptr()) };
    }
}
impl Issuance {
    pub fn new(keys: &[Vec<u8>], count: usize) -> Result<(Self, Vec<u8>), CryptoError> {
        if keys.is_empty() || keys.len() > 6 || !(1..=100).contains(&count) {
            return Err(CryptoError);
        }
        // SAFETY: no pointer inputs; bounded batch size.
        let client = Self(NonNull::new(unsafe { servo_pst_new(count) }).ok_or(CryptoError)?);
        for (expected, key) in keys.iter().enumerate() {
            let mut index = usize::MAX;
            // SAFETY: valid borrowed slice and writable index, context is exclusively owned.
            let ok = unsafe {
                servo_pst_add_key(client.0.as_ptr(), key.as_ptr(), key.len(), &mut index)
            };
            if ok != 1 || index != expected {
                return Err(CryptoError);
            }
        }
        let mut buffer = Buffer::new();
        // SAFETY: context and output pointers are valid; buffer owns the returned allocation.
        let ok = unsafe { servo_pst_begin(client.0.as_ptr(), count, &mut buffer.0, &mut buffer.1) };
        Ok((client, buffer.copy(ok)?))
    }
    pub fn finish(mut self, response: &[u8]) -> Result<(usize, Vec<Vec<u8>>), CryptoError> {
        self.finish_inner(response)
    }
    fn finish_inner(&mut self, response: &[u8]) -> Result<(usize, Vec<Vec<u8>>), CryptoError> {
        if response.len() > 1_048_576 {
            return Err(CryptoError);
        }
        let mut buffer = Buffer::new();
        let mut index = usize::MAX;
        // SAFETY: valid input slice; all output pointers are writable and uniquely owned.
        let ok = unsafe {
            servo_pst_finish(
                self.0.as_ptr(),
                response.as_ptr(),
                response.len(),
                &mut buffer.0,
                &mut buffer.1,
                &mut index,
            )
        };
        let bytes = buffer.copy(ok)?;
        let mut cursor = bytes.as_slice();
        let mut tokens = Vec::new();
        while !cursor.is_empty() {
            let size = cursor.get(..2).ok_or(CryptoError)?;
            let len = u16::from_be_bytes([size[0], size[1]]) as usize;
            let token = cursor.get(2..2 + len).ok_or(CryptoError)?;
            if token.is_empty() || tokens.len() >= 100 {
                return Err(CryptoError);
            }
            tokens.push(token.to_vec());
            cursor = &cursor[2 + len..];
        }
        Ok((index, tokens))
    }
}
pub fn redeem(token: &[u8], client_data: &[u8]) -> Result<Vec<u8>, CryptoError> {
    if token.is_empty() || token.len() > 65535 || client_data.len() > 65535 {
        return Err(CryptoError);
    }
    let mut buffer = Buffer::new();
    // SAFETY: valid immutable slices and writable owned output pointers.
    let ok = unsafe {
        servo_pst_redeem(
            token.as_ptr(),
            token.len(),
            client_data.as_ptr(),
            client_data.len(),
            &mut buffer.0,
            &mut buffer.1,
        )
    };
    buffer.copy(ok)
}
