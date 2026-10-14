//! Persistent, owner-managed bearer keys compatible with the original registry.
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
use subtle::ConstantTimeEq;
use unicode_categories::UnicodeCategories;
use unicode_normalization::UnicodeNormalization;

#[derive(Debug)]
pub struct KeyError(pub u16, pub &'static str);
pub type Result<T> = std::result::Result<T, KeyError>;
fn parent(path: &Path) -> &Path {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."))
}
fn unavailable() -> KeyError {
    KeyError(503, "API keys are unavailable. Contact the administrator.")
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Key {
    id: String,
    name: String,
    prefix: String,
    created_at: String,
    last_used_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    legacy: Option<bool>,
    hash: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Registry {
    version: u8,
    keys: Vec<Key>,
}
pub struct ApiKeys {
    path: PathBuf,
    record: Mutex<Registry>,
}
fn name(value: &str) -> Option<String> {
    if value
        .chars()
        .any(|c| c.is_other_control() || c.is_other_format())
    {
        return None;
    }
    let text: String = value.trim().nfc().collect();
    (1..=64)
        .contains(&text.encode_utf16().count())
        .then_some(text)
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn hash(secret: &str) -> String {
    hex(&Sha256::digest(secret.as_bytes()))
}
fn now() -> String {
    DateTime::<Utc>::from(std::time::SystemTime::now()).to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn date(value: &str) -> bool {
    DateTime::parse_from_rfc3339(value).is_ok_and(|date| {
        date.with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Millis, true)
            == value
    })
}
fn valid_hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn metadata(key: &Key) -> Value {
    let mut value = json!({"id":key.id,"name":key.name,"prefix":key.prefix,"createdAt":key.created_at,"lastUsedAt":key.last_used_at});
    if key.legacy == Some(true) {
        value["legacy"] = json!(true);
    }
    value
}
fn read(path: &Path) -> Result<Registry> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path).map_err(|_| unavailable())?;
    let meta = file.metadata().map_err(|_| unavailable())?;
    if !meta.is_file() || meta.len() > 128 * 1024 {
        return Err(unavailable());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o077 != 0 {
            return Err(unavailable());
        }
    }
    let mut bytes = Vec::new();
    file.take(128 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| unavailable())?;
    if bytes.len() > 128 * 1024 {
        return Err(unavailable());
    }
    let registry: Registry = serde_json::from_slice(&bytes).map_err(|_| unavailable())?;
    let mut ids = HashSet::new();
    let mut hashes = HashSet::new();
    if registry.version != 1 || registry.keys.len() > 100 {
        return Err(unavailable());
    }
    for key in &registry.keys {
        let prefix = if key.legacy == Some(true) {
            key.prefix == "legacy"
        } else {
            key.legacy.is_none()
                && key.prefix.len() == 11
                && key.prefix.starts_with("rb_")
                && key.prefix[3..]
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        };
        if !valid_hex(&key.id, 32)
            || !valid_hex(&key.hash, 64)
            || name(&key.name).as_deref() != Some(&key.name)
            || !prefix
            || !date(&key.created_at)
            || !key.last_used_at.as_ref().is_none_or(|v| date(v))
            || !ids.insert(&key.id)
            || !hashes.insert(&key.hash)
        {
            return Err(unavailable());
        }
    }
    Ok(registry)
}
impl ApiKeys {
    pub fn new(path: PathBuf, legacy: Option<String>) -> Result<Self> {
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(parent(&path)).map_err(|_| unavailable())?;
        let record = match fs::symlink_metadata(&path) {
            Ok(_) => read(&path)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let mut record = Registry {
                    version: 1,
                    keys: Vec::new(),
                };
                if let Some(secret) = legacy {
                    if !(32..=4096).contains(&secret.len()) {
                        return Err(unavailable());
                    }
                    record.keys.push(Key {
                        id: uuid::Uuid::new_v4().simple().to_string(),
                        name: "Initial key".into(),
                        prefix: "legacy".into(),
                        created_at: now(),
                        last_used_at: None,
                        legacy: Some(true),
                        hash: hash(&secret),
                    });
                }
                let store = Self {
                    path: path.clone(),
                    record: Mutex::new(record.clone()),
                };
                match store.commit(&record, true) {
                    Ok(()) => record,
                    Err(_) if path.exists() => read(&path)?,
                    Err(error) => return Err(error),
                }
            }
            Err(_) => return Err(unavailable()),
        };
        Ok(Self {
            path,
            record: Mutex::new(record),
        })
    }
    fn commit(&self, record: &Registry, initial: bool) -> Result<()> {
        let parent = parent(&self.path);
        let temporary = parent.join(format!(".api-keys-{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temporary).map_err(|_| unavailable())?;
            file.write_all(&serde_json::to_vec(record).map_err(|_| unavailable())?)
                .and_then(|_| file.sync_all())
                .map_err(|_| unavailable())?;
            if initial {
                fs::hard_link(&temporary, &self.path).map_err(|_| unavailable())?;
            } else {
                read(&self.path)?;
                fs::rename(&temporary, &self.path).map_err(|_| unavailable())?;
            }
            #[cfg(unix)]
            {
                fs::File::open(parent)
                    .and_then(|directory| directory.sync_all())
                    .map_err(|_| unavailable())?;
            }
            Ok(())
        })();
        let _ = fs::remove_file(temporary);
        result
    }
    pub fn list(&self) -> Result<Vec<Value>> {
        let mut record = self.record.lock().map_err(|_| unavailable())?;
        *record = read(&self.path)?;
        Ok(record.keys.iter().map(metadata).collect())
    }
    pub fn create(
        &self,
        value: &str,
        before_mutation: impl FnOnce() -> Result<()>,
    ) -> Result<Value> {
        let name = name(value).ok_or(KeyError(
            400,
            "Use a key name with 1 to 64 characters and no control characters.",
        ))?;
        let mut current = self.record.lock().map_err(|_| unavailable())?;
        let mut record = read(&self.path)?;
        if record.keys.len() >= 100 {
            return Err(KeyError(
                409,
                "Revoke an existing key before creating another.",
            ));
        }
        let mut bytes = [0; 32];
        getrandom::fill(&mut bytes).map_err(|_| unavailable())?;
        let secret = format!("rb_{}", URL_SAFE_NO_PAD.encode(bytes));
        let key = Key {
            id: uuid::Uuid::new_v4().simple().to_string(),
            name,
            prefix: secret[..11].into(),
            created_at: now(),
            last_used_at: None,
            legacy: None,
            hash: hash(&secret),
        };
        let result = json!({"key":metadata(&key),"secret":secret});
        record.keys.push(key);
        before_mutation()?;
        self.commit(&record, false)?;
        *current = record;
        Ok(result)
    }
    pub fn revoke(&self, id: &str, before_mutation: impl FnOnce() -> Result<()>) -> Result<()> {
        let mut current = self.record.lock().map_err(|_| unavailable())?;
        let mut record = read(&self.path)?;
        let count = record.keys.len();
        record.keys.retain(|key| key.id != id);
        if record.keys.len() == count {
            return Err(KeyError(404, "API key not found."));
        }
        before_mutation()?;
        self.commit(&record, false)?;
        *current = record;
        Ok(())
    }
    /// Check every HTTP request against the registry; SDK sessions never bypass revocation.
    pub fn authenticate(&self, secret: &str) -> Result<bool> {
        let mut current = self.record.lock().map_err(|_| unavailable())?;
        let mut record = read(&self.path)?;
        if !(32..=4096).contains(&secret.len()) {
            return Ok(false);
        }
        let digest = hash(secret);
        let key = record
            .keys
            .iter_mut()
            .find(|key| bool::from(key.hash.as_bytes().ct_eq(digest.as_bytes())));
        let Some(key) = key else { return Ok(false) };
        // Bound metadata writes for active automation clients to one per minute.
        let recent = key
            .last_used_at
            .as_ref()
            .and_then(|date| DateTime::parse_from_rfc3339(date).ok())
            .is_some_and(|date| {
                DateTime::<Utc>::from(std::time::SystemTime::now())
                    .signed_duration_since(date)
                    .num_seconds()
                    < 60
            });
        if !recent {
            key.last_used_at = Some(now());
            self.commit(&record, false)?;
        }
        *current = record;
        Ok(true)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn persistent_keys_are_one_time_and_revocable() {
        let root = std::env::temp_dir().join(format!("servo-keys-{}", uuid::Uuid::new_v4()));
        let path = root.join("api-keys.json");
        let legacy = "synthetic-initial-key-at-least-32-bytes";
        let keys = ApiKeys::new(path.clone(), Some(legacy.into())).unwrap();
        let initial = keys.list().unwrap()[0]["id"].as_str().unwrap().to_owned();
        assert!(keys.authenticate(legacy).unwrap());
        let created = keys.create(" Work laptop ", || Ok(())).unwrap();
        let secret = created["secret"].as_str().unwrap();
        let id = created["key"]["id"].as_str().unwrap();
        assert_eq!(created["key"]["name"], "Work laptop");
        assert!(keys.authenticate(secret).unwrap());
        assert!(
            !keys
                .authenticate("synthetic-wrong-key-at-least-32-bytes")
                .unwrap()
        );
        assert!(!fs::read_to_string(&path).unwrap().contains(secret));
        assert!(
            !serde_json::to_string(&keys.list().unwrap())
                .unwrap()
                .contains("hash")
        );
        assert_eq!(keys.create("bad\u{200b}", || Ok(())).unwrap_err().0, 400);
        assert_eq!(
            keys.revoke(id, || Err(KeyError(401, "Session expired")))
                .unwrap_err()
                .0,
            401
        );
        assert!(keys.authenticate(secret).unwrap());
        keys.revoke(id, || Ok(())).unwrap();
        keys.revoke(&initial, || Ok(())).unwrap();
        let restored = ApiKeys::new(path.clone(), Some(legacy.into())).unwrap();
        assert!(!restored.authenticate(secret).unwrap());
        assert!(!restored.authenticate(legacy).unwrap());
        fs::write(&path, "{}").unwrap();
        assert_eq!(restored.authenticate(legacy).unwrap_err().0, 503);
        assert!(ApiKeys::new(path, None).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn registry_symlinks_and_public_permissions_fail_closed() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let root = std::env::temp_dir().join(format!("servo-keys-{}", uuid::Uuid::new_v4()));
        let path = root.join("keys.json");
        let keys = ApiKeys::new(path.clone(), None).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(keys.list().unwrap_err().0, 503);
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let link = root.join("link.json");
        symlink(&path, &link).unwrap();
        assert!(ApiKeys::new(link, None).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
