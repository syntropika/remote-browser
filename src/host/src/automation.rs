//! Engine-independent browser operations exposed to the host and MCP.
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    Error, Result,
    health::{HealthPolicy, SessionHealth},
    reservations::{Lease, ReservationInfo},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Owner {
    Human,
    Agent,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Element {
    pub reference: String,
    pub role: String,
    pub name: String,
    pub tag: String,
    pub r#type: Option<String>,
    pub disabled: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub tab_id: String,
    pub url: String,
    pub title: String,
    pub text: String,
    pub truncated: bool,
    pub elements: Vec<Element>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Tab {
    pub id: String,
    pub active: bool,
    pub owned: bool,
    #[serde(default)]
    pub file_picker: bool,
    #[serde(default)]
    pub can_go_back: bool,
    #[serde(default)]
    pub can_go_forward: bool,
    pub reservation: Option<ReservationInfo>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub owner: Option<Owner>,
    #[serde(default)]
    pub busy: bool,
    #[serde(default)]
    pub uncertain: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Status {
    pub owner: Owner,
    pub uncertain: bool,
}

#[derive(Clone)]
pub struct Automation(crate::native::NativeClient);
impl Automation {
    pub async fn embedded(
        binary: &std::path::Path,
        directory: &std::path::Path,
        timeout: Duration,
    ) -> Result<Self> {
        Self::embedded_with_files(binary, directory, None, timeout).await
    }
    pub async fn embedded_with_files(
        binary: &std::path::Path,
        directory: &std::path::Path,
        files: Option<&std::path::Path>,
        timeout: Duration,
    ) -> Result<Self> {
        Ok(Self(
            crate::native::NativeClient::start_with_files(binary, directory, files, timeout)
                .await?,
        ))
    }
    pub fn with_profile(self, id: &str) -> Self {
        Self(self.0.with_profile(id))
    }
    pub fn with_lease(&self, lease_id: Option<&str>) -> Self {
        Self(self.0.with_lease(lease_id))
    }
    pub async fn control(&self, op: &str, tab: &str, args: Value) -> Result<Value> {
        if !matches!(
            op,
            "back"
                | "forward"
                | "reload"
                | "clipboard_read"
                | "clipboard_write"
                | "clipboard_copy"
                | "clipboard_cut"
                | "clipboard_paste"
                | "save_screenshot"
                | "record_start"
                | "record_stop"
                | "record_status"
        ) {
            return Err(Error::Invalid("Unknown browser control".into()));
        }
        {
            let browser = &self.0;
            browser.request(op, Some(tab), args, false).await
        }
    }
    pub async fn status(&self) -> Status {
        {
            let browser = &self.0;
            let status = browser.request("status", None, Value::Null, false).await;
            Status {
                owner: Owner::Agent,
                uncertain: browser.uncertain()
                    || status
                        .map(|value| value["uncertain"].as_bool().unwrap_or(true))
                        .unwrap_or(true),
            }
        }
    }
    pub async fn close(&self) -> Result<()> {
        {
            let browser = &self.0;
            browser.close().await
        }
    }
    pub async fn set_owner(&self, owner: Owner) {
        {
            let browser = &self.0;
            if let Ok(tabs) = browser.request("tabs", None, Value::Null, true).await {
                for tab in tabs.as_array().into_iter().flatten() {
                    if let Some(id) = tab["id"].as_str() {
                        let _ = browser
                            .request(
                                if owner == Owner::Human {
                                    "take"
                                } else {
                                    "return"
                                },
                                Some(id),
                                Value::Null,
                                true,
                            )
                            .await;
                    }
                }
            }
        }
    }
    /// Managed file operations are available only with the embedded engine.
    pub async fn file_action(&self, op: &str, tab: Option<&str>, args: Value) -> Result<Value> {
        if !matches!(
            op,
            "files"
                | "read_file"
                | "stage_file"
                | "delete_file"
                | "upload"
                | "download"
                | "choose_files"
        ) {
            return Err(Error::Invalid("Unknown file action".into()));
        }
        {
            let browser = &self.0;
            browser.request(op, tab, args, false).await
        }
    }
    pub async fn human_action(&self, op: &str, tab: Option<&str>, args: Value) -> Result<Value> {
        if !matches!(
            op,
            "handoff_status"
                | "extensions"
                | "extension_set_enabled"
                | "extension_remove"
                | "extension_options"
                | "extension_installs"
                | "extension_install_decide"
                | "handoff_ack"
                | "handoff_cancel"
                | "tabs"
                | "open"
                | "view"
                | "take"
                | "return"
                | "navigate"
                | "back"
                | "forward"
                | "reload"
                | "clipboard_read"
                | "clipboard_write"
                | "clipboard_copy"
                | "clipboard_cut"
                | "clipboard_paste"
                | "save_screenshot"
                | "record_start"
                | "record_stop"
                | "record_status"
                | "close"
                | "screenshot"
                | "input"
                | "scroll"
                | "resize"
                | "health"
                | "files"
                | "read_file"
                | "stage_file"
                | "delete_file"
                | "choose_files"
                | "download"
        ) {
            return Err(Error::Invalid("Unknown host action".into()));
        }
        {
            let browser = &self.0;
            browser.request(op, tab, args, true).await
        }
    }
    pub async fn reserve(&self, tab: &str, task: &str, ttl_ms: u64) -> Result<Lease> {
        {
            let browser = &self.0;
            Ok(serde_json::from_value(
                browser
                    .request(
                        "reserve",
                        Some(tab),
                        json!({"task":task,"ttlMs":ttl_ms}),
                        false,
                    )
                    .await?,
            )?)
        }
    }
    pub async fn reserve_named(
        &self,
        tab: &str,
        task: &str,
        agent_name: &str,
        ttl_ms: u64,
    ) -> Result<Lease> {
        {
            let browser = &self.0;
            Ok(serde_json::from_value(
                browser
                    .request(
                        "reserve",
                        Some(tab),
                        json!({"task":task,"agentName":agent_name,"ttlMs":ttl_ms}),
                        false,
                    )
                    .await?,
            )?)
        }
    }
    pub async fn renew(&self, tab: &str, lease_id: &str, ttl_ms: u64) -> Result<Lease> {
        {
            let browser = &self.0;
            Ok(serde_json::from_value(
                browser
                    .with_lease(Some(lease_id))
                    .request("renew", Some(tab), json!({"ttlMs":ttl_ms}), false)
                    .await?,
            )?)
        }
    }
    pub async fn release(&self, tab: &str, lease_id: &str) -> Result<()> {
        {
            let browser = &self.0;
            browser
                .with_lease(Some(lease_id))
                .request("release", Some(tab), Value::Null, false)
                .await?;
            Ok(())
        }
    }
    pub async fn tabs(&self) -> Result<Vec<Tab>> {
        {
            let browser = &self.0;
            Ok(serde_json::from_value(
                browser.request("tabs", None, Value::Null, false).await?,
            )?)
        }
    }
    pub async fn open_tab(&self) -> Result<String> {
        {
            let browser = &self.0;
            Ok(serde_json::from_value(
                browser.request("open", None, Value::Null, false).await?,
            )?)
        }
    }
    pub async fn select_tab(&self, tab: &str) -> Result<()> {
        {
            let browser = &self.0;
            browser
                .request("select", Some(tab), Value::Null, false)
                .await?;
            Ok(())
        }
    }
    pub async fn close_tab(&self, tab: &str) -> Result<()> {
        {
            let browser = &self.0;
            browser
                .request("close", Some(tab), Value::Null, false)
                .await?;
            Ok(())
        }
    }
    pub async fn navigate(&self, tab: &str, url: &str) -> Result<()> {
        {
            let browser = &self.0;
            browser
                .request("navigate", Some(tab), json!({"url":url}), false)
                .await?;
            Ok(())
        }
    }
    pub async fn snapshot(&self, tab: &str, max_elements: usize) -> Result<Snapshot> {
        {
            let browser = &self.0;
            Ok(serde_json::from_value(
                browser
                    .request(
                        "snapshot",
                        Some(tab),
                        json!({"maxElements":max_elements}),
                        false,
                    )
                    .await?,
            )?)
        }
    }
    pub async fn click(&self, tab: &str, reference: &str) -> Result<()> {
        {
            let browser = &self.0;
            browser
                .request("click", Some(tab), json!({"reference":reference}), false)
                .await?;
            Ok(())
        }
    }
    pub async fn fill(&self, tab: &str, reference: &str, text: &str) -> Result<()> {
        {
            let browser = &self.0;
            browser
                .request(
                    "fill",
                    Some(tab),
                    json!({"reference":reference,"text":text}),
                    false,
                )
                .await?;
            Ok(())
        }
    }
    pub async fn press(&self, tab: &str, reference: &str, key: &str) -> Result<()> {
        {
            let browser = &self.0;
            browser
                .request(
                    "press",
                    Some(tab),
                    json!({"reference":reference,"key":key}),
                    false,
                )
                .await?;
            Ok(())
        }
    }
    pub async fn scroll(&self, tab: &str, x: i32, y: i32) -> Result<Value> {
        {
            let browser = &self.0;
            browser
                .request("scroll", Some(tab), json!({"x":x,"y":y}), false)
                .await
        }
    }
    pub async fn evaluate(&self, tab: &str, script: &str) -> Result<Value> {
        {
            let browser = &self.0;
            browser
                .request("evaluate", Some(tab), json!({"script":script}), false)
                .await
        }
    }
    pub async fn session_health(&self, tab: &str, policy: &HealthPolicy) -> Result<SessionHealth> {
        {
            let browser = &self.0;
            Ok(serde_json::from_value(
                browser
                    .request("health", Some(tab), serde_json::to_value(policy)?, false)
                    .await?,
            )?)
        }
    }
    pub async fn screenshot(&self, tab: &str) -> Result<String> {
        {
            let browser = &self.0;
            Ok(serde_json::from_value(
                browser
                    .request("screenshot", Some(tab), Value::Null, false)
                    .await?,
            )?)
        }
    }
}
