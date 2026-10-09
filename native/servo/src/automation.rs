//! Engine-independent browser operations exposed to the host and MCP.
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64::{Engine, engine::general_purpose::STANDARD};
use reqwest::{Method, Url};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::{
    Error, Result,
    health::{CookieMetadata, Evidence, HealthPolicy, SessionHealth},
    reservations::{Lease, ReservationInfo, Reservations},
    webdriver::{ELEMENT_KEY, WebDriver},
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

#[derive(Deserialize)]
struct WireElement {
    element: Value,
    role: String,
    name: String,
    tag: String,
    r#type: Option<String>,
    disabled: bool,
}

#[derive(Deserialize)]
struct WireSnapshot {
    url: String,
    title: String,
    text: String,
    truncated: bool,
    elements: Vec<WireElement>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Tab {
    pub id: String,
    pub active: bool,
    pub owned: bool,
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

struct State {
    driver: WebDriver,
    owner: Owner,
    generation: u64,
    references: HashMap<String, HashMap<String, String>>,
    reservations: Reservations,
    owned_tabs: HashSet<String>,
}

/// Clones share one session and one operation lock. Overlapping operations fail as busy.
#[derive(Clone)]
struct WebDriverAutomation {
    state: Arc<Mutex<State>>,
    lease_id: Option<String>,
}

impl WebDriverAutomation {
    pub async fn connect(endpoint: &str, timeout: Duration) -> Result<Self> {
        let driver = WebDriver::connect(endpoint, timeout).await?;
        Ok(Self {
            state: Arc::new(Mutex::new(State {
                driver,
                owner: Owner::Agent,
                generation: 0,
                references: HashMap::new(),
                reservations: Reservations::default(),
                owned_tabs: HashSet::new(),
            })),
            lease_id: None,
        })
    }

    /// Bind a cooperative reservation token to this handle without mutating other handles.
    pub fn with_lease(&self, lease_id: Option<&str>) -> Self {
        Self {
            state: self.state.clone(),
            lease_id: lease_id.map(str::to_owned),
        }
    }

    pub async fn reserve(&self, tab: &str, task: &str, ttl_ms: u64) -> Result<Lease> {
        let mut state = self.state.try_lock().map_err(|_| Error::Busy)?;
        state.check()?;
        let handles: Vec<String> = serde_json::from_value(
            state
                .driver
                .command(Method::GET, &["window", "handles"], None)
                .await?,
        )?;
        if !handles.iter().any(|id| id == tab) {
            return Err(Error::Invalid("Unknown tab".into()));
        }
        state
            .reservations
            .reserve(tab, task, ttl_ms, Instant::now())
    }

    pub async fn renew(&self, tab: &str, lease_id: &str, ttl_ms: u64) -> Result<Lease> {
        let mut state = self.state.try_lock().map_err(|_| Error::Busy)?;
        state.check()?;
        state
            .reservations
            .renew(tab, lease_id, ttl_ms, Instant::now())
    }

    pub async fn release(&self, tab: &str, lease_id: &str) -> Result<()> {
        let mut state = self.state.try_lock().map_err(|_| Error::Busy)?;
        state.check()?;
        state.reservations.release(tab, lease_id, Instant::now())
    }

    pub async fn status(&self) -> Status {
        let state = self.state.lock().await;
        Status {
            owner: state.owner,
            uncertain: state.driver.is_uncertain(),
        }
    }

    /// Host-only control handoff; it waits for the current operation before changing ownership.
    /// The MCP catalog deliberately does not allow an agent to override human control.
    pub async fn set_owner(&self, owner: Owner) {
        let mut state = self.state.lock().await;
        state.owner = owner;
        state.references.clear();
    }

    pub async fn close(&self) -> Result<()> {
        let state = self.state.lock().await;
        state.driver.close().await
    }

    pub async fn tabs(&self) -> Result<Vec<Tab>> {
        let mut state = self.state.try_lock().map_err(|_| Error::Busy)?;
        state.check()?;
        let current = state.current_tab().await?;
        let handles: Vec<String> = serde_json::from_value(
            state
                .driver
                .command(Method::GET, &["window", "handles"], None)
                .await?,
        )?;
        Ok(handles
            .into_iter()
            .map(|id| Tab {
                active: current.as_deref() == Some(id.as_str()),
                owned: state.owned_tabs.contains(&id),
                reservation: state.reservations.info(&id, Instant::now()),
                title: None,
                url: None,
                owner: Some(state.owner),
                busy: false,
                uncertain: false,
                id,
            })
            .collect())
    }

    pub async fn open_tab(&self) -> Result<String> {
        let mut state = self.state.try_lock().map_err(|_| Error::Busy)?;
        state.check()?;
        let value = state
            .driver
            .command(
                Method::POST,
                &["window", "new"],
                Some(json!({"type":"tab"})),
            )
            .await?;
        let handle = string(&value["handle"], "window handle")?;
        state.owned_tabs.insert(handle.clone());
        state
            .driver
            .command(Method::POST, &["window"], Some(json!({"handle":handle})))
            .await?;
        Ok(handle)
    }

    pub async fn select_tab(&self, tab: &str) -> Result<()> {
        let mut state = self.state.try_lock().map_err(|_| Error::Busy)?;
        state.check()?;
        state
            .reservations
            .check(tab, self.lease_id.as_deref(), Instant::now())?;
        state
            .driver
            .command(Method::POST, &["window"], Some(json!({"handle":tab})))
            .await?;
        Ok(())
    }

    pub async fn close_tab(&self, tab: &str) -> Result<()> {
        let mut state = self.state.try_lock().map_err(|_| Error::Busy)?;
        state.check()?;
        if !state.owned_tabs.contains(tab) {
            return Err(Error::Invalid(
                "Only tabs created by this API can be closed".into(),
            ));
        }
        state.bind_tab(tab, self.lease_id.as_deref()).await?;
        state.invalidate_tab(tab);
        state
            .driver
            .command(Method::DELETE, &["window"], None)
            .await?;
        state.owned_tabs.remove(tab);
        state.reservations.remove(tab);
        Ok(())
    }

    pub async fn navigate(&self, tab: &str, url: &str) -> Result<()> {
        let parsed = Url::parse(url).map_err(|_| Error::Invalid("Invalid page URL".into()))?;
        if !(matches!(parsed.scheme(), "http" | "https") || url == "about:blank")
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            return Err(Error::Invalid(
                "Use an HTTP(S) page URL without credentials, or about:blank".into(),
            ));
        }
        let mut state = self.state.try_lock().map_err(|_| Error::Busy)?;
        state.check()?;
        state.bind_tab(tab, self.lease_id.as_deref()).await?;
        state.invalidate_tab(tab);
        state
            .driver
            .command(Method::POST, &["url"], Some(json!({"url":url})))
            .await?;
        Ok(())
    }

    pub async fn snapshot(&self, tab: &str, max_elements: usize) -> Result<Snapshot> {
        if !(1..=120).contains(&max_elements) {
            return Err(Error::Invalid(
                "maxElements must be between 1 and 120".into(),
            ));
        }
        let mut state = self.state.try_lock().map_err(|_| Error::Busy)?;
        state.check()?;
        state.bind_tab(tab, self.lease_id.as_deref()).await?;
        state.invalidate_tab(tab);
        let value = state
            .driver
            .evaluate(crate::snapshot::SCRIPT, vec![json!(max_elements)])
            .await?;
        let snapshot: WireSnapshot = serde_json::from_value(value)?;
        let mut elements = Vec::new();
        let mut references = HashMap::new();
        for (index, item) in snapshot.elements.into_iter().enumerate() {
            let id = string(&item.element[ELEMENT_KEY], "element identity")?;
            let reference = format!("s{}e{}", state.generation, index + 1);
            references.insert(reference.clone(), id);
            elements.push(Element {
                reference,
                role: item.role,
                name: item.name,
                tag: item.tag,
                r#type: item.r#type,
                disabled: item.disabled,
            });
        }
        state.references.insert(tab.into(), references);
        Ok(Snapshot {
            tab_id: tab.into(),
            url: snapshot.url,
            title: snapshot.title,
            text: snapshot.text,
            truncated: snapshot.truncated,
            elements,
        })
    }

    pub async fn click(&self, tab: &str, reference: &str) -> Result<()> {
        let mut state = self.state.try_lock().map_err(|_| Error::Busy)?;
        state.check()?;
        state.bind_tab(tab, self.lease_id.as_deref()).await?;
        let id = state.reference(tab, reference)?;
        state
            .driver
            .command(Method::POST, &["element", id, "click"], Some(json!({})))
            .await?;
        Ok(())
    }

    pub async fn fill(&self, tab: &str, reference: &str, text: &str) -> Result<()> {
        if text.chars().count() > 8192 {
            return Err(Error::Invalid("Text exceeds 8192 characters".into()));
        }
        let mut state = self.state.try_lock().map_err(|_| Error::Busy)?;
        state.check()?;
        state.bind_tab(tab, self.lease_id.as_deref()).await?;
        let id = state.reference(tab, reference)?;
        state
            .driver
            .command(Method::POST, &["element", id, "clear"], Some(json!({})))
            .await?;
        state
            .driver
            .command(
                Method::POST,
                &["element", id, "value"],
                Some(json!({"text":text})),
            )
            .await?;
        Ok(())
    }

    pub async fn press(&self, tab: &str, reference: &str, key: &str) -> Result<()> {
        let key = match key {
            "Enter" => "\u{e007}",
            "Tab" => "\u{e004}",
            "Escape" => "\u{e00c}",
            "Backspace" => "\u{e003}",
            "ArrowLeft" => "\u{e012}",
            "ArrowUp" => "\u{e013}",
            "ArrowRight" => "\u{e014}",
            "ArrowDown" => "\u{e015}",
            _ => return Err(Error::Invalid("Unsupported key".into())),
        };
        let mut state = self.state.try_lock().map_err(|_| Error::Busy)?;
        state.check()?;
        state.bind_tab(tab, self.lease_id.as_deref()).await?;
        let id = state.reference(tab, reference)?;
        state
            .driver
            .command(
                Method::POST,
                &["element", id, "value"],
                Some(json!({"text":key})),
            )
            .await?;
        Ok(())
    }

    pub async fn scroll(&self, tab: &str, x: i32, y: i32) -> Result<Value> {
        if x.unsigned_abs() > 10_000 || y.unsigned_abs() > 10_000 {
            return Err(Error::Invalid(
                "Scroll deltas must be within 10000 pixels".into(),
            ));
        }
        let mut state = self.state.try_lock().map_err(|_| Error::Busy)?;
        state.check()?;
        state.bind_tab(tab, self.lease_id.as_deref()).await?;
        state
            .driver
            .evaluate(
                "window.scrollBy(arguments[0], arguments[1]); return {x:scrollX,y:scrollY};",
                vec![json!(x), json!(y)],
            )
            .await
    }

    /// Trusted page JavaScript, not server code. Returns JSON; invalidates previous references.
    pub async fn evaluate(&self, tab: &str, script: &str) -> Result<Value> {
        if script.is_empty() || script.len() > 32768 {
            return Err(Error::Invalid(
                "Script must contain 1 to 32768 bytes".into(),
            ));
        }
        let mut state = self.state.try_lock().map_err(|_| Error::Busy)?;
        state.check()?;
        state.bind_tab(tab, self.lease_id.as_deref()).await?;
        state.invalidate_tab(tab);
        let value = state.driver.evaluate(script, vec![]).await?;
        if serde_json::to_vec(&value)?.len() > 32768 {
            return Err(Error::Invalid(
                "Script result exceeds 32 KiB; return less data".into(),
            ));
        }
        Ok(value)
    }

    pub async fn session_health(&self, tab: &str, policy: &HealthPolicy) -> Result<SessionHealth> {
        policy.validate()?;
        let mut state = self.state.try_lock().map_err(|_| Error::Busy)?;
        state.check()?;
        state.bind_tab(tab, self.lease_id.as_deref()).await?;
        let url = string(
            &state.driver.command(Method::GET, &["url"], None).await?,
            "current URL",
        )?;
        let current =
            Url::parse(&url).map_err(|_| Error::Protocol("Invalid current page URL".into()))?;
        let expected = Url::parse(&policy.origin)
            .map_err(|_| Error::Invalid("Invalid service origin".into()))?;
        if current.origin() != expected.origin() {
            return Err(Error::Invalid(
                "Open a page on the configured service origin before checking session health"
                    .into(),
            ));
        }
        let cookies: Vec<CookieMetadata> =
            serde_json::from_value(state.driver.command(Method::GET, &["cookie"], None).await?)?;
        let evidence: Evidence = serde_json::from_value(state.driver.evaluate(
            "const visible=s=>s&&Array.from(document.querySelectorAll(s)).some(e=>{const c=getComputedStyle(e);return c.display!=='none'&&c.visibility!=='hidden'&&e.getClientRects().length>0});return {authenticated:!!visible(arguments[0]),loginRequired:!!visible(arguments[1])};",
            vec![json!(policy.authenticated_selector), json!(policy.login_selector)],
        ).await?)?;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| Error::Protocol("System clock is before the Unix epoch".into()))?
            .as_secs();
        Ok(crate::health::assess(policy, &cookies, evidence, now))
    }

    pub async fn screenshot(&self, tab: &str) -> Result<String> {
        let mut state = self.state.try_lock().map_err(|_| Error::Busy)?;
        state.check()?;
        state.bind_tab(tab, self.lease_id.as_deref()).await?;
        let encoded = string(
            &state
                .driver
                .command(Method::GET, &["screenshot"], None)
                .await?,
            "screenshot",
        )?;
        if encoded.len() > 6 * 1024 * 1024 {
            return Err(Error::Invalid(
                "Screenshot exceeds the MCP image limit".into(),
            ));
        }
        let bytes = STANDARD
            .decode(&encoded)
            .map_err(|_| Error::Protocol("Invalid base64 screenshot".into()))?;
        if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            return Err(Error::Protocol(
                "Servo did not return a PNG screenshot".into(),
            ));
        }
        Ok(encoded)
    }
}

