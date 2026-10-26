//! Optional built-in features, persisted independently from browser profiles.
use crate::{Error, Result, api_keys::ApiKeys};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
};

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Registration {
    version: u8,
    installed: bool,
    enabled: bool,
}

pub struct McpExtension {
    path: PathBuf,
    state: Mutex<Registration>,
    keys_path: PathBuf,
    seed: Option<String>,
    keys: Mutex<Option<Arc<ApiKeys>>>,
}

fn unavailable() -> Error {
    Error::Invalid("Native extension settings are unavailable".into())
}

pub(crate) fn read_private<T: serde::de::DeserializeOwned>(
    path: &std::path::Path,
) -> Result<Option<T>> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > 4096 {
        return Err(unavailable());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(unavailable());
        }
    }
    let mut bytes = Vec::new();
    file.take(4097).read_to_end(&mut bytes)?;
    if bytes.len() > 4096 {
        return Err(unavailable());
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| unavailable())
}

pub(crate) fn write_private<T: Serialize>(path: &std::path::Path, value: &T) -> Result<()> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(std::path::Path::new("."));
    let mut directory = fs::DirBuilder::new();
    directory.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        directory.mode(0o700);
    }
    directory.create(parent)?;
    let temporary = parent.join(format!(".native-extensions-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(&serde_json::to_vec(value)?)?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        #[cfg(unix)]
        {
            fs::File::open(parent)?.sync_all()?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

impl McpExtension {
    /// Explicit MCP launch options and existing registries migrate on first startup only.
    pub fn open(
        path: PathBuf,
        keys_path: PathBuf,
        seed: Option<String>,
        requested: bool,
    ) -> Result<Arc<Self>> {
        let (state, fresh) = match read_private::<Registration>(&path)? {
            Some(value) => {
                if value.version != 1 || (value.enabled && !value.installed) {
                    return Err(unavailable());
                }
                (value, false)
            }
            None => {
                let installed = requested || keys_path.exists();
                (
                    Registration {
                        version: 1,
                        installed,
                        enabled: installed,
                    },
                    true,
                )
            }
        };
        let extension = Arc::new(Self {
            path,
            state: Mutex::new(state),
            keys_path,
            seed,
            keys: Mutex::new(None),
        });
        if fresh {
            extension.persist(state)?;
        }
        Ok(extension)
    }

    fn persist(&self, state: Registration) -> Result<()> {
        write_private(&self.path, &state)
    }

    pub fn enabled(&self) -> Result<()> {
        let state = self.state.lock().map_err(|_| unavailable())?;
        if state.installed && state.enabled {
            Ok(())
        } else {
            Err(Error::Invalid("The MCP extension is not enabled".into()))
        }
    }

    /// Configuration remains editable while an installed extension is disabled.
    pub fn keys(&self) -> Result<Arc<ApiKeys>> {
        if !self.state.lock().map_err(|_| unavailable())?.installed {
            return Err(Error::Invalid(
                "Install the MCP extension to manage its API keys".into(),
            ));
        }
        let mut keys = self.keys.lock().map_err(|_| unavailable())?;
        if keys.is_none() {
            *keys = Some(Arc::new(
                ApiKeys::new(self.keys_path.clone(), self.seed.clone())
                    .map_err(|error| Error::Invalid(error.1.into()))?,
            ));
        }
        Ok(keys.as_ref().unwrap().clone())
    }

    pub fn describe(&self) -> Result<Value> {
        let state = *self.state.lock().map_err(|_| unavailable())?;
        Ok(json!({
            "id": "mcp", "name": "MCP", "version": env!("CARGO_PKG_VERSION"),
            "description": "Connect agents to this browser. Includes connection settings and API keys.",
            "kind": "native", "scope": "browser", "installed": state.installed,
            "enabled": state.enabled, "settings": "mcp",
        }))
    }

    pub fn update(&self, id: &str, action: &str) -> Result<Value> {
        if id != "mcp" {
            return Err(Error::Invalid("Unknown native extension".into()));
        }
        {
            let mut state = self.state.lock().map_err(|_| unavailable())?;
            let mut next = *state;
            match action {
                "install" => {
                    next.installed = true;
                    next.enabled = true;
                }
                "enable" if state.installed => next.enabled = true,
                "disable" if state.installed => next.enabled = false,
                "uninstall" => {
                    next.installed = false;
                    next.enabled = false;
                }
                _ => return Err(Error::Invalid("Invalid native extension action".into())),
            }
            if next != *state {
                self.persist(next)?;
                *state = next;
            }
        }
        self.describe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn optional_installation_and_disabled_state_survive_restart_without_keys() {
        let root = std::env::temp_dir().join(format!("native-extension-{}", uuid::Uuid::new_v4()));
        let path = root.join("native-extensions.json");
        let keys = root.join("api-keys.json");
        let extension = McpExtension::open(path.clone(), keys.clone(), None, false).unwrap();
        assert!(extension.enabled().is_err());
        assert!(extension.keys().is_err());
        assert!(!keys.exists());
        extension.update("mcp", "install").unwrap();
        assert!(extension.enabled().is_ok());
        let registry = extension.keys().unwrap();
        let created = registry.create_scoped("Client", None, || Ok(())).unwrap();
        let secret = created["secret"].as_str().unwrap();
        extension.update("mcp", "disable").unwrap();
        drop(extension);
        let restored = McpExtension::open(path.clone(), keys.clone(), None, true).unwrap();
        assert!(restored.enabled().is_err());
        assert!(
            restored
                .keys()
                .unwrap()
                .authenticate_id(secret)
                .unwrap()
                .is_some()
        );
        restored.update("mcp", "enable").unwrap();
        assert!(restored.enabled().is_ok());
        restored.update("mcp", "uninstall").unwrap();
        drop(restored);
        let removed = McpExtension::open(path.clone(), keys, None, true).unwrap();
        assert_eq!(removed.describe().unwrap()["installed"], false);
        assert!(removed.keys().is_err());
        fs::write(path, "{}").unwrap();
        assert!(
            McpExtension::open(
                root.join("native-extensions.json"),
                root.join("keys"),
                None,
                true
            )
            .is_err()
        );
        fs::remove_dir_all(root).unwrap();
    }
}
