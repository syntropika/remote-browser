//! Persistent owner credentials compatible with the existing scrypt account record.
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;
use unicode_categories::UnicodeCategories;
use unicode_normalization::UnicodeNormalization;

pub const COOKIE_NAME: &str = "remote_browser_session";
const SESSION_TIME: Duration = Duration::from_secs(8 * 60 * 60);
#[derive(Debug)]
pub struct AuthError(pub u16, pub &'static str);
type Result<T> = std::result::Result<T, AuthError>;
fn unavailable() -> AuthError {
    AuthError(
        503,
        "The dashboard account is unavailable. Contact the administrator.",
    )
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Credentials {
    pub username: String,
    pub password: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    version: u8,
    id: String,
    username: String,
    canonical_username: String,
    algorithm: String,
    #[serde(rename = "N")]
    n: u32,
    r: u32,
    p: u32,
    salt: String,
    password_hash: String,
}
struct Attempts {
    since: Instant,
    count: u32,
}
pub struct DashboardAuth {
    path: PathBuf,
    sessions: Mutex<HashMap<String, Instant>>,
    attempts: Mutex<Attempts>,
    derivations: Arc<tokio::sync::Semaphore>,
    secure_cookie: bool,
}
fn canonical(name: &str) -> String {
    name.nfkc().flat_map(char::to_lowercase).collect()
}
fn username(name: &str) -> Option<String> {
    let name: String = name.trim().nfc().collect();
    ((3..=64).contains(&name.encode_utf16().count())
        && !name
            .chars()
            .any(|c| c.is_other_control() || c.is_other_format()))
    .then_some(name)
}
fn password_valid(password: &str) -> bool {
    (12..=256).contains(&password.encode_utf16().count())
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn unhex(text: &str, bytes: usize) -> Result<Vec<u8>> {
    if text.len() != bytes * 2
        || !text
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err(unavailable());
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).map_err(|_| unavailable()))
        .collect()
}
fn derive(password: &str, salt: &[u8]) -> Result<[u8; 64]> {
    let mut hash = [0; 64];
    scrypt::scrypt(
        password.as_bytes(),
        salt,
        &scrypt::Params::new(15, 8, 1, 64).map_err(|_| unavailable())?,
        &mut hash,
    )
    .map_err(|_| unavailable())?;
    Ok(hash)
}
impl DashboardAuth {
    pub fn new(path: PathBuf, secure_cookie: bool) -> Self {
        Self {
            path,
            secure_cookie,
            sessions: Mutex::new(HashMap::new()),
            attempts: Mutex::new(Attempts {
                since: Instant::now(),
                count: 0,
            }),
            derivations: Arc::new(tokio::sync::Semaphore::new(2)),
        }
    }
    fn load(&self) -> Result<Option<Record>> {
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW);
        }
        let file = match options.open(&self.path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(unavailable()),
        };
        let meta = file.metadata().map_err(|_| unavailable())?;
        if !meta.is_file() || meta.len() > 16384 {
            return Err(unavailable());
        }
        let mut bytes = Vec::new();
        file.take(16385)
            .read_to_end(&mut bytes)
            .map_err(|_| unavailable())?;
        if bytes.len() > 16384 {
            return Err(unavailable());
        }
        let record: Record = serde_json::from_slice(&bytes).map_err(|_| unavailable())?;
        if record.version != 1
            || record.algorithm != "scrypt"
            || record.n != 32768
            || record.r != 8
            || record.p != 1
            || username(&record.username).as_deref() != Some(&record.username)
            || canonical(&record.username) != record.canonical_username
        {
            return Err(unavailable());
        }
        unhex(&record.id, 16)?;
        unhex(&record.salt, 16)?;
        unhex(&record.password_hash, 64)?;
        Ok(Some(record))
    }
    pub fn configured(&self) -> Result<bool> {
        Ok(self.load()?.is_some())
    }
    pub fn allow_attempt(&self) -> Result<()> {
        let mut attempts = self.attempts.lock().unwrap();
        if attempts.since.elapsed() >= Duration::from_secs(60) {
            *attempts = Attempts {
                since: Instant::now(),
                count: 0,
            };
        }
        if attempts.count >= 30 {
            return Err(AuthError(
                429,
                "Too many sign-in requests. Try again in one minute.",
            ));
        }
        attempts.count += 1;
        Ok(())
    }
    pub async fn credentials(self: &Arc<Self>, input: Credentials, setup: bool) -> Result<()> {
        let permit = self
            .derivations
            .clone()
            .try_acquire_owned()
            .map_err(|_| AuthError(429, "Too many sign-in requests. Try again shortly."))?;
        let auth = self.clone();
        tokio::task::spawn_blocking(move || {
            // Keep the permit in this task even if its HTTP request is cancelled.
            let _permit = permit;
            if setup {
                auth.create(input)
            } else {
                auth.verify(input)
            }
        })
        .await
        .map_err(|_| unavailable())?
    }
    fn create(&self, input: Credentials) -> Result<()> {
        if self.load()?.is_some() {
            return Err(AuthError(
                409,
                "The dashboard account is already configured.",
            ));
        }
        let name = username(&input.username).ok_or(AuthError(
            400,
            "Use a username with 3 to 64 characters and no control characters.",
        ))?;
        if !password_valid(&input.password) {
            return Err(AuthError(400, "Use a password with 12 to 256 characters."));
        }
        let salt = uuid::Uuid::new_v4();
        let record = Record {
            version: 1,
            id: uuid::Uuid::new_v4().simple().to_string(),
            canonical_username: canonical(&name),
            username: name,
            algorithm: "scrypt".into(),
            n: 32768,
            r: 8,
            p: 1,
            salt: hex(salt.as_bytes()),
            password_hash: hex(&derive(&input.password, salt.as_bytes())?),
        };
        let parent = self
            .path
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| std::path::Path::new("."));
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(parent).map_err(|_| unavailable())?;
        let temporary = parent.join(format!(".account-{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temporary).map_err(|_| unavailable())?;
            file.write_all(&serde_json::to_vec(&record).map_err(|_| unavailable())?)
                .and_then(|_| file.sync_all())
                .map_err(|_| unavailable())?;
            fs::hard_link(&temporary, &self.path).map_err(|error| {
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    AuthError(409, "The dashboard account is already configured.")
                } else {
                    unavailable()
                }
            })?;
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
    fn verify(&self, input: Credentials) -> Result<()> {
        let record = self.load()?;
        let salt = record
            .as_ref()
            .map(|record| unhex(&record.salt, 16))
            .transpose()?
            .unwrap_or_else(|| uuid::Uuid::new_v4().as_bytes().to_vec());
        let password = if input.password.encode_utf16().count() <= 256 {
            &input.password
        } else {
            ""
        };
        let actual = derive(password, &salt)?;
        let expected = record
            .as_ref()
            .map(|record| unhex(&record.password_hash, 64))
            .transpose()?
            .unwrap_or(vec![0; 64]);
        let matches = bool::from(actual.as_slice().ct_eq(&expected));
        let name = username(&input.username);
        if matches
            && password_valid(&input.password)
            && record
                .as_ref()
                .zip(name.as_ref())
                .is_some_and(|(record, name)| record.canonical_username == canonical(name))
        {
            Ok(())
        } else {
            Err(AuthError(401, "Invalid username or password."))
        }
    }
    pub fn session_id<'a>(&self, cookie: Option<&'a str>) -> Option<&'a str> {
        cookie?
            .split(';')
            .filter_map(|part| part.trim().split_once('='))
            .find(|(name, value)| {
                *name == COOKIE_NAME
                    && value.len() == 64
                    && value.bytes().all(|c| c.is_ascii_hexdigit())
            })
            .map(|(_, value)| value)
    }
    pub fn authenticated(&self, cookie: Option<&str>) -> bool {
        let Some(id) = self.session_id(cookie) else {
            return false;
        };
        let mut sessions = self.sessions.lock().unwrap();
        sessions.retain(|_, expiry| *expiry > Instant::now());
        sessions.contains_key(id)
    }
    pub fn issue(&self, cookie: Option<&str>) -> Result<String> {
        let mut sessions = self.sessions.lock().unwrap();
        sessions.retain(|_, expiry| *expiry > Instant::now());
        if let Some(id) = self.session_id(cookie) {
            sessions.remove(id);
        }
        if sessions.len() >= 32 {
            return Err(AuthError(
                429,
                "Too many active sessions. Sign out of another session.",
            ));
        }
        let id = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        sessions.insert(id.clone(), Instant::now() + SESSION_TIME);
        Ok(self.cookie(&id))
    }
    pub fn logout(&self, cookie: Option<&str>) -> String {
        if let Some(id) = self.session_id(cookie) {
            self.sessions.lock().unwrap().remove(id);
        }
        self.cookie("")
    }
    fn cookie(&self, id: &str) -> String {
        format!(
            "{COOKIE_NAME}={id}; HttpOnly; SameSite=Strict; Path=/; Max-Age={}{}",
            if id.is_empty() {
                0
            } else {
                SESSION_TIME.as_secs()
            },
            if self.secure_cookie { "; Secure" } else { "" }
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn account_persists_and_sessions_are_revoked() {
        let root = std::env::temp_dir().join(format!("servo-account-{}", uuid::Uuid::new_v4()));
        let auth = Arc::new(DashboardAuth::new(root.join("account.json"), false));
        assert!(!auth.configured().unwrap());
        auth.credentials(
            Credentials {
                username: " Owner ".into(),
                password: "a safe test password".into(),
            },
            true,
        )
        .await
        .unwrap();
        let restored = Arc::new(DashboardAuth::new(root.join("account.json"), false));
        restored
            .credentials(
                Credentials {
                    username: "owner".into(),
                    password: "a safe test password".into(),
                },
                false,
            )
            .await
            .unwrap();
        assert_eq!(
            restored
                .credentials(
                    Credentials {
                        username: "owner".into(),
                        password: "wrong password".into()
                    },
                    false
                )
                .await
                .unwrap_err()
                .0,
            401
        );
        assert_eq!(
            restored
                .credentials(
                    Credentials {
                        username: "other".into(),
                        password: "other test password".into()
                    },
                    true
                )
                .await
                .unwrap_err()
                .0,
            409
        );
        let cookie = restored.issue(None).unwrap();
        assert!(cookie.contains("HttpOnly; SameSite=Strict"));
        assert!(restored.authenticated(Some(&cookie)));
        let next = restored.issue(Some(&cookie)).unwrap();
        assert!(!restored.authenticated(Some(&cookie)));
        assert!(restored.authenticated(Some(&next)));
        restored.logout(Some(&next));
        assert!(!restored.authenticated(Some(&next)));
        fs::write(root.join("account.json"), b"{}").unwrap();
        assert_eq!(restored.configured().unwrap_err().0, 503);
        fs::remove_dir_all(root).unwrap();
    }
}
