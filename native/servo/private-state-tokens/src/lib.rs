//! Experimental PST browser service. A process owns exactly one profile store.
//! Issuer commitments are provisioned by the embedder, never supplied by a page.
mod diagnostics;
mod store;
pub use diagnostics::{api_call, diagnostics};
#[cfg(feature = "boringssl")]
mod protocol;
use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    sync::{Arc, OnceLock},
};

#[cfg(feature = "boringssl")]
pub use protocol::Pending;
pub use store::{KeyRegistry, Store};

pub const VERSION: &str = "PrivateStateTokenV1VOPRF";
pub const TOKEN: &str = "sec-private-state-token";
pub const CRYPTO_VERSION: &str = "sec-private-state-token-crypto-version";
pub const LIFETIME: &str = "sec-private-state-token-lifetime";
pub const RECORD: &str = "sec-redemption-record";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Operation {
    TokenRequest,
    TokenRedemption,
    SendRedemptionRecord,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Parameters {
    pub operation: Operation,
    pub refresh: bool,
    pub issuers: Vec<String>,
    pub top_level: String,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Disabled,
    Invalid,
    Policy,
    Capacity,
    Busy,
    NoKey,
    NoToken,
    Crypto,
    Storage,
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Disabled => "Private State Tokens are disabled",
            Self::Invalid => "Invalid Private State Token parameters or response",
            Self::Policy => "Private State Token operation denied by policy",
            Self::Capacity => "Private State Token privacy or storage limit reached",
            Self::Busy => "Private State Token operation already in flight",
            Self::NoKey => "No valid registered issuer commitment",
            Self::NoToken => "No valid issuer token available",
            Self::Crypto => "Private State Token proof verification failed",
            Self::Storage => "Private State Token storage failed",
        })
    }
}
impl std::error::Error for Error {}
static STORE: OnceLock<Arc<Store>> = OnceLock::new();
pub fn install(profile: &Path, commitments: Option<&Path>) -> Result<(), Error> {
    if !cfg!(feature = "boringssl") {
        return Ok(());
    }
    let registry = match commitments {
        Some(path) => KeyRegistry::load(path)?,
        None => KeyRegistry::default(),
    };
    STORE
        .set(Arc::new(Store::open(profile, registry)?))
        .map_err(|_| Error::Busy)
}
pub fn enabled() -> bool {
    cfg!(feature = "boringssl") && STORE.get().is_some()
}
pub fn query(issuer: &str, top_level: &str, record: bool) -> Result<bool, Error> {
    STORE
        .get()
        .ok_or(Error::Disabled)?
        .query(issuer, top_level, record)
}
pub fn origin(value: &str) -> Result<String, Error> {
    let url = url::Url::parse(value).map_err(|_| Error::Invalid)?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(Error::Invalid);
    }
    let local = match url.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        Some(url::Host::Domain(host)) => host == "localhost" || host.ends_with(".localhost"),
        None => false,
    };
    if url.scheme() != "https" && !(url.scheme() == "http" && local) {
        return Err(Error::Policy);
    }
    Ok(url.origin().ascii_serialization())
}
#[cfg(feature = "boringssl")]
pub fn begin(
    url: &str,
    params: &Parameters,
    headers: &mut http::HeaderMap,
) -> Result<Pending, Error> {
    diagnostics::fetch();
    let result = protocol::begin(
        STORE.get().ok_or(Error::Disabled)?.clone(),
        url,
        params,
        headers,
    );
    if result.is_err() {
        diagnostics::outcome(false);
    }
    result
}
#[cfg(not(feature = "boringssl"))]
pub struct Pending;
#[cfg(not(feature = "boringssl"))]
pub fn begin(_: &str, _: &Parameters, _: &mut http::HeaderMap) -> Result<Pending, Error> {
    Err(Error::Disabled)
}
#[cfg(not(feature = "boringssl"))]
impl Pending {
    pub fn finish(self, _: u16, _: &mut http::HeaderMap) -> Result<(), Error> {
        Err(Error::Disabled)
    }
}
