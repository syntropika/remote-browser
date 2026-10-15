use crate::{Error, VERSION, origin};
use base64::{Engine, prelude::BASE64_STANDARD};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

pub(crate) fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
#[derive(Clone, Deserialize)]
pub(crate) struct PublicKey {
    #[serde(rename = "Y")]
    pub encoded: String,
    pub expiry: String,
}
#[derive(Clone, Deserialize)]
pub(crate) struct Commitment {
    pub batchsize: usize,
    pub keys: BTreeMap<String, PublicKey>,
}
pub(crate) struct ValidKey {
    pub bytes: Vec<u8>,
    pub expires: u64,
}
pub(crate) struct IssuerKeys {
    #[cfg(feature = "boringssl")]
    pub batch_size: usize,
    pub keys: Vec<ValidKey>,
}
#[derive(Default)]
pub struct KeyRegistry(pub(crate) BTreeMap<String, Commitment>);
impl KeyRegistry {
    pub fn load(path: &Path) -> Result<Self, Error> {
        let raw: BTreeMap<String, BTreeMap<String, Commitment>> =
            serde_json::from_slice(&read_bounded(path, 2_097_152)?).map_err(|_| Error::Invalid)?;
        if raw.len() > 64 {
            return Err(Error::Capacity);
        }
        let mut result = BTreeMap::new();
        for (issuer, mut protocols) in raw {
            if origin(&issuer)? != issuer {
                return Err(Error::Invalid);
            }
            let Some(commitment) = protocols.remove(VERSION) else {
                continue;
            };
            if !(1..=100).contains(&commitment.batchsize)
                || commitment.keys.is_empty()
                || commitment.keys.len() > 6
            {
                return Err(Error::Invalid);
            }
            for (id, key) in &commitment.keys {
                let id = id.parse::<u32>().map_err(|_| Error::Invalid)?;
                let bytes = BASE64_STANDARD
                    .decode(&key.encoded)
                    .map_err(|_| Error::Invalid)?;
                if bytes.len() != 101
                    || bytes[..4] != id.to_be_bytes()
                    || key.expiry.parse::<u64>().is_err()
                {
                    return Err(Error::Invalid);
                }
            }
            result.insert(issuer, commitment);
        }
        Ok(Self(result))
    }
    pub(crate) fn keys(&self, issuer: &str) -> Result<IssuerKeys, Error> {
        let c = self.0.get(issuer).ok_or(Error::NoKey)?;
        let keys = c
            .keys
            .values()
            .filter_map(|key| {
                let expiry = key.expiry.parse::<u64>().ok()? / 1000;
                (expiry > now())
                    .then(|| {
                        BASE64_STANDARD
                            .decode(&key.encoded)
                            .ok()
                            .map(|bytes| ValidKey {
                                bytes,
                                expires: expiry,
                            })
                    })
                    .flatten()
            })
            .collect::<Vec<_>>();
        if keys.is_empty() {
            return Err(Error::NoKey);
        }
        Ok(IssuerKeys {
            #[cfg(feature = "boringssl")]
            batch_size: c.batchsize,
            keys,
        })
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Token {
    pub bytes: String,
    pub key: String,
    pub expires: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Record {
    pub value: String,
    pub key: String,
    pub expires: u64,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct State {
    pub tokens: BTreeMap<String, Vec<Token>>,
    pub records: BTreeMap<String, BTreeMap<String, Record>>,
    pub associations: BTreeMap<String, BTreeSet<String>>,
    pub redemptions: BTreeMap<String, BTreeMap<String, Vec<u64>>>,
}
#[derive(Default)]
pub(crate) struct Inner {
    pub state: State,
    #[cfg(feature = "boringssl")]
    pub busy: BTreeSet<String>,
}
pub struct Store {
    pub(crate) registry: KeyRegistry,
    path: PathBuf,
    pub(crate) inner: Mutex<Inner>,
}
fn read_bounded(path: &Path, max: u64) -> Result<Vec<u8>, Error> {
    if fs::symlink_metadata(path)
        .map_err(|_| Error::Storage)?
        .file_type()
        .is_symlink()
    {
        return Err(Error::Storage);
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| Error::Storage)?
        .take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Error::Storage)?;
    if bytes.len() as u64 > max {
        return Err(Error::Capacity);
    }
    Ok(bytes)
}
impl Store {
    pub fn open(profile: &Path, registry: KeyRegistry) -> Result<Self, Error> {
        let directory = profile.join("private-state-tokens");
        fs::create_dir_all(&directory).map_err(|_| Error::Storage)?;
        if fs::symlink_metadata(&directory)
            .map_err(|_| Error::Storage)?
            .file_type()
            .is_symlink()
        {
            return Err(Error::Storage);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
                .map_err(|_| Error::Storage)?;
        }
        let path = directory.join("state.json");
        let state: State = if path.exists() {
            serde_json::from_slice(&read_bounded(&path, 8_388_608)?).map_err(|_| Error::Storage)?
        } else {
            State::default()
        };
        if state.associations.len() > 1024
            || state.tokens.len() > 64
            || state.tokens.values().any(|v| v.len() > 500)
            || state.associations.values().any(|v| v.len() > 2)
        {
            return Err(Error::Capacity);
        }
        Ok(Self {
            registry,
            path,
            inner: Mutex::new(Inner {
                state,
                #[cfg(feature = "boringssl")]
                busy: BTreeSet::new(),
            }),
        })
    }
    pub(crate) fn persist(&self, state: &State) -> Result<(), Error> {
        let bytes = serde_json::to_vec(state).map_err(|_| Error::Storage)?;
        if bytes.len() > 8_388_608 {
            return Err(Error::Capacity);
        }
        let temp = self.path.with_extension("tmp");
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        // Only the owning engine process can access this private directory.
        if temp.exists() {
            fs::remove_file(&temp).map_err(|_| Error::Storage)?;
        }
        let mut file = options.open(&temp).map_err(|_| Error::Storage)?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| Error::Storage)?;
        fs::rename(&temp, &self.path).map_err(|_| Error::Storage)?;
        fs::File::open(self.path.parent().unwrap())
            .and_then(|file| file.sync_all())
            .map_err(|_| Error::Storage)
    }
    pub(crate) fn associate(state: &mut State, issuer: &str, top: &str) -> Result<(), Error> {
        if !state.associations.contains_key(top) && state.associations.len() >= 1024 {
            return Err(Error::Capacity);
        }
        let set = state.associations.entry(top.to_owned()).or_default();
        if !set.contains(issuer) && set.len() >= 2 {
            return Err(Error::Capacity);
        }
        set.insert(issuer.to_owned());
        Ok(())
    }
    pub(crate) fn valid_key(&self, issuer: &str, encoded: &str) -> bool {
        self.registry.keys(issuer).is_ok_and(|keys| {
            keys.keys
                .iter()
                .any(|key| key.expires > now() && BASE64_STANDARD.encode(&key.bytes) == encoded)
        })
    }
    pub(crate) fn record(&self, state: &State, issuer: &str, top: &str) -> Option<Record> {
        state
            .records
            .get(top)?
            .get(issuer)
            .filter(|r| r.expires > now() && self.valid_key(issuer, &r.key))
            .cloned()
    }
    pub fn query(&self, issuer: &str, top: &str, record: bool) -> Result<bool, Error> {
        let issuer = origin(issuer)?;
        let top = origin(top)?;
        let mut inner = self.inner.lock().map_err(|_| Error::Storage)?;
        let mut next = inner.state.clone();
        Self::associate(&mut next, &issuer, &top)?;
        let present = if record {
            self.record(&next, &issuer, &top).is_some()
        } else {
            if let Some(tokens) = next.tokens.get_mut(&issuer) {
                tokens.retain(|t| t.expires > now() && self.valid_key(&issuer, &t.key));
                !tokens.is_empty()
            } else {
                false
            }
        };
        self.persist(&next)?;
        inner.state = next;
        Ok(present)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Directory(PathBuf);
    impl Directory {
        fn new() -> Self {
            let name = format!(
                "pst-test-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            );
            let path = std::env::temp_dir().join(name);
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn registry(expiry: u64) -> KeyRegistry {
        let mut bytes = vec![0; 101];
        bytes[3] = 7;
        KeyRegistry(BTreeMap::from([(
            "https://issuer.example".into(),
            Commitment {
                batchsize: 2,
                keys: BTreeMap::from([(
                    "7".into(),
                    PublicKey {
                        encoded: BASE64_STANDARD.encode(bytes),
                        expiry: expiry.to_string(),
                    },
                )]),
            },
        )]))
    }
    #[test]
    fn only_trustworthy_http_origins_are_accepted() {
        for origin in [
            "https://example.com/path",
            "http://127.0.0.1:8123",
            "http://localhost",
            "http://[::1]",
        ] {
            assert!(crate::origin(origin).is_ok(), "{origin}");
        }
        for origin in [
            "http://example.com",
            "file:///test",
            "data:text/html,test",
            "https://user:password@example.com",
            "not an origin",
        ] {
            assert!(crate::origin(origin).is_err(), "{origin}");
        }
        assert_eq!(
            crate::origin("https://EXAMPLE.com:443/a?b").unwrap(),
            "https://example.com"
        );
    }
    #[test]
    fn association_limit_survives_restart_without_allocating_empty_token_issuers() {
        let directory = Directory::new();
        let store = Store::open(&directory.0, KeyRegistry::default()).unwrap();
        assert!(
            !store
                .query("https://a.example", "https://top.example", false)
                .unwrap()
        );
        assert!(
            !store
                .query("https://b.example", "https://top.example", false)
                .unwrap()
        );
        assert_eq!(
            store.query("https://c.example", "https://top.example", false),
            Err(Error::Capacity)
        );
        assert!(store.inner.lock().unwrap().state.tokens.is_empty());
        drop(store);
        let store = Store::open(&directory.0, KeyRegistry::default()).unwrap();
        assert_eq!(
            store.query("https://c.example", "https://top.example", false),
            Err(Error::Capacity)
        );
    }
    #[test]
    fn expired_and_removed_keys_invalidate_saved_state() {
        let directory = Directory::new();
        let valid = registry((now() + 60_000) * 1000);
        let encoded = valid.0["https://issuer.example"].keys["7"].encoded.clone();
        let store = Store::open(&directory.0, valid).unwrap();
        let mut state = State::default();
        state.tokens.insert(
            "https://issuer.example".into(),
            vec![Token {
                bytes: BASE64_STANDARD.encode(b"fixture"),
                key: encoded.clone(),
                expires: now() + 60_000,
            }],
        );
        state.records.insert(
            "https://top.example".into(),
            BTreeMap::from([(
                "https://issuer.example".into(),
                Record {
                    value: BASE64_STANDARD.encode(b"fixture"),
                    key: encoded,
                    expires: now() + 60_000,
                },
            )]),
        );
        store.persist(&state).unwrap();
        drop(store);
        let store = Store::open(&directory.0, registry((now() + 60_000) * 1000)).unwrap();
        assert!(
            store
                .query("https://issuer.example", "https://top.example", false)
                .unwrap()
        );
        assert!(
            store
                .query("https://issuer.example", "https://top.example", true)
                .unwrap()
        );
        drop(store);
        let store = Store::open(&directory.0, registry(0)).unwrap();
        assert!(
            !store
                .query("https://issuer.example", "https://top.example", false)
                .unwrap()
        );
        assert!(
            !store
                .query("https://issuer.example", "https://top.example", true)
                .unwrap()
        );
    }
    #[test]
    fn registry_rejects_malformed_keys_and_untrusted_issuers() {
        let directory = Directory::new();
        let path = directory.0.join("keys.json");
        for value in [
            r#"{"http://example.com":{"PrivateStateTokenV1VOPRF":{"batchsize":1,"keys":{}}}}"#,
            r#"{"https://example.com":{"PrivateStateTokenV1VOPRF":{"batchsize":1,"keys":{"7":{"Y":"AAAA","expiry":"1"}}}}}"#,
        ] {
            fs::write(&path, value).unwrap();
            assert!(KeyRegistry::load(&path).is_err());
        }
    }
    #[test]
    fn corrupted_state_fails_closed() {
        let directory = Directory::new();
        let store = Store::open(&directory.0, KeyRegistry::default()).unwrap();
        fs::write(&store.path, b"not valid json").unwrap();
        assert!(matches!(
            Store::open(&directory.0, KeyRegistry::default()),
            Err(Error::Storage)
        ));
    }
    #[cfg(unix)]
    #[test]
    fn symlinked_storage_is_rejected() {
        use std::os::unix::fs::symlink;
        let directory = Directory::new();
        let target = Directory::new();
        symlink(&target.0, directory.0.join("private-state-tokens")).unwrap();
        assert!(matches!(
            Store::open(&directory.0, KeyRegistry::default()),
            Err(Error::Storage)
        ));
    }
    #[cfg(feature = "boringssl")]
    #[test]
    fn aborted_redemption_never_restores_a_spent_token() {
        use crate::{Operation, Parameters};
        use std::sync::Arc;
        let directory = Directory::new();
        let keys = registry((now() + 60_000) * 1000);
        let key = keys.0["https://issuer.example"].keys["7"].encoded.clone();
        let store = Arc::new(Store::open(&directory.0, keys).unwrap());
        store.inner.lock().unwrap().state.tokens.insert(
            "https://issuer.example".into(),
            vec![Token {
                bytes: BASE64_STANDARD.encode(b"synthetic-token"),
                key,
                expires: now() + 60_000,
            }],
        );
        let params = Parameters {
            operation: Operation::TokenRedemption,
            refresh: true,
            issuers: vec![],
            top_level: "https://top.example".into(),
        };
        let mut headers = http::HeaderMap::new();
        let pending = crate::protocol::begin(
            store.clone(),
            "https://issuer.example/redeem",
            &params,
            &mut headers,
        )
        .unwrap();
        assert!(headers.contains_key(crate::TOKEN));
        assert!(
            !store
                .query("https://issuer.example", "https://top.example", false)
                .unwrap()
        );
        assert!(matches!(
            crate::protocol::begin(
                store.clone(),
                "https://issuer.example/redeem",
                &params,
                &mut http::HeaderMap::new()
            ),
            Err(Error::Busy)
        ));
        drop(pending);
        assert!(matches!(
            crate::protocol::begin(
                store.clone(),
                "https://issuer.example/redeem",
                &params,
                &mut http::HeaderMap::new()
            ),
            Err(Error::NoToken)
        ));
        drop(store);
        let reopened = Store::open(&directory.0, registry((now() + 60_000) * 1000)).unwrap();
        assert!(
            !reopened
                .query("https://issuer.example", "https://top.example", false)
                .unwrap()
        );
    }
}
