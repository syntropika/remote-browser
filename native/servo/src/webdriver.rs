//! The only module that knows Servo's WebDriver wire protocol.
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

use reqwest::{Client, Method, Url};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{Error, Result};

pub const ELEMENT_KEY: &str = "element-6066-11e4-a52e-4f735466cecf";
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

pub struct WebDriver {
    client: Client,
    endpoint: Url,
    session_id: String,
    uncertain: AtomicBool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Session {
    session_id: String,
    capabilities: Value,
}

pub fn local_endpoint(value: &str) -> Result<Url> {
    let url = Url::parse(value).map_err(|_| Error::Invalid("Invalid WebDriver URL".into()))?;
    if url.scheme() != "http"
        || !matches!(url.host_str(), Some("127.0.0.1" | "[::1]" | "localhost"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err(Error::Invalid("WebDriver must be an HTTP loopback origin without credentials, path, query or fragment".into()));
    }
    Ok(url)
}

impl WebDriver {
    pub async fn connect(endpoint: &str, timeout: Duration) -> Result<Self> {
        let endpoint = local_endpoint(endpoint)?;
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(timeout)
            .build()?;
        let mut driver = Self {
            client,
            endpoint,
            session_id: String::new(),
            uncertain: AtomicBool::new(false),
        };
        let value = driver
            .request(
                Method::POST,
                &["session"],
                Some(json!({
                    "capabilities": {"alwaysMatch": {"browserName": "servo"}}
                })),
            )
            .await?;
        let session: Session = serde_json::from_value(value)?;
        driver.session_id = session.session_id;
        if session.capabilities["browserName"] != "servo" || driver.session_id.is_empty() {
            let _ = driver.close().await;
            return Err(Error::Protocol(
                "The endpoint did not create a Servo session".into(),
            ));
        }
        // Keep engine deadlines below the transport deadline. A timeout still poisons the session.
        let engine_ms = timeout.as_millis().saturating_sub(1000).min(10_000);
        if let Err(error) = driver
            .command(
                Method::POST,
                &["timeouts"],
                Some(json!({
                    "implicit": 0, "script": engine_ms, "pageLoad": engine_ms
                })),
            )
            .await
        {
            let _ = driver.close().await;
            return Err(error);
        }
        Ok(driver)
    }

    pub fn is_uncertain(&self) -> bool {
        self.uncertain.load(Ordering::SeqCst)
    }

    async fn request(
        &self,
        method: Method,
        segments: &[&str],
        body: Option<Value>,
    ) -> Result<Value> {
        if self.is_uncertain() {
            return Err(Error::Uncertain);
        }
        let mut url = self.endpoint.clone();
        url.path_segments_mut()
            .map_err(|_| Error::Protocol("Invalid endpoint".into()))?
            .clear()
            .extend(segments);
        let mut request = self.client.request(method, url);
        if let Some(body) = body {
            request = request.json(&body);
        }
        // Cancellation or an incomplete response leaves this flag set, even if the Rust future is dropped.
        self.uncertain.store(true, Ordering::SeqCst);
        let mut response = request.send().await?;
        let status = response.status();
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
                return Err(Error::Protocol(
                    "Servo response exceeds 8 MiB; restart before continuing".into(),
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        let envelope: Value = serde_json::from_slice(&bytes)?;
        let value = envelope.get("value").ok_or_else(|| {
            Error::Protocol("Missing WebDriver result; restart before continuing".into())
        })?;
        if !status.is_success() {
            let code = value["error"]
                .as_str()
                .ok_or_else(|| Error::Protocol("Invalid WebDriver error".into()))?;
            if !matches!(
                code,
                "timeout" | "script timeout" | "invalid session id" | "unknown error"
            ) {
                self.uncertain.store(false, Ordering::SeqCst);
            }
            return Err(Error::WebDriver {
                code: code.into(),
                message: value["message"]
                    .as_str()
                    .unwrap_or("Operation failed")
                    .chars()
                    .take(500)
                    .collect(),
            });
        }
        self.uncertain.store(false, Ordering::SeqCst);
        Ok(value.clone())
    }

    pub async fn command(
        &self,
        method: Method,
        route: &[&str],
        body: Option<Value>,
    ) -> Result<Value> {
        let mut segments = vec!["session", self.session_id.as_str()];
        segments.extend_from_slice(route);
        self.request(method, &segments, body).await
    }

    pub async fn evaluate(&self, script: &str, args: Vec<Value>) -> Result<Value> {
        self.command(
            Method::POST,
            &["execute", "sync"],
            Some(json!({"script":script,"args":args})),
        )
        .await
    }

    /// Deleting the session is allowed after uncertainty; it is never used to resume automation.
    pub async fn close(&self) -> Result<()> {
        let mut url = self.endpoint.clone();
        url.path_segments_mut()
            .map_err(|_| Error::Protocol("Invalid endpoint".into()))?
            .clear()
            .extend(["session", &self.session_id]);
        self.client.delete(url).send().await?.error_for_status()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_local_origins() {
        for good in [
            "http://127.0.0.1:7002",
            "http://localhost:7002/",
            "http://[::1]:7002/",
        ] {
            assert!(local_endpoint(good).is_ok(), "{good}");
        }
        for bad in [
            "https://localhost:7002",
            "http://example.com",
            "http://127.0.0.1.example.com",
            "http://user:secret@localhost:7002",
            "http://localhost:7002/session",
            "http://localhost:7002/?x=1",
            "http://localhost:7002/#fragment",
        ] {
            assert!(local_endpoint(bad).is_err(), "{bad}");
        }
    }
}
