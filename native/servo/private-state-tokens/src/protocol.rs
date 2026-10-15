use crate::{
    CRYPTO_VERSION, Error, LIFETIME, Operation, Parameters, RECORD, Store, TOKEN, VERSION, origin,
    store::{Record, Token, ValidKey, now},
};
use base64::{Engine, prelude::BASE64_STANDARD};
use http::{HeaderMap, HeaderValue};
use servo_pst_crypto::Issuance;
use std::sync::Arc;

enum Exchange {
    Issuance {
        client: Issuance,
        keys: Vec<ValidKey>,
        count: usize,
    },
    Redemption {
        key: String,
        expires: u64,
    },
    Send,
}
pub struct Pending {
    store: Arc<Store>,
    issuer: String,
    top: String,
    exchange: Exchange,
    locked: bool,
}
impl Drop for Pending {
    fn drop(&mut self) {
        if self.locked
            && let Ok(mut inner) = self.store.inner.lock()
        {
            inner.busy.remove(&self.issuer);
        }
    }
}
fn set(headers: &mut HeaderMap, name: &'static str, value: &str) -> Result<(), Error> {
    headers.insert(
        name,
        HeaderValue::from_str(value).map_err(|_| Error::Invalid)?,
    );
    Ok(())
}
fn cbor_head(out: &mut Vec<u8>, major: u8, value: u64) {
    let prefix = major << 5;
    match value {
        0..=23 => out.push(prefix | value as u8),
        24..=255 => out.extend([prefix | 24, value as u8]),
        256..=65535 => {
            out.push(prefix | 25);
            out.extend((value as u16).to_be_bytes());
        }
        65536..=4294967295 => {
            out.push(prefix | 26);
            out.extend((value as u32).to_be_bytes());
        }
        _ => {
            out.push(prefix | 27);
            out.extend(value.to_be_bytes());
        }
    }
}
fn cbor_text(out: &mut Vec<u8>, text: &str) {
    cbor_head(out, 3, text.len() as u64);
    out.extend(text.as_bytes());
}
fn client_data(top: &str) -> Vec<u8> {
    // Canonical CBOR map, ordered by encoded key length, as used by Chromium.
    let mut out = vec![0xa2];
    cbor_text(&mut out, "redeeming-origin");
    cbor_text(&mut out, top);
    cbor_text(&mut out, "redemption-timestamp");
    cbor_head(&mut out, 0, now() / 1000);
    out
}
pub(crate) fn begin(
    store: Arc<Store>,
    url: &str,
    params: &Parameters,
    headers: &mut HeaderMap,
) -> Result<Pending, Error> {
    let issuer = origin(url)?;
    let top = origin(&params.top_level)?;
    // Browser-generated fields must never be accepted from script or inherited requests.
    for name in [TOKEN, CRYPTO_VERSION, LIFETIME, RECORD] {
        headers.remove(name);
    }
    if params.issuers.len() > 2 {
        return Err(Error::Capacity);
    }
    let mut inner = store.inner.lock().map_err(|_| Error::Storage)?;
    let mut state = inner.state.clone();
    if params.operation == Operation::SendRedemptionRecord {
        let mut items = std::collections::BTreeMap::new();
        for item in &params.issuers {
            let item = origin(item)?;
            if let Some(record) = store.record(&state, &item, &top) {
                items.insert(item, record);
            }
        }
        let value = items
            .into_iter()
            .map(|(issuer, record)| format!("\"{issuer}\";redemption-record=\"{}\"", record.value))
            .collect::<Vec<_>>()
            .join(", ");
        set(headers, RECORD, &value)?;
        set(headers, CRYPTO_VERSION, VERSION)?;
        drop(inner);
        return Ok(Pending {
            store,
            issuer,
            top,
            exchange: Exchange::Send,
            locked: false,
        });
    }
    Store::associate(&mut state, &issuer, &top)?;
    if inner.busy.contains(&issuer) {
        return Err(Error::Busy);
    }
    let commitment = store.registry.keys(&issuer)?;
    let batch = commitment.batch_size;
    let keys = commitment.keys;
    if !state.tokens.contains_key(&issuer) && state.tokens.len() >= 64 {
        return Err(Error::Capacity);
    }
    let tokens = state.tokens.entry(issuer.clone()).or_default();
    tokens.retain(|t| t.expires > now() && store.valid_key(&issuer, &t.key));
    let (exchange, request) = match params.operation {
        Operation::TokenRequest => {
            let count = batch.min(500_usize.saturating_sub(tokens.len()));
            if count == 0 {
                return Err(Error::Capacity);
            }
            let public = keys.iter().map(|key| key.bytes.clone()).collect::<Vec<_>>();
            let (client, request) = Issuance::new(&public, count).map_err(|_| Error::Crypto)?;
            (
                Exchange::Issuance {
                    client,
                    keys,
                    count,
                },
                request,
            )
        }
        Operation::TokenRedemption => {
            // A cached redemption is a no-network result, not another token spend.
            if !params.refresh && store.record(&state, &issuer, &top).is_some() {
                return Err(Error::Busy);
            }
            let times = state
                .redemptions
                .entry(top.clone())
                .or_default()
                .entry(issuer.clone())
                .or_default();
            if times.len() >= 2 && now().saturating_sub(times[0]) < 48 * 60 * 60 * 1000 {
                return Err(Error::Capacity);
            }
            let token = state
                .tokens
                .get_mut(&issuer)
                .and_then(Vec::pop)
                .ok_or(Error::NoToken)?;
            let bytes = BASE64_STANDARD
                .decode(&token.bytes)
                .map_err(|_| Error::Storage)?;
            let request =
                servo_pst_crypto::redeem(&bytes, &client_data(&top)).map_err(|_| Error::Crypto)?;
            times.push(now());
            if times.len() > 2 {
                times.remove(0);
            }
            (
                Exchange::Redemption {
                    key: token.key,
                    expires: token.expires,
                },
                request,
            )
        }
        Operation::SendRedemptionRecord => unreachable!(),
    };
    // Consumption is durable before any bytes can be sent. Failed/aborted exchanges do not restore tokens.
    store.persist(&state)?;
    inner.state = state;
    set(headers, TOKEN, &BASE64_STANDARD.encode(request))?;
    set(headers, CRYPTO_VERSION, VERSION)?;
    inner.busy.insert(issuer.clone());
    drop(inner);
    Ok(Pending {
        store,
        issuer,
        top,
        exchange,
        locked: true,
    })
}
impl Pending {
    pub fn finish(self, status: u16, headers: &mut HeaderMap) -> Result<(), Error> {
        let result = self.finish_inner(status, headers);
        crate::diagnostics::outcome(result.is_ok());
        result
    }
    fn finish_inner(mut self, status: u16, headers: &mut HeaderMap) -> Result<(), Error> {
        let raw = headers.remove(TOKEN);
        let lifetime = headers.remove(LIFETIME);
        headers.remove(CRYPTO_VERSION);
        // Sending an existing record must preserve ordinary HTTP response statuses.
        if matches!(self.exchange, Exchange::Send) {
            return Ok(());
        }
        if !(200..300).contains(&status) {
            return Err(Error::Invalid);
        }
        let response = raw.ok_or(Error::Invalid)?;
        let response = response.to_str().map_err(|_| Error::Invalid)?;
        if response.len() > 1_048_576 {
            return Err(Error::Invalid);
        }
        let decoded = BASE64_STANDARD
            .decode(response)
            .map_err(|_| Error::Invalid)?;
        if decoded.is_empty() {
            return Err(Error::Invalid);
        }
        let mut inner = self.store.inner.lock().map_err(|_| Error::Storage)?;
        let mut next = inner.state.clone();
        let exchange = std::mem::replace(&mut self.exchange, Exchange::Send);
        match exchange {
            Exchange::Issuance {
                client,
                keys,
                count,
            } => {
                let (index, tokens) = client.finish(&decoded).map_err(|_| Error::Crypto)?;
                let key = keys.get(index).ok_or(Error::Crypto)?;
                if tokens.len() > count || key.expires <= now() {
                    return Err(Error::Crypto);
                }
                let stored = next.tokens.entry(self.issuer.clone()).or_default();
                for bytes in tokens {
                    stored.push(Token {
                        bytes: BASE64_STANDARD.encode(bytes),
                        key: BASE64_STANDARD.encode(&key.bytes),
                        expires: key.expires,
                    });
                }
                if stored.len() > 500 {
                    return Err(Error::Capacity);
                }
            }
            Exchange::Redemption { key, expires } => {
                // PST V1 RR is an opaque issuer blob. Its consumer verifies its meaning/signature.
                // BoringSSL's PST finish-redemption is deliberately a passthrough for this version.
                let lifetime = match lifetime {
                    Some(value) => value
                        .to_str()
                        .ok()
                        .and_then(|s| s.parse::<u64>().ok())
                        .ok_or(Error::Invalid)?,
                    None => 24 * 60 * 60,
                };
                let expires = expires.min(now().saturating_add(lifetime.saturating_mul(1000)));
                if expires > now() {
                    next.records.entry(self.top.clone()).or_default().insert(
                        self.issuer.clone(),
                        Record {
                            value: BASE64_STANDARD.encode(decoded),
                            key,
                            expires,
                        },
                    );
                } else if let Some(records) = next.records.get_mut(&self.top) {
                    records.remove(&self.issuer);
                }
            }
            Exchange::Send => unreachable!(),
        }
        self.store.persist(&next)?;
        inner.state = next;
        Ok(())
    }
}
