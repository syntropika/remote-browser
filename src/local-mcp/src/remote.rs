//! Remote control is a transparent, non-retrying MCP relay; credentials never enter tool arguments.
use reqwest::{
    Client,
    header::{AUTHORIZATION, HeaderValue},
};
use serde_json::Value;
use std::time::Duration;
use tokio::sync::RwLock;
use url::Url;

pub struct Remote {
    pub base: Url,
    pub authorization: HeaderValue,
    client: Client,
    session: RwLock<Option<HeaderValue>>,
    protocol: RwLock<HeaderValue>,
}
impl Remote {
    pub fn new(mut base: Url, token: &str) -> Result<Self, String> {
        if !matches!(base.scheme(), "http" | "https")
            || base.host_str().is_none()
            || !base.username().is_empty()
            || base.password().is_some()
            || base.query().is_some()
            || base.fragment().is_some()
        {
            return Err("Use an HTTP(S) server URL without credentials, query or fragment".into());
        }
        let path = base
            .path()
            .trim_end_matches('/')
            .strip_suffix("/mcp")
            .unwrap_or(base.path().trim_end_matches('/'))
            .to_owned()
            + "/";
        base.set_path(&path);
        if token.len() < 32 || token.len() > 256 || !token.bytes().all(|c| c.is_ascii_graphic()) {
            return Err(
                "Set REMOTE_BROWSER_API_KEY or pass --api-key-file with a valid credential".into(),
            );
        }
        let mut authorization =
            HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| "Invalid API key")?;
        authorization.set_sensitive(true);
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(150))
            .build()
            .map_err(|_| "Could not initialize the remote connection")?;
        Ok(Self {
            base,
            authorization,
            client,
            session: RwLock::new(None),
            protocol: RwLock::new(HeaderValue::from_static("2025-03-26")),
        })
    }
    pub fn url(&self, path: &str) -> Url {
        self.base.join(path).expect("internal relative endpoint")
    }
    async fn json(&self, response: reqwest::Response) -> Result<Option<Value>, String> {
        if !response.status().is_success() {
            return Err(format!(
                "Remote Browser returned HTTP {}",
                response.status().as_u16()
            ));
        }
        if let Some(session) = response.headers().get("mcp-session-id") {
            *self.session.write().await = Some(session.clone());
        }
        let mut response = response;
        let mut bytes = Vec::new();
        while let Some(chunk)=response.chunk().await.map_err(|_|"Remote response was interrupted; do not replay a page action without observing its state")?{
            if bytes.len()+chunk.len()>8*1024*1024{return Err("Remote response exceeds 8 MiB".into());}
            bytes.extend_from_slice(&chunk);
        }
        if bytes.is_empty() {
            Ok(None)
        } else {
            serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(|_| "Remote Browser returned an invalid JSON response".into())
        }
    }
    pub async fn mcp(&self, message: &Value) -> Result<Option<Value>, String> {
        let mut request = self
            .client
            .post(self.url("mcp"))
            .header(AUTHORIZATION, self.authorization.clone())
            .header("accept", "application/json, text/event-stream")
            .header("mcp-protocol-version", self.protocol.read().await.clone())
            .json(message);
        if let Some(session) = self.session.read().await.clone() {
            request = request.header("mcp-session-id", session);
        }
        let response=request.send().await.map_err(|_|"Remote request failed or completion is unknown; do not automatically replay page actions")?;
        let reply = self.json(response).await?;
        if message["method"] == "initialize"
            && let Some(version) = reply
                .as_ref()
                .and_then(|r| r["result"]["protocolVersion"].as_str())
        {
            *self.protocol.write().await =
                HeaderValue::from_str(version).map_err(|_| "Invalid negotiated MCP version")?;
        }
        Ok(reply)
    }
    pub async fn open_network(&self, body: &Value) -> Result<Value, String> {
        let response = self
            .client
            .post(self.url("network/sessions"))
            .header(AUTHORIZATION, self.authorization.clone())
            .json(body)
            .send()
            .await
            .map_err(|_| "Could not create the network session")?;
        self.json(response)
            .await?
            .ok_or_else(|| "Missing network session response".into())
    }
    pub async fn close_network(&self, id: &str) -> Result<(), String> {
        let response = self
            .client
            .delete(self.url(&format!("network/sessions/{id}")))
            .header(AUTHORIZATION, self.authorization.clone())
            .send()
            .await
            .map_err(|_| "Could not close the network session")?;
        self.json(response).await.map(|_| ())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn endpoints_preserve_prefix_and_reject_embedded_credentials() {
        let key = "a".repeat(40);
        let remote =
            Remote::new("https://example.test/browser/mcp".parse().unwrap(), &key).unwrap();
        assert_eq!(
            remote.url("network/sessions").as_str(),
            "https://example.test/browser/network/sessions"
        );
        for url in [
            "file:///tmp/browser",
            "https://user:secret@example.test",
            "https://example.test/?token=secret",
        ] {
            assert!(Remote::new(url.parse().unwrap(), &key).is_err());
        }
    }
}
