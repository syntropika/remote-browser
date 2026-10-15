//! Session health uses explicit service evidence and never exposes cookie values.
use serde::{Deserialize, Serialize};

use crate::{Error, Result};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HealthPolicy {
    pub origin: String,
    pub cookie_names: Vec<String>,
    pub authenticated_selector: Option<String>,
    pub login_selector: Option<String>,
    #[serde(default = "default_warning")]
    pub warning_seconds: u64,
}

pub fn default_warning() -> u64 {
    86_400
}

impl HealthPolicy {
    pub fn validate(&self) -> Result<()> {
        let origin = reqwest::Url::parse(&self.origin)
            .map_err(|_| Error::Invalid("Invalid service origin".into()))?;
        if !matches!(origin.scheme(), "http" | "https")
            || !origin.username().is_empty()
            || origin.password().is_some()
            || origin.query().is_some()
            || origin.fragment().is_some()
            || origin.path() != "/"
            || origin.origin().ascii_serialization() == "null"
        {
            return Err(Error::Invalid(
                "Use an HTTP(S) service origin without credentials, path, query or fragment".into(),
            ));
        }
        if self.cookie_names.len() > 16
            || self.cookie_names.iter().any(|name| {
                name.is_empty() || name.len() > 256 || name.chars().any(char::is_control)
            })
        {
            return Err(Error::Invalid("Provide at most 16 authentication cookie names, each containing 1 to 256 characters".into()));
        }
        for selector in [&self.authenticated_selector, &self.login_selector]
            .into_iter()
            .flatten()
        {
            if selector.is_empty() || selector.len() > 2048 {
                return Err(Error::Invalid(
                    "Health selectors must contain 1 to 2048 bytes".into(),
                ));
            }
        }
        if self.warning_seconds > 2_592_000 {
            return Err(Error::Invalid(
                "warningSeconds must be at most 30 days".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Deserialize)]
pub struct CookieMetadata {
    pub name: String,
    pub expiry: Option<u64>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    pub authenticated: bool,
    pub login_required: bool,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HealthState {
    Active,
    Expiring,
    ReauthRequired,
    Unknown,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHealth {
    pub state: HealthState,
    pub checked_at: u64,
    pub credential_expires_at: Option<u64>,
    pub seconds_remaining: Option<u64>,
    pub evidence: String,
}

pub fn assess(
    policy: &HealthPolicy,
    cookies: &[CookieMetadata],
    evidence: Evidence,
    now_seconds: u64,
) -> SessionHealth {
    let matches: Vec<_> = cookies
        .iter()
        .filter(|cookie| policy.cookie_names.contains(&cookie.name))
        .collect();
    let all_present = policy
        .cookie_names
        .iter()
        .all(|name| matches.iter().any(|cookie| &cookie.name == name));
    let expires = matches.iter().filter_map(|cookie| cookie.expiry).min();
    let remaining = expires.map(|deadline| deadline.saturating_sub(now_seconds));
    let (state, reason) = if evidence.authenticated && evidence.login_required {
        (HealthState::Unknown, "Conflicting service markers")
    } else if evidence.login_required {
        (
            HealthState::ReauthRequired,
            "Configured sign-in marker is visible",
        )
    } else if evidence.authenticated
        && all_present
        && remaining.is_some_and(|seconds| seconds <= policy.warning_seconds)
    {
        (
            HealthState::Expiring,
            "Authenticated marker is visible; a configured credential expiry is near",
        )
    } else if evidence.authenticated {
        (
            HealthState::Active,
            "Configured authenticated marker is visible",
        )
    } else if all_present && remaining.is_some_and(|seconds| seconds <= policy.warning_seconds) {
        (
            HealthState::Expiring,
            "A configured credential expiry is near; authentication is unverified",
        )
    } else {
        (
            HealthState::Unknown,
            "No conclusive authentication marker; cookie expiry is not session validity",
        )
    };
    SessionHealth {
        state,
        checked_at: now_seconds * 1000,
        credential_expires_at: expires.map(|seconds| seconds.saturating_mul(1000)),
        seconds_remaining: remaining,
        evidence: reason.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn policy() -> HealthPolicy {
        HealthPolicy {
            origin: "https://example.com".into(),
            cookie_names: vec!["auth".into()],
            authenticated_selector: None,
            login_selector: None,
            warning_seconds: 60,
        }
    }
    fn cookie(name: &str, expiry: Option<u64>) -> CookieMetadata {
        CookieMetadata {
            name: name.into(),
            expiry,
        }
    }
    #[test]
    fn unrelated_cookie_expiry_is_ignored_and_dates_do_not_prove_login() {
        let status = assess(
            &policy(),
            &[cookie("analytics", Some(101)), cookie("auth", Some(1000))],
            Evidence::default(),
            100,
        );
        assert_eq!(status.state, HealthState::Unknown);
        assert_eq!(status.credential_expires_at, Some(1_000_000));
    }
    #[test]
    fn distinguishes_known_expiry_reauth_and_session_cookies() {
        assert_eq!(
            assess(
                &policy(),
                &[cookie("auth", Some(120))],
                Evidence::default(),
                100
            )
            .state,
            HealthState::Expiring
        );
        let active = assess(
            &policy(),
            &[cookie("auth", None)],
            Evidence {
                authenticated: true,
                login_required: false,
            },
            100,
        );
        assert_eq!(active.state, HealthState::Active);
        assert_eq!(active.credential_expires_at, None);
        assert_eq!(
            assess(
                &policy(),
                &[],
                Evidence {
                    authenticated: false,
                    login_required: true
                },
                100
            )
            .state,
            HealthState::ReauthRequired
        );
        assert_eq!(
            assess(
                &policy(),
                &[],
                Evidence {
                    authenticated: true,
                    login_required: true
                },
                100
            )
            .state,
            HealthState::Unknown
        );
    }
    #[test]
    fn cookie_values_never_reach_health_output() {
        let metadata: CookieMetadata = serde_json::from_value(
            serde_json::json!({"name":"auth","value":"secret","expiry":120,"httpOnly":true}),
        )
        .unwrap();
        let status = assess(&policy(), &[metadata], Evidence::default(), 100);
        assert!(!serde_json::to_string(&status).unwrap().contains("secret"));
    }
}
