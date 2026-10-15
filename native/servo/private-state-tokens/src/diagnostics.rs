//! Aggregate counters only: no origins, keys, tokens, records or URLs.
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
static API: AtomicU64 = AtomicU64::new(0);
static FETCH: AtomicU64 = AtomicU64::new(0);
static SUCCESS: AtomicU64 = AtomicU64::new(0);
static FAILURE: AtomicU64 = AtomicU64::new(0);
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    enabled: bool,
    api_calls: u64,
    fetch_operations: u64,
    successful_exchanges: u64,
    failed_exchanges: u64,
}
pub fn api_call() {
    API.fetch_add(1, Relaxed);
}
#[cfg(feature = "boringssl")]
pub(crate) fn fetch() {
    FETCH.fetch_add(1, Relaxed);
}
#[cfg(feature = "boringssl")]
pub(crate) fn outcome(success: bool) {
    if success { &SUCCESS } else { &FAILURE }.fetch_add(1, Relaxed);
}
pub fn diagnostics() -> Diagnostics {
    Diagnostics {
        enabled: crate::enabled(),
        api_calls: API.load(Relaxed),
        fetch_operations: FETCH.load(Relaxed),
        successful_exchanges: SUCCESS.load(Relaxed),
        failed_exchanges: FAILURE.load(Relaxed),
    }
}
