//! Trusted client identity is installed by transport adapters, never tool arguments.
use std::sync::Arc;
#[derive(Clone)]
pub struct Client {
    pub id: String,
    pub keys: Option<Arc<crate::api_keys::ApiKeys>>,
}
tokio::task_local! { static CLIENT: Client; }
pub fn current() -> Client {
    CLIENT.try_with(Clone::clone).unwrap_or(Client {
        id: "stdio".into(),
        keys: None,
    })
}
pub async fn scope<T>(client: Client, future: impl std::future::Future<Output = T>) -> T {
    CLIENT.scope(client, future).await
}
pub fn check() -> crate::Result<()> {
    let client = current();
    if let Some(keys) = client.keys
        && !keys
            .active(&client.id)
            .map_err(|_| crate::Error::Invalid("API key registry unavailable".into()))?
    {
        return Err(crate::Error::Invalid("API key has been revoked".into()));
    }
    Ok(())
}

pub fn check_profile(profile: &str) -> crate::Result<()> {
    let client = current();
    if let Some(keys) = client.keys
        && !keys
            .allows(&client.id, profile)
            .map_err(|_| crate::Error::Invalid("API key registry unavailable".into()))?
    {
        return Err(crate::Error::Invalid(
            "API key cannot access this profile".into(),
        ));
    }
    Ok(())
}
pub fn owner() -> crate::Result<()> {
    if current().keys.is_some() {
        return Err(crate::Error::Invalid(
            "Profile administration requires the owner account".into(),
        ));
    }
    Ok(())
}
