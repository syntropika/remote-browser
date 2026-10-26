//! Assess only configured cookie metadata and visible markers at the policy's origin.
use super::{Engine, Value, json};
use remote_browser_native::health::{CookieMetadata, Evidence, HealthPolicy, assess};

impl Engine {
    pub(super) fn session_health(&mut self, at: usize, args: &Value) -> Result<Value, String> {
        let policy: HealthPolicy = serde_json::from_value(args.clone())
            .map_err(|_| "invalid session health policy".to_string())?;
        policy.validate().map_err(|error| error.to_string())?;
        let origin = url::Url::parse(&policy.origin)
            .map_err(|_| "invalid service origin".to_string())?
            .origin()
            .ascii_serialization();
        let expression = format!(
            r#"(() => {{
                if (location.origin !== {origin}) return {{}};
                const visible = selector => {{
                    if (!selector) return false;
                    const element = document.querySelector(selector);
                    if (!element) return false;
                    const style = getComputedStyle(element);
                    return style.display !== 'none' && style.visibility !== 'hidden'
                        && element.getClientRects().length > 0;
                }};
                return {{authenticated: visible({authenticated}), loginRequired: visible({login})}};
            }})()"#,
            origin = json!(origin),
            authenticated = json!(policy.authenticated_selector),
            login = json!(policy.login_selector),
        );
        let evidence: Evidence =
            serde_json::from_value(self.evaluate(at, &expression, false)?).unwrap_or_default();
        let response = self.protocol(at, "Network.getCookies", json!({"urls": [policy.origin]}))?;
        let cookies: Vec<CookieMetadata> = response["cookies"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|cookie| {
                Some(CookieMetadata {
                    name: cookie["name"].as_str()?.to_owned(),
                    expiry: cookie["expires"]
                        .as_f64()
                        .filter(|expiry| *expiry > 0.0)
                        .map(|expiry| expiry as u64),
                })
            })
            .collect();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "system time is unavailable".to_string())?
            .as_secs();
        serde_json::to_value(assess(&policy, &cookies, evidence, now))
            .map_err(|error| error.to_string())
    }
}
