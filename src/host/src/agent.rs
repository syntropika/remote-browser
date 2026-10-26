//! A reservation-bound page is the common interface for MCP and code mode.
use crate::{Error, Result, automation::Automation, profiles::Profiles};
use base64::{Engine as _, prelude::BASE64_URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Route {
    profile_id: String,
    tab_id: String,
    token: String,
}
impl Route {
    fn encode(&self) -> Result<String> {
        Ok(BASE64_URL_SAFE_NO_PAD.encode(serde_json::to_vec(self)?))
    }
    fn decode(lease: &str) -> Result<Self> {
        if lease.is_empty() || lease.len() > 512 {
            return Err(Error::Invalid("Invalid leaseId".into()));
        }
        let bytes = BASE64_URL_SAFE_NO_PAD
            .decode(lease)
            .map_err(|_| Error::Invalid("Invalid leaseId".into()))?;
        let route: Self =
            serde_json::from_slice(&bytes).map_err(|_| Error::Invalid("Invalid leaseId".into()))?;
        if route.profile_id.is_empty()
            || route.profile_id.len() > 64
            || route.tab_id.is_empty()
            || route.tab_id.len() > 128
            || uuid::Uuid::parse_str(&route.token).is_err()
        {
            return Err(Error::Invalid("Invalid leaseId".into()));
        }
        Ok(route)
    }
}
#[derive(Clone)]
pub(crate) struct Page {
    browser: Automation,
    tab: String,
}
impl Page {
    pub async fn reserve(
        profiles: &Profiles,
        profile: Option<&str>,
        tab: Option<&str>,
        task: &str,
        agent: &str,
    ) -> Result<Value> {
        let profile = profiles.profile_id(profile);
        let browser = profiles.browser(Some(&profile)).await?;
        let lease = browser.reserve_named(tab, task, agent).await?;
        let token = Route {
            profile_id: profile.clone(),
            tab_id: lease.tab_id.clone(),
            token: lease.lease_id,
        }
        .encode()?;
        Ok(
            json!({"leaseId":token,"tabId":lease.tab_id,"profileId":profile,"task":lease.task,"agentName":lease.agent_name}),
        )
    }
    pub async fn from_lease(profiles: &Profiles, lease: &str) -> Result<Self> {
        let route = Route::decode(lease)?;
        let browser = profiles
            .browser(Some(&route.profile_id))
            .await?
            .with_lease(Some(&route.token));
        let page = Self {
            browser,
            tab: route.tab_id,
        };
        page.request("validate_lease", json!({})).await?;
        Ok(page)
    }
    pub async fn request(&self, op: &str, args: Value) -> Result<Value> {
        self.browser.operation(op, &self.tab, args).await
    }
    pub async fn lifecycle(&self, action: &str) -> Result<Value> {
        let op = match action {
            "release" => "release",
            "close" => "close",
            "select" => "select",
            _ => return Err(Error::Invalid("Unknown tab action".into())),
        };
        self.request(op, json!({})).await?;
        Ok(json!({"ok":true}))
    }
    pub async fn execute(&self, action: Action) -> Result<Value> {
        let (op, args) = match action {
            Action::Navigate { url } => {
                bounded(&url, 8192, "url")?;
                ("navigate", json!({"url":url}))
            }
            Action::Back {} => ("back", json!({})),
            Action::Reload {} => ("reload", json!({})),
            Action::Snapshot { max_elements } => {
                if !(1..=120).contains(&max_elements) {
                    return Err(Error::Invalid("maxElements must be from 1 to 120".into()));
                }
                return self
                    .request("snapshot", json!({"maxElements":max_elements}))
                    .await;
            }
            Action::Find { text } => {
                bounded(&text, 2048, "text")?;
                let page = self.request("agent_text", json!({})).await?;
                let body = page.as_str().unwrap_or_default();
                let matches: Vec<_> = body
                    .match_indices(&text)
                    .take(20)
                    .map(|(at, _)| {
                        let before: String = body[..at]
                            .chars()
                            .rev()
                            .take(80)
                            .collect::<Vec<_>>()
                            .into_iter()
                            .rev()
                            .collect();
                        let after: String = body[at..].chars().take(200).collect();
                        format!("{before}{after}")
                    })
                    .collect();
                return Ok(
                    json!({"matches":matches,"truncated":body.len()>=100000 || matches.len()==20}),
                );
            }
            Action::Click { target } => ("agent_click", json!({"target":target.checked()?})),
            Action::Type {
                target,
                text,
                submit,
                slowly,
            } => {
                bounded(&text, 8192, "text")?;
                (
                    "agent_type",
                    json!({"target":target.checked()?,"text":text,"submit":submit,"slowly":slowly}),
                )
            }
            Action::FillForm { fields } => {
                if fields.is_empty() || fields.len() > 32 {
                    return Err(Error::Invalid("Supply 1 to 32 fields".into()));
                }
                for field in &fields {
                    field.target.checked()?;
                    bounded(&field.value, 8192, "value")?;
                }
                for field in fields {
                    self.request(
                        "agent_type",
                        json!({"target":field.target,"text":field.value}),
                    )
                    .await?;
                }
                return Ok(json!({"ok":true}));
            }
            Action::Select { target, values } => {
                if values.is_empty() || values.len() > 32 {
                    return Err(Error::Invalid("Supply 1 to 32 option values".into()));
                }
                for value in &values {
                    bounded(value, 2048, "value")?;
                }
                (
                    "agent_select",
                    json!({"target":target.checked()?,"values":values}),
                )
            }
            Action::Hover { target } => ("agent_hover", json!({"target":target.checked()?})),
            Action::Drag {
                start_target,
                end_target,
            } => (
                "agent_drag",
                json!({"startTarget":start_target.checked()?,"endTarget":end_target.checked()?}),
            ),
            Action::Press { key, target } => {
                if let Some(target) = &target {
                    target.checked()?;
                }
                bounded(&key, 64, "key")?;
                ("agent_press", json!({"key":key,"target":target}))
            }
            Action::Scroll { x, y } => {
                if !(-10000..=10000).contains(&x) || !(-10000..=10000).contains(&y) {
                    return Err(Error::Invalid(
                        "Scroll deltas must be between -10000 and 10000".into(),
                    ));
                }
                ("scroll", json!({"x":x,"y":y}))
            }
            Action::Wait {
                text,
                text_gone,
                timeout_ms,
            } => {
                if !(1..=30000).contains(&timeout_ms) || (text.is_none() && text_gone.is_none()) {
                    return Err(Error::Invalid(
                        "Supply text or textGone and timeoutMs from 1 to 30000".into(),
                    ));
                }
                for value in text.iter().chain(text_gone.iter()) {
                    bounded(value, 2048, "text")?;
                    if value.is_empty() {
                        return Err(Error::Invalid("Wait text cannot be empty".into()));
                    }
                }
                let deadline = Instant::now() + Duration::from_millis(timeout_ms);
                loop {
                    let value = self
                        .request("agent_wait", json!({"text":text,"textGone":text_gone}))
                        .await?;
                    if value.as_bool() == Some(true) {
                        return Ok(json!({"ok":true}));
                    }
                    if Instant::now() >= deadline {
                        return Err(Error::Invalid("Timed out waiting for page text".into()));
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            }
            Action::Dialog {
                accept,
                prompt_text,
            } => {
                if let Some(text) = &prompt_text {
                    bounded(text, 8192, "promptText")?;
                }
                (
                    "agent_dialog",
                    json!({"accept":accept,"promptText":prompt_text}),
                )
            }
            Action::Evaluate { function } => {
                bounded(&function, 32768, "function")?;
                if function.is_empty() {
                    return Err(Error::Invalid("function cannot be empty".into()));
                }
                let value = self
                    .request("agent_evaluate", json!({"function":function}))
                    .await?;
                if serde_json::to_vec(&value)?.len() > 32768 {
                    return Err(Error::Invalid("Evaluation result exceeds 32 KiB".into()));
                }
                return Ok(json!({"value":value}));
            }
            Action::Screenshot { full_page } => {
                return self
                    .request(
                        if full_page {
                            "agent_screenshot"
                        } else {
                            "screenshot"
                        },
                        json!({}),
                    )
                    .await;
            }
            Action::Console { after, limit } => {
                return self
                    .browser
                    .diagnostics(&self.tab, "console", after, limit)
                    .await;
            }
            Action::Network { after, limit } => {
                return self
                    .browser
                    .diagnostics(&self.tab, "network", after, limit)
                    .await;
            }
            Action::Diagnostics { kind, after, limit } => {
                return self
                    .browser
                    .diagnostics(&self.tab, &kind, after, limit)
                    .await;
            }
            Action::Control {
                action,
                name,
                text,
                max_seconds,
            } => {
                if let Some(text) = &text {
                    bounded(text, 8192, "text")?;
                }
                return self
                    .browser
                    .control(
                        &action,
                        &self.tab,
                        json!({"name":name,"text":text,"maxSeconds":max_seconds}),
                    )
                    .await;
            }
            Action::Upload { target, file_ids } => {
                target.checked()?;
                if file_ids.is_empty() || file_ids.len() > 16 {
                    return Err(Error::Invalid("Supply 1 to 16 file IDs".into()));
                }
                return self
                    .request("agent_upload", json!({"target":target,"fileIds":file_ids}))
                    .await;
            }
            Action::Download { url, name } => {
                return self
                    .browser
                    .file_action("download", Some(&self.tab), json!({"url":url,"name":name}))
                    .await;
            }
            Action::Health { policy } => {
                policy.validate()?;
                return Ok(serde_json::to_value(
                    self.browser.session_health(&self.tab, &policy).await?,
                )?);
            }
            Action::Choose { file_ids } => {
                if file_ids.is_empty() || file_ids.len() > 16 {
                    return Err(Error::Invalid("Supply 1 to 16 file IDs".into()));
                }
                return self
                    .browser
                    .file_action("choose_files", Some(&self.tab), json!({"fileIds":file_ids}))
                    .await;
            }
            Action::Cancel {} => {
                return self
                    .browser
                    .file_action("choose_files", Some(&self.tab), json!({"cancel":true}))
                    .await;
            }
        };
        self.request(op, args).await?;
        Ok(json!({"ok":true}))
    }
}
fn bounded(value: &str, max: usize, name: &str) -> Result<()> {
    if value.len() > max {
        return Err(Error::Invalid(format!("{name} exceeds {max} bytes")));
    }
    Ok(())
}
#[derive(Deserialize, Serialize)]
#[serde(untagged)]
pub(crate) enum Target {
    Text(String),
    Role(RoleTarget),
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RoleTarget {
    role: String,
    name: String,
}
impl Target {
    fn checked(&self) -> Result<&Self> {
        match self {
            Self::Text(s) => {
                bounded(s, 2048, "target")?;
                if s.is_empty() {
                    return Err(Error::Invalid("target cannot be empty".into()));
                }
            }
            Self::Role(t) => {
                bounded(&t.role, 64, "role")?;
                bounded(&t.name, 160, "name")?;
            }
        }
        Ok(self)
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Field {
    target: Target,
    value: String,
}
fn elements() -> usize {
    80
}
fn limit() -> usize {
    50
}
fn timeout() -> u64 {
    5000
}
#[derive(Deserialize)]
#[serde(tag = "tool", deny_unknown_fields, rename_all_fields = "camelCase")]
pub(crate) enum Action {
    #[serde(rename = "browser_navigate")]
    Navigate { url: String },
    #[serde(rename = "browser_navigate_back")]
    Back {},
    #[serde(rename = "browser_reload")]
    Reload {},
    #[serde(rename = "browser_snapshot")]
    Snapshot {
        #[serde(default = "elements")]
        max_elements: usize,
    },
    #[serde(rename = "browser_find")]
    Find { text: String },
    #[serde(rename = "browser_click")]
    Click { target: Target },
    #[serde(rename = "browser_type")]
    Type {
        target: Target,
        text: String,
        #[serde(default)]
        submit: bool,
        #[serde(default)]
        slowly: bool,
    },
    #[serde(rename = "browser_fill_form")]
    FillForm { fields: Vec<Field> },
    #[serde(rename = "browser_select_option")]
    Select { target: Target, values: Vec<String> },
    #[serde(rename = "browser_hover")]
    Hover { target: Target },
    #[serde(rename = "browser_drag")]
    Drag {
        start_target: Target,
        end_target: Target,
    },
    #[serde(rename = "browser_press_key")]
    Press { key: String, target: Option<Target> },
    #[serde(rename = "browser_scroll")]
    Scroll {
        #[serde(default)]
        x: i32,
        y: i32,
    },
    #[serde(rename = "browser_wait_for")]
    Wait {
        text: Option<String>,
        text_gone: Option<String>,
        #[serde(default = "timeout")]
        timeout_ms: u64,
    },
    #[serde(rename = "browser_handle_dialog")]
    Dialog {
        accept: bool,
        prompt_text: Option<String>,
    },
    #[serde(rename = "browser_evaluate")]
    Evaluate { function: String },
    #[serde(rename = "browser_take_screenshot")]
    Screenshot {
        #[serde(default)]
        full_page: bool,
    },
    #[serde(rename = "browser_console_messages")]
    Console {
        #[serde(default)]
        after: u64,
        #[serde(default = "limit")]
        limit: usize,
    },
    #[serde(rename = "browser_network_requests")]
    Network {
        #[serde(default)]
        after: u64,
        #[serde(default = "limit")]
        limit: usize,
    },
    #[serde(rename = "browser_diagnostics")]
    Diagnostics {
        kind: String,
        #[serde(default)]
        after: u64,
        #[serde(default = "limit")]
        limit: usize,
    },
    #[serde(rename = "browser_control")]
    Control {
        action: String,
        name: Option<String>,
        text: Option<String>,
        max_seconds: Option<u64>,
    },
    #[serde(rename = "browser_upload")]
    Upload {
        target: Target,
        file_ids: Vec<String>,
    },
    #[serde(rename = "browser_download")]
    Download { url: String, name: String },
    #[serde(rename = "browser_session_health")]
    Health { policy: crate::health::HealthPolicy },
    #[serde(rename = "browser_file_choose")]
    Choose { file_ids: Vec<String> },
    #[serde(rename = "browser_file_cancel")]
    Cancel {},
}
impl Action {
    pub(crate) fn parse(name: &str, mut arguments: Value) -> Result<Self> {
        let args = arguments
            .as_object_mut()
            .ok_or_else(|| Error::Invalid("Arguments must be an object".into()))?;
        if args.contains_key("tool") {
            return Err(Error::Invalid("Unexpected tool argument".into()));
        }
        args.insert("tool".into(), json!(name));
        Ok(serde_json::from_value(arguments)?)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn opaque_routes_preserve_all_identifiers_and_reject_malformed_input() {
        let route = Route {
            profile_id: "account-b".into(),
            tab_id: "tab-3".into(),
            token: uuid::Uuid::new_v4().to_string(),
        };
        let decoded = Route::decode(&route.encode().unwrap()).unwrap();
        assert_eq!(decoded.profile_id, route.profile_id);
        assert_eq!(decoded.tab_id, route.tab_id);
        assert_eq!(decoded.token, route.token);
        for value in ["", "tab-3", "not-a-lease"] {
            assert!(Route::decode(value).is_err());
        }
    }
    #[test]
    fn actions_reject_identity_overrides_and_unknown_arguments() {
        assert!(
            Action::parse("browser_click", json!({"target":"button","tabId":"other"})).is_err()
        );
        assert!(Action::parse("browser_scroll", json!({"y":1,"agentName":"other"})).is_err());
        assert!(Action::parse("browser_click", json!({"target":"button"})).is_ok());
    }
}