impl State {
    fn check(&self) -> Result<()> {
        if self.owner == Owner::Human {
            return Err(Error::HumanControl);
        }
        if self.driver.is_uncertain() {
            return Err(Error::Uncertain);
        }
        Ok(())
    }

    fn invalidate_tab(&mut self, tab: &str) {
        self.generation += 1;
        self.references.remove(tab);
    }

    async fn current_tab(&self) -> Result<Option<String>> {
        match self.driver.command(Method::GET, &["window"], None).await {
            Ok(value) => string(&value, "current window").map(Some),
            Err(Error::WebDriver { code, .. }) if code == "no such window" => Ok(None),
            Err(error) => Err(error),
        }
    }

    async fn bind_tab(&mut self, tab: &str, lease_id: Option<&str>) -> Result<()> {
        self.reservations.check(tab, lease_id, Instant::now())?;
        if self.current_tab().await?.as_deref() != Some(tab) {
            self.driver
                .command(Method::POST, &["window"], Some(json!({"handle":tab})))
                .await?;
        }
        Ok(())
    }

    fn reference(&self, tab: &str, reference: &str) -> Result<&str> {
        self.references
            .get(tab)
            .and_then(|refs| refs.get(reference))
            .map(String::as_str)
            .ok_or_else(|| {
                Error::Invalid(
                    "Unknown or expired reference. Take a fresh snapshot of this tab".into(),
                )
            })
    }
}

