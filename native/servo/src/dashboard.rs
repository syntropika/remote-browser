//! Loopback dashboard routes human input through the same per-tab ownership checks.
use crate::{Result, health::HealthPolicy, profiles::Profiles};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
#[derive(Clone)]
struct Host {
    profiles: Profiles,
    token: String,
    origin: String,
}
type Reply = std::result::Result<Json<Value>, DashboardError>;
#[derive(Debug)]
struct DashboardError(StatusCode, String);
impl IntoResponse for DashboardError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error":self.1}))).into_response()
    }
}
fn authorize(host: &Host, headers: &HeaderMap) -> std::result::Result<(), DashboardError> {
    if headers.get("authorization").and_then(|h| h.to_str().ok())
        != Some(format!("Bearer {}", host.token).as_str())
    {
        return Err(DashboardError(
            StatusCode::UNAUTHORIZED,
            "Dashboard authorization required".into(),
        ));
    }
    if let Some(origin) = headers.get("origin")
        && origin.to_str().ok() != Some(host.origin.as_str())
    {
        return Err(DashboardError(
            StatusCode::FORBIDDEN,
            "Unexpected dashboard origin".into(),
        ));
    }
    Ok(())
}
fn failure(error: impl ToString) -> DashboardError {
    DashboardError(StatusCode::CONFLICT, error.to_string())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Action {
    profile_id: String,
    op: String,
    tab_id: Option<String>,
    #[serde(default)]
    args: Value,
}
async fn action(State(host): State<Host>, headers: HeaderMap, Json(input): Json<Action>) -> Reply {
    authorize(&host, &headers)?;
    let browser = host
        .profiles
        .browser(Some(&input.profile_id))
        .await
        .map_err(failure)?;
    browser
        .human_action(&input.op, input.tab_id.as_deref(), input.args)
        .await
        .map(Json)
        .map_err(failure)
}
async fn list_profiles(State(host): State<Host>, headers: HeaderMap) -> Reply {
    authorize(&host, &headers)?;
    Ok(Json(json!({"profiles":host.profiles.list().await})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Create {
    name: String,
}
async fn create(State(host): State<Host>, headers: HeaderMap, Json(input): Json<Create>) -> Reply {
    authorize(&host, &headers)?;
    host.profiles
        .create(&input.name)
        .await
        .map(|profile| Json(json!(profile)))
        .map_err(failure)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Policies {
    profile_id: String,
    policy: Option<HealthPolicy>,
}
async fn policies(
    State(host): State<Host>,
    headers: HeaderMap,
    Json(input): Json<Policies>,
) -> Reply {
    authorize(&host, &headers)?;
    if let Some(policy) = input.policy {
        host.profiles
            .save_policy(&input.profile_id, policy)
            .await
            .map_err(failure)?;
    }
    Ok(Json(
        json!({"policies":host.profiles.policies(&input.profile_id).await.map_err(failure)?}),
    ))
}
async fn index() -> impl IntoResponse {
    let mut response = Html(include_str!("../ui/index.html")).into_response();
    let headers = response.headers_mut();
    headers.insert("cache-control", "no-store".parse().unwrap());
    headers.insert("referrer-policy", "no-referrer".parse().unwrap());
    headers.insert("x-frame-options", "DENY".parse().unwrap());
    headers.insert("content-security-policy","default-src 'none'; script-src 'unsafe-inline'; style-src 'self'; img-src data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'".parse().unwrap());
    response
}
async fn styles() -> impl IntoResponse {
    (
        [
            ("content-type", "text/css; charset=utf-8"),
            ("cache-control", "no-store"),
        ],
        concat!(
            include_str!("../../../public/styles.css"),
            "\n",
            include_str!("../ui/styles.css")
        ),
    )
}
pub async fn start(profiles: Profiles, port: u16) -> Result<tokio::task::JoinHandle<()>> {
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    let address = listener.local_addr()?;
    let origin = format!("http://{address}");
    let token = format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
    eprintln!("Servo dashboard: {origin}/#token={token}");
    let host = Host {
        profiles,
        token,
        origin,
    };
    let app = Router::new()
        .route("/", get(index))
        .route("/styles.css", get(styles))
        .route("/api/profiles", get(list_profiles).post(create))
        .route("/api/action", post(action))
        .route("/api/policies", post(policies))
        .layer(DefaultBodyLimit::max(65536))
        .with_state(host);
    Ok(tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn requires_bearer_and_rejects_foreign_origins() {
        let profiles = Profiles::new(
            crate::profiles::ProfileConfig {
                default_profile_id: "default".into(),
                engine_binary: None,
                data_root: None,
                profiles: vec![crate::profiles::ProfileDefinition {
                    id: "default".into(),
                    name: "Default".into(),
                    webdriver_url: Some("http://127.0.0.1:7002".into()),
                    data_directory: None,
                    services: Vec::new(),
                }],
            },
            std::time::Duration::from_secs(15),
        )
        .unwrap();
        let host = Host {
            profiles,
            token: "test-token".into(),
            origin: "http://127.0.0.1:8000".into(),
        };
        let mut headers = HeaderMap::new();
        assert_eq!(
            authorize(&host, &headers).unwrap_err().0,
            StatusCode::UNAUTHORIZED
        );
        headers.insert("authorization", "Bearer test-token".parse().unwrap());
        assert!(authorize(&host, &headers).is_ok());
        headers.insert("origin", "https://foreign.example".parse().unwrap());
        assert_eq!(
            authorize(&host, &headers).unwrap_err().0,
            StatusCode::FORBIDDEN
        );
        headers.insert("origin", host.origin.parse().unwrap());
        assert!(authorize(&host, &headers).is_ok());
    }
}
