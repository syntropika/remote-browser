//! Optional browser login, independent from MCP and its API keys.
use crate::{Error, Result};
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;
use unicode_categories::UnicodeCategories;

const LIFETIME: Duration = Duration::from_secs(12 * 60 * 60);

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u8,
    installed: bool,
    enabled: bool,
    username: Option<String>,
    password_hash: Option<String>,
}

struct State {
    record: Record,
    sessions: HashMap<String, Instant>,
    failures: u8,
    retry_at: Instant,
}

pub struct AccessExtension {
    path: PathBuf,
    state: Mutex<State>,
}

fn unavailable() -> Error {
    Error::Invalid("Access settings are unavailable".into())
}
fn token_hash(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

impl AccessExtension {
    pub fn open(path: PathBuf) -> Result<Arc<Self>> {
        let record: Record = crate::native_extensions::read_private(&path)?.unwrap_or(Record {
            version: 1,
            installed: false,
            enabled: false,
            username: None,
            password_hash: None,
        });
        if record.version != 1
            || (record.enabled && (!record.installed || record.password_hash.is_none()))
            || record.username.is_some() != record.password_hash.is_some()
            || record
                .password_hash
                .as_ref()
                .is_some_and(|hash| PasswordHash::new(hash).is_err())
        {
            return Err(unavailable());
        }
        Ok(Arc::new(Self {
            path,
            state: Mutex::new(State {
                record,
                sessions: HashMap::new(),
                failures: 0,
                retry_at: Instant::now(),
            }),
        }))
    }

    pub fn describe(&self) -> Result<Value> {
        let state = self.state.lock().map_err(|_| unavailable())?;
        Ok(
            json!({"id":"access", "name":"Access", "kind":"native", "scope":"browser",
            "description":"Protect the browser dashboard with a username and password.",
            "installed":state.record.installed, "enabled":state.record.enabled,
            "configured":state.record.password_hash.is_some(), "username":state.record.username,
            "settings":"access"}),
        )
    }

    pub fn required(&self) -> Result<bool> {
        let state = self.state.lock().map_err(|_| unavailable())?;
        Ok(state.record.installed && state.record.enabled)
    }

    pub fn authenticated(&self, token: Option<&str>) -> Result<bool> {
        let mut state = self.state.lock().map_err(|_| unavailable())?;
        state
            .sessions
            .retain(|_, expires| *expires > Instant::now());
        Ok(token.is_some_and(|token| {
            token.len() <= 128 && state.sessions.contains_key(&token_hash(token))
        }))
    }

    pub fn session(&self) -> Result<String> {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).map_err(|_| unavailable())?;
        let token = URL_SAFE_NO_PAD.encode(bytes);
        let mut state = self.state.lock().map_err(|_| unavailable())?;
        if !state.record.installed || !state.record.enabled {
            return Err(unavailable());
        }
        state
            .sessions
            .retain(|_, expires| *expires > Instant::now());
        if state.sessions.len() >= 128 {
            return Err(Error::Invalid(
                "Too many browser sessions; sign out of another session first".into(),
            ));
        }
        state
            .sessions
            .insert(token_hash(&token), Instant::now() + LIFETIME);
        Ok(token)
    }

    pub fn login(&self, username: &str, password: &str) -> Result<String> {
        if username.len() > 256 || password.len() > 1024 {
            return Err(Error::Invalid("Invalid username or password".into()));
        }
        {
            let mut state = self.state.lock().map_err(|_| unavailable())?;
            if !state.record.installed || !state.record.enabled {
                return Err(Error::Invalid("Browser login is not enabled".into()));
            }
            if state.retry_at > Instant::now() {
                return Err(Error::Invalid(
                    "Too many attempts. Try again in one minute".into(),
                ));
            }
            let hash = PasswordHash::new(
                state
                    .record
                    .password_hash
                    .as_deref()
                    .ok_or_else(unavailable)?,
            )
            .map_err(|_| unavailable())?;
            let password_ok = Argon2::default()
                .verify_password(password.as_bytes(), &hash)
                .is_ok();
            let username_ok = bool::from(
                state
                    .record
                    .username
                    .as_deref()
                    .unwrap_or_default()
                    .as_bytes()
                    .ct_eq(username.trim().as_bytes()),
            );
            if !password_ok || !username_ok {
                state.failures += 1;
                if state.failures >= 5 {
                    state.failures = 0;
                    state.retry_at = Instant::now() + Duration::from_secs(60);
                }
                return Err(Error::Invalid("Invalid username or password".into()));
            }
            state.failures = 0;
        }
        self.session()
    }

    pub fn configure(&self, username: &str, password: &str) -> Result<()> {
        let username = username.trim();
        if username.is_empty()
            || username.chars().count() > 64
            || username
                .chars()
                .any(|c| c.is_control() || c.is_other_format())
        {
            return Err(Error::Invalid("Use a username of 1–64 characters".into()));
        }
        if password.chars().count() < 12 || password.len() > 1024 {
            return Err(Error::Invalid(
                "Use at least 12 characters and no more than 1024 bytes for the password".into(),
            ));
        }
        let mut bytes = [0u8; 16];
        getrandom::fill(&mut bytes).map_err(|_| unavailable())?;
        let salt = SaltString::encode_b64(&bytes).map_err(|_| unavailable())?;
        let password_hash = Argon2::default()
            .hash_password(password.as_bytes(), &salt)
            .map_err(|_| unavailable())?
            .to_string();
        let mut state = self.state.lock().map_err(|_| unavailable())?;
        if !state.record.installed {
            return Err(Error::Invalid(
                "Install Access before configuring browser login".into(),
            ));
        }
        let mut next = state.record.clone();
        next.username = Some(username.into());
        next.password_hash = Some(password_hash);
        next.enabled = true;
        crate::native_extensions::write_private(&self.path, &next)?;
        state.record = next;
        state.sessions.clear();
        state.failures = 0;
        state.retry_at = Instant::now();
        Ok(())
    }

    pub fn logout(&self, token: Option<&str>) -> Result<()> {
        if let Some(token) = token {
            self.state
                .lock()
                .map_err(|_| unavailable())?
                .sessions
                .remove(&token_hash(token));
        }
        Ok(())
    }

    pub fn update(&self, action: &str) -> Result<Value> {
        {
            let mut state = self.state.lock().map_err(|_| unavailable())?;
            let mut next = state.record.clone();
            match action {
                "install" => next.installed = true,
                "enable" if next.installed && next.password_hash.is_some() => next.enabled = true,
                "enable" => {
                    return Err(Error::Invalid(
                        "Configure a username and password before enabling Access".into(),
                    ));
                }
                "disable" if next.installed => next.enabled = false,
                "uninstall" => {
                    next.installed = false;
                    next.enabled = false;
                }
                _ => return Err(Error::Invalid("Invalid native extension action".into())),
            }
            crate::native_extensions::write_private(&self.path, &next)?;
            state.record = next;
            if !state.record.enabled {
                state.sessions.clear();
            }
        }
        self.describe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_rotation_expiry_and_corrupt_restart_fail_closed() {
        let root = std::env::temp_dir().join(format!("browser-login-{}", uuid::Uuid::new_v4()));
        let path = root.join("access-extension.json");
        let access = AccessExtension::open(path.clone()).unwrap();
        assert!(!access.required().unwrap());
        assert!(access.configure("owner", "synthetic-password-one").is_err());
        access.update("install").unwrap();
        assert!(access.update("enable").is_err());
        access.configure("owner", "synthetic-password-one").unwrap();
        assert!(access.required().unwrap());
        let first = access.login("owner", "synthetic-password-one").unwrap();
        assert!(access.authenticated(Some(&first)).unwrap());
        access
            .state
            .lock()
            .unwrap()
            .sessions
            .insert(token_hash(&first), Instant::now() - Duration::from_secs(1));
        assert!(!access.authenticated(Some(&first)).unwrap());
        let second = access.login("owner", "synthetic-password-one").unwrap();
        access.configure("owner", "synthetic-password-two").unwrap();
        assert!(!access.authenticated(Some(&second)).unwrap());
        assert!(access.login("owner", "synthetic-password-one").is_err());
        let third = access.login("owner", "synthetic-password-two").unwrap();
        access.logout(Some(&third)).unwrap();
        assert!(!access.authenticated(Some(&third)).unwrap());
        for _ in 0..5 {
            assert!(access.login("owner", "incorrect").is_err());
        }
        assert!(
            access
                .login("owner", "synthetic-password-two")
                .unwrap_err()
                .to_string()
                .contains("Too many attempts")
        );
        drop(access);
        let restored = AccessExtension::open(path.clone()).unwrap();
        assert!(restored.required().unwrap());
        assert!(!restored.authenticated(Some(&third)).unwrap());
        assert!(
            !restored
                .describe()
                .unwrap()
                .to_string()
                .contains("password_hash")
        );
        drop(restored);
        fs::write(&path, "{}").unwrap();
        assert!(AccessExtension::open(path).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    use std::fs;
}