fn string(value: &Value, name: &str) -> Result<String> {
    value
        .as_str()
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| Error::Protocol(format!("Missing {name} in Servo response")))
}

#[derive(Clone)]
pub struct Automation(Backend);
#[derive(Clone)]
enum Backend {
    WebDriver(WebDriverAutomation),
    Native(crate::native::NativeClient),
}
impl Automation {
    pub async fn connect(endpoint: &str, timeout: Duration) -> Result<Self> {
        Ok(Self(Backend::WebDriver(
            WebDriverAutomation::connect(endpoint, timeout).await?,
        )))
    }
    pub async fn embedded(
        binary: &std::path::Path,
        directory: &std::path::Path,
        timeout: Duration,
    ) -> Result<Self> {
        Ok(Self(Backend::Native(
            crate::native::NativeClient::start(binary, directory, timeout).await?,
        )))
    }
    pub fn is_embedded(&self) -> bool {
        matches!(self.0, Backend::Native(_))
    }
    pub fn with_lease(&self, lease_id: Option<&str>) -> Self {
        Self(match &self.0 {
            Backend::WebDriver(browser) => Backend::WebDriver(browser.with_lease(lease_id)),
            Backend::Native(browser) => Backend::Native(browser.with_lease(lease_id)),
        })
    }
    pub async fn status(&self) -> Status {
        match &self.0 {
            Backend::WebDriver(browser) => browser.status().await,
            Backend::Native(browser) => {
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
    }
    pub async fn close(&self) -> Result<()> {
        match &self.0 {
            Backend::WebDriver(browser) => browser.close().await,
            Backend::Native(browser) => browser.close().await,
        }
    }
    pub async fn set_owner(&self, owner: Owner) {
        match &self.0 {
            Backend::WebDriver(browser) => browser.set_owner(owner).await,
            Backend::Native(browser) => {
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
    }
    pub async fn human_action(&self, op: &str, tab: Option<&str>, args: Value) -> Result<Value> {
        if !matches!(
            op,
            "tabs"
                | "open"
                | "view"
                | "take"
                | "return"
                | "navigate"
                | "close"
                | "screenshot"
                | "input"
                | "scroll"
                | "health"
        ) {
            return Err(Error::Invalid("Unknown host action".into()));
        }
        match &self.0 {
            Backend::Native(browser) => browser.request(op, tab, args, true).await,
            Backend::WebDriver(_) => Err(Error::Invalid(
                "Per-tab host control requires the embedded engine".into(),
            )),
        }
    }
    pub async fn reserve(&self, tab: &str, task: &str, ttl_ms: u64) -> Result<Lease> {
        match &self.0 {
            Backend::WebDriver(browser) => browser.reserve(tab, task, ttl_ms).await,
            Backend::Native(browser) => Ok(serde_json::from_value(
                browser
                    .request(
                        "reserve",
                        Some(tab),
                        json!({"task":task,"ttlMs":ttl_ms}),
                        false,
                    )
                    .await?,
            )?),
        }
    }
    pub async fn renew(&self, tab: &str, lease_id: &str, ttl_ms: u64) -> Result<Lease> {
        match &self.0 {
            Backend::WebDriver(browser) => browser.renew(tab, lease_id, ttl_ms).await,
            Backend::Native(browser) => Ok(serde_json::from_value(
                browser
                    .with_lease(Some(lease_id))
                    .request("renew", Some(tab), json!({"ttlMs":ttl_ms}), false)
                    .await?,
            )?),
        }
    }
    pub async fn release(&self, tab: &str, lease_id: &str) -> Result<()> {
        match &self.0 {
            Backend::WebDriver(browser) => browser.release(tab, lease_id).await,
            Backend::Native(browser) => {
                browser
                    .with_lease(Some(lease_id))
                    .request("release", Some(tab), Value::Null, false)
                    .await?;
                Ok(())
            }
        }
    }
    pub async fn tabs(&self) -> Result<Vec<Tab>> {
        match &self.0 {
            Backend::WebDriver(browser) => browser.tabs().await,
            Backend::Native(browser) => Ok(serde_json::from_value(
                browser.request("tabs", None, Value::Null, false).await?,
            )?),
        }
    }
    pub async fn open_tab(&self) -> Result<String> {
        match &self.0 {
            Backend::WebDriver(browser) => browser.open_tab().await,
            Backend::Native(browser) => Ok(serde_json::from_value(
                browser.request("open", None, Value::Null, false).await?,
            )?),
        }
    }
    pub async fn select_tab(&self, tab: &str) -> Result<()> {
        match &self.0 {
            Backend::WebDriver(browser) => browser.select_tab(tab).await,
            Backend::Native(browser) => {
                browser
                    .request("select", Some(tab), Value::Null, false)
                    .await?;
                Ok(())
            }
        }
    }
    pub async fn close_tab(&self, tab: &str) -> Result<()> {
        match &self.0 {
            Backend::WebDriver(browser) => browser.close_tab(tab).await,
            Backend::Native(browser) => {
                browser
                    .request("close", Some(tab), Value::Null, false)
                    .await?;
                Ok(())
            }
        }
    }
    pub async fn navigate(&self, tab: &str, url: &str) -> Result<()> {
        match &self.0 {
            Backend::WebDriver(browser) => browser.navigate(tab, url).await,
            Backend::Native(browser) => {
                browser
                    .request("navigate", Some(tab), json!({"url":url}), false)
                    .await?;
                Ok(())
            }
        }
    }
    pub async fn snapshot(&self, tab: &str, max_elements: usize) -> Result<Snapshot> {
        match &self.0 {
            Backend::WebDriver(browser) => browser.snapshot(tab, max_elements).await,
            Backend::Native(browser) => Ok(serde_json::from_value(
                browser
                    .request(
                        "snapshot",
                        Some(tab),
                        json!({"maxElements":max_elements}),
                        false,
                    )
                    .await?,
            )?),
        }
    }
    pub async fn click(&self, tab: &str, reference: &str) -> Result<()> {
        match &self.0 {
            Backend::WebDriver(browser) => browser.click(tab, reference).await,
            Backend::Native(browser) => {
                browser
                    .request("click", Some(tab), json!({"reference":reference}), false)
                    .await?;
                Ok(())
            }
        }
    }
    pub async fn fill(&self, tab: &str, reference: &str, text: &str) -> Result<()> {
        match &self.0 {
            Backend::WebDriver(browser) => browser.fill(tab, reference, text).await,
            Backend::Native(browser) => {
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
    }
    pub async fn press(&self, tab: &str, reference: &str, key: &str) -> Result<()> {
        match &self.0 {
            Backend::WebDriver(browser) => browser.press(tab, reference, key).await,
            Backend::Native(browser) => {
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
    }
    pub async fn scroll(&self, tab: &str, x: i32, y: i32) -> Result<Value> {
        match &self.0 {
            Backend::WebDriver(browser) => browser.scroll(tab, x, y).await,
            Backend::Native(browser) => Ok(browser
                .request("scroll", Some(tab), json!({"x":x,"y":y}), false)
                .await?),
        }
    }
    pub async fn evaluate(&self, tab: &str, script: &str) -> Result<Value> {
        match &self.0 {
            Backend::WebDriver(browser) => browser.evaluate(tab, script).await,
            Backend::Native(browser) => Ok(browser
                .request("evaluate", Some(tab), json!({"script":script}), false)
                .await?),
        }
    }
    pub async fn session_health(&self, tab: &str, policy: &HealthPolicy) -> Result<SessionHealth> {
        match &self.0 {
            Backend::WebDriver(browser) => browser.session_health(tab, policy).await,
            Backend::Native(browser) => Ok(serde_json::from_value(
                browser
                    .request("health", Some(tab), serde_json::to_value(policy)?, false)
                    .await?,
            )?),
        }
    }
    pub async fn screenshot(&self, tab: &str) -> Result<String> {
        match &self.0 {
            Backend::WebDriver(browser) => browser.screenshot(tab).await,
            Backend::Native(browser) => Ok(serde_json::from_value(
                browser
                    .request("screenshot", Some(tab), Value::Null, false)
                    .await?,
            )?),
        }
    }
}
