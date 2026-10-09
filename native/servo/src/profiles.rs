//! Profile discovery, persistence and lazy engine lifetimes share one interface.
use crate::{Error, Result, automation::Automation, webdriver::local_endpoint};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::sync::{Mutex, OnceCell, RwLock};
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileConfig {
    pub default_profile_id: String,
    pub profiles: Vec<ProfileDefinition>,
    pub engine_binary: Option<PathBuf>,
    pub data_root: Option<PathBuf>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileDefinition {
    pub id: String,
    pub name: String,
    pub webdriver_url: Option<String>,
    pub data_directory: Option<PathBuf>,
    #[serde(default)]
    pub services: Vec<crate::health::HealthPolicy>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInfo {
    pub id: String,
    pub name: String,
    pub connected: bool,
    pub is_default: bool,
    pub background_tabs: bool,
    pub concurrent_tabs: bool,
}
struct Entry {
    definition: ProfileDefinition,
    browser: OnceCell<Automation>,
}
#[derive(Clone)]
pub struct Profiles {
    default_id: String,
    entries: Arc<RwLock<HashMap<String, Arc<Entry>>>>,
    config: Arc<Mutex<ProfileConfig>>,
    catalog: Option<PathBuf>,
    timeout: Duration,
    _catalog_lock: Option<Arc<std::fs::File>>,
}
impl Profiles {
    pub fn new(config: ProfileConfig, timeout: Duration) -> Result<Self> {
        Self::with_catalog(config, timeout, None)
    }
    pub fn with_catalog(
        config: ProfileConfig,
        timeout: Duration,
        catalog: Option<PathBuf>,
    ) -> Result<Self> {
        if config.profiles.is_empty() || config.profiles.len() > 32 {
            return Err(Error::Invalid("Configure between 1 and 32 profiles".into()));
        }
        let mut entries = HashMap::new();
        let mut ports = HashSet::new();
        let mut directories = HashSet::new();
        for definition in &config.profiles {
            validate_name(&definition.id, &definition.name)?;
            if definition.services.len() > 32 {
                return Err(Error::Invalid(
                    "At most 32 service policies per profile".into(),
                ));
            }
            for policy in &definition.services {
                policy.validate()?;
            }
            if entries.contains_key(&definition.id) {
                return Err(Error::Invalid("Profile IDs must be unique".into()));
            }
            match (&definition.webdriver_url, &definition.data_directory) {
                (Some(endpoint), None) => {
                    let url = local_endpoint(endpoint)?;
                    if !ports.insert(url.port_or_known_default().unwrap_or(80)) {
                        return Err(Error::Invalid(
                            "Each WebDriver profile needs a distinct local port".into(),
                        ));
                    }
                }
                (None, Some(directory)) => {
                    if config.engine_binary.is_none() {
                        return Err(Error::Invalid(
                            "Embedded profiles require engineBinary".into(),
                        ));
                    }
                    prepare_directory(directory)?;
                    let canonical = std::fs::canonicalize(directory)?;
                    if !directories.insert(canonical) {
                        return Err(Error::Invalid(
                            "Each embedded profile needs its own data directory".into(),
                        ));
                    }
                }
                _ => {
                    return Err(Error::Invalid(
                        "Configure exactly one of webdriverUrl or dataDirectory per profile".into(),
                    ));
                }
            }
            entries.insert(
                definition.id.clone(),
                Arc::new(Entry {
                    definition: definition.clone(),
                    browser: OnceCell::new(),
                }),
            );
        }
        if !entries.contains_key(&config.default_profile_id) {
            return Err(Error::Invalid(
                "defaultProfileId must identify a configured profile".into(),
            ));
        }
        let catalog_lock = if let Some(path) = &catalog {
            use fs2::FileExt;
            let file = std::fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .open(path.with_extension("lock"))?;
            file.try_lock_exclusive()
                .map_err(|_| Error::Invalid("Another process owns this profiles catalog".into()))?;
            Some(Arc::new(file))
        } else {
            None
        };
        Ok(Self {
            default_id: config.default_profile_id.clone(),
            entries: Arc::new(RwLock::new(entries)),
            config: Arc::new(Mutex::new(config)),
            catalog,
            timeout,
            _catalog_lock: catalog_lock,
        })
    }
    pub async fn browser(&self, id: Option<&str>) -> Result<Automation> {
        let id = id.unwrap_or(&self.default_id);
        let entry = self.entries.read().await.get(id).cloned().ok_or_else(|| {
            Error::Invalid("Unknown profileId; list browser_profiles first".into())
        })?;
        let binary = self.config.lock().await.engine_binary.clone();
        let browser = entry
            .browser
            .get_or_try_init(|| async {
                match (
                    &entry.definition.webdriver_url,
                    &entry.definition.data_directory,
                ) {
                    (Some(endpoint), None) => Automation::connect(endpoint, self.timeout).await,
                    (None, Some(directory)) => {
                        Automation::embedded(
                            binary.as_deref().ok_or_else(|| {
                                Error::Invalid("Engine binary unavailable".into())
                            })?,
                            directory,
                            self.timeout,
                        )
                        .await
                    }
                    _ => Err(Error::Invalid("Invalid profile backend".into())),
                }
            })
            .await?;
        Ok(browser.clone())
    }
    pub async fn list(&self) -> Vec<ProfileInfo> {
        let mut profiles: Vec<_> = self
            .entries
            .read()
            .await
            .iter()
            .map(|(id, entry)| {
                let native = entry.definition.data_directory.is_some();
                ProfileInfo {
                    id: id.clone(),
                    name: entry.definition.name.clone(),
                    connected: entry.browser.initialized(),
                    is_default: id == &self.default_id,
                    background_tabs: native,
                    concurrent_tabs: native,
                }
            })
            .collect();
        profiles.sort_by(|a, b| a.id.cmp(&b.id));
        profiles
    }
    pub async fn create(&self, name: &str) -> Result<ProfileInfo> {
        let catalog = self.catalog.as_deref().ok_or_else(|| {
            Error::Invalid("Profile creation requires a persistent profiles catalog".into())
        })?;
        let mut config = self.config.lock().await;
        if config.profiles.len() >= 32 {
            return Err(Error::Invalid(
                "At most 32 profiles may be configured".into(),
            ));
        }
        if config.engine_binary.is_none() {
            return Err(Error::Invalid(
                "Profile creation requires engineBinary and dataRoot".into(),
            ));
        }
        let root = config
            .data_root
            .as_deref()
            .ok_or_else(|| Error::Invalid("Profile creation requires dataRoot".into()))?;
        let id = uuid::Uuid::new_v4().to_string();
        validate_name(&id, name)?;
        let directory = root.join(&id);
        prepare_directory(&directory)?;
        let definition = ProfileDefinition {
            id: id.clone(),
            name: name.trim().into(),
            webdriver_url: None,
            data_directory: Some(directory),
            services: Vec::new(),
        };
        let mut updated = config.clone();
        updated.profiles.push(definition.clone());
        save_catalog(catalog, &updated)?;
        self.entries.write().await.insert(
            id.clone(),
            Arc::new(Entry {
                definition: definition.clone(),
                browser: OnceCell::new(),
            }),
        );
        *config = updated;
        Ok(ProfileInfo {
            id,
            name: definition.name,
            connected: false,
            is_default: false,
            background_tabs: true,
            concurrent_tabs: true,
        })
    }
    pub async fn policies(&self, id: &str) -> Result<Vec<crate::health::HealthPolicy>> {
        self.config
            .lock()
            .await
            .profiles
            .iter()
            .find(|profile| profile.id == id)
            .map(|profile| profile.services.clone())
            .ok_or_else(|| Error::Invalid("Unknown profileId".into()))
    }
    pub async fn save_policy(&self, id: &str, policy: crate::health::HealthPolicy) -> Result<()> {
        policy.validate()?;
        let catalog = self.catalog.as_deref().ok_or_else(|| {
            Error::Invalid("Service policies require a persistent profiles catalog".into())
        })?;
        let mut config = self.config.lock().await;
        let mut updated = config.clone();
        let profile = updated
            .profiles
            .iter_mut()
            .find(|profile| profile.id == id)
            .ok_or_else(|| Error::Invalid("Unknown profileId".into()))?;
        profile
            .services
            .retain(|existing| existing.origin != policy.origin);
        if profile.services.len() >= 32 {
            return Err(Error::Invalid(
                "At most 32 service policies per profile".into(),
            ));
        }
        profile.services.push(policy);
        save_catalog(catalog, &updated)?;
        *config = updated;
        Ok(())
    }
    pub async fn close(&self) {
        let entries: Vec<_> = self.entries.read().await.values().cloned().collect();
        let mut cleanup = tokio::task::JoinSet::new();
        for entry in entries {
            if let Some(browser) = entry.browser.get() {
                let browser = browser.clone();
                cleanup.spawn(async move {
                    let _ = tokio::time::timeout(Duration::from_secs(5), browser.close()).await;
                });
            }
        }
        while cleanup.join_next().await.is_some() {}
    }
}
fn prepare_directory(path: &Path) -> Result<()> {
    std::fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}
fn validate_name(id: &str, name: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 64
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(Error::Invalid(
            "Profile IDs must contain 1 to 64 ASCII letters, digits, hyphens or underscores".into(),
        ));
    }
    if name.trim().is_empty() || name.chars().count() > 120 || name.chars().any(char::is_control) {
        return Err(Error::Invalid(
            "Profile names must contain 1 to 120 characters without control characters".into(),
        ));
    }
    Ok(())
}
fn save_catalog(path: &Path, config: &ProfileConfig) -> Result<()> {
    write_catalog(path, config, true)
}
fn write_catalog(path: &Path, config: &ProfileConfig, replace: bool) -> Result<()> {
    use std::io::Write;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| -> Result<()> {
        let mut file = options.open(&temporary)?;
        let bytes = serde_json::to_vec_pretty(config)?;
        if bytes.len() > 65536 {
            return Err(Error::Invalid("Profile catalog exceeds 64 KiB".into()));
        }
        file.write_all(&bytes)?;
        file.sync_all()?;
        if replace {
            std::fs::rename(&temporary, path)?;
        } else {
            // Publish the completed initial catalog without replacing a competing creator.
            std::fs::hard_link(&temporary, path)?;
            std::fs::remove_file(&temporary)?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}

pub fn initialize_catalog(path: &Path, config: &ProfileConfig) -> Result<()> {
    write_catalog(path, config, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> ProfileConfig {
        ProfileConfig {
            default_profile_id: "personal".into(),
            engine_binary: None,
            data_root: None,
            profiles: vec![
                ProfileDefinition {
                    id: "personal".into(),
                    name: "Personal".into(),
                    webdriver_url: Some("http://127.0.0.1:7002".into()),
                    data_directory: None,
                    services: Vec::new(),
                },
                ProfileDefinition {
                    id: "work".into(),
                    name: "Work".into(),
                    webdriver_url: Some("http://localhost:7003".into()),
                    data_directory: None,
                    services: Vec::new(),
                },
            ],
        }
    }
    #[test]
    fn rejects_duplicate_engines_and_unknown_defaults() {
        let mut duplicate = config();
        duplicate.profiles[1].webdriver_url = Some("http://localhost:7002".into());
        assert!(Profiles::new(duplicate, Duration::from_secs(15)).is_err());
        let mut missing = config();
        missing.default_profile_id = "unknown".into();
        assert!(Profiles::new(missing, Duration::from_secs(15)).is_err());
    }
    #[tokio::test]
    async fn catalog_persists_profiles_policies_and_exclusive_ownership() {
        let root = std::env::temp_dir().join(format!("servo-catalog-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("profiles.json");
        let mut initial = config();
        initial.engine_binary = Some(root.join("engine"));
        initial.data_root = Some(root.join("data"));
        initialize_catalog(&path, &initial).unwrap();
        let profiles =
            Profiles::with_catalog(initial.clone(), Duration::from_secs(15), Some(path.clone()))
                .unwrap();
        assert!(
            Profiles::with_catalog(initial, Duration::from_secs(15), Some(path.clone())).is_err()
        );
        let created = profiles.create("Account three").await.unwrap();
        profiles
            .save_policy(
                &created.id,
                crate::health::HealthPolicy {
                    origin: "https://example.com".into(),
                    cookie_names: vec!["auth".into()],
                    authenticated_selector: Some("[data-account]".into()),
                    login_selector: None,
                    warning_seconds: 3600,
                },
            )
            .await
            .unwrap();
        let saved: ProfileConfig = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved.profiles.len(), 3);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            let directory = saved
                .profiles
                .last()
                .unwrap()
                .data_directory
                .as_ref()
                .unwrap();
            assert_eq!(
                std::fs::metadata(directory).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        drop(profiles);
        let reopened =
            Profiles::with_catalog(saved, Duration::from_secs(15), Some(path.clone())).unwrap();
        assert_eq!(
            reopened.policies(&created.id).await.unwrap()[0].cookie_names,
            vec!["auth"]
        );
        assert_eq!(reopened.list().await.len(), 3);
        drop(reopened);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn discovery_is_lazy_and_hides_paths() {
        let profiles = Profiles::new(config(), Duration::from_secs(15)).unwrap();
        let list = profiles.list().await;
        assert_eq!(list.len(), 2);
        assert!(list.iter().all(|p| !p.connected));
        let encoded = serde_json::to_string(&list).unwrap();
        assert!(!encoded.contains("localhost"));
        assert!(!encoded.contains("webdriverUrl"));
    }
}
