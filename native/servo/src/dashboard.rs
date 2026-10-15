//! Loopback dashboard routes human input through the same per-tab ownership checks.
use crate::{
    Result,
    account::{AuthError, Credentials, DashboardAuth},
    api_keys::{ApiKeys, KeyError},
    health::HealthPolicy,
    profiles::Profiles,
};
use axum::{
    Json, Router,
    extract::Request,
    extract::{DefaultBodyLimit, Query, State},
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc};
#[derive(Clone)]
struct Host {
    profiles: Profiles,
    token: String,
    origin: String,
    auth: Arc<DashboardAuth>,
    keys: Arc<ApiKeys>,
}
type Reply = std::result::Result<Json<Value>, DashboardError>;
async fn observe(State(host): State<Host>, request: Request, next: Next) -> Response {
    let key_id =
        if host.auth.authenticated(cookie(request.headers())) || bearer(&host, request.headers()) {
            None
        } else {
            host.auth.authenticated_key(cookie(request.headers()))
        };
    let client = crate::identity::Client {
        id: key_id.clone().unwrap_or_else(|| "dashboard-owner".into()),
        keys: key_id.map(|_| host.keys.clone()),
    };
    let op = match (request.method().as_str(), request.uri().path()) {
        ("POST", "/api/profiles") => "create_profile",
        ("POST", "/api/keys/permissions") => "key_permissions",
        (_, "/api/login/key") => "key_login",
        ("POST", "/api/keys/revoke") => "revoke_key",
        ("POST", "/api/keys") => "create_key",
        (_, "/api/keys") => "keys",
        (_, "/api/files/content") => "file_content",
        (_, "/api/auth/status") => "auth_status",
        (_, "/api/auth/setup") => "auth_setup",
        (_, "/api/login") => "login",
        (_, "/api/logout") => "logout",
        (_, "/api/profiles") => "profiles",
        (_, "/api/action") => "action",
        (_, "/api/policies") => "policies",
        _ => "unknown",
    };
    let mut log = crate::logging::Operation::begin(
        crate::logging::Context::current(),
        "dashboard",
        op,
        None,
        None,
    );
    let mut response =
        crate::identity::scope(client, log.context.clone().scope(next.run(request))).await;
    log.finish_http(response.status().as_u16());
    response
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert("x-request-id", log.context.trace_id.parse().unwrap());
    response
}
#[derive(Debug)]
struct DashboardError(StatusCode, String);
impl IntoResponse for DashboardError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error":self.1}))).into_response()
    }
}
fn authorize(host: &Host, headers: &HeaderMap) -> std::result::Result<(), DashboardError> {
    let key_valid = host
        .auth
        .authenticated_key(cookie(headers))
        .map(|id| host.keys.active(&id))
        .transpose()
        .map_err(key_failure)?
        .unwrap_or(false);
    if !bearer(host, headers) && !host.auth.authenticated(cookie(headers)) && !key_valid {
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
fn cookie(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("cookie")
        .and_then(|header| header.to_str().ok())
}
fn bearer(host: &Host, headers: &HeaderMap) -> bool {
    headers.get("authorization").and_then(|h| h.to_str().ok())
        == Some(format!("Bearer {}", host.token).as_str())
}
fn same_origin(host: &Host, headers: &HeaderMap) -> std::result::Result<(), DashboardError> {
    if headers
        .get("origin")
        .and_then(|header| header.to_str().ok())
        != Some(host.origin.as_str())
    {
        return Err(DashboardError(
            StatusCode::FORBIDDEN,
            "A same-origin request is required.".into(),
        ));
    }
    Ok(())
}
fn authorize_mutation(host: &Host, headers: &HeaderMap) -> std::result::Result<(), DashboardError> {
    authorize(host, headers)?;
    if !bearer(host, headers) {
        same_origin(host, headers)?;
    }
    Ok(())
}
fn auth_failure(error: AuthError) -> DashboardError {
    DashboardError(StatusCode::from_u16(error.0).unwrap(), error.1.into())
}
async fn auth_status(State(host): State<Host>, headers: HeaderMap) -> Reply {
    if headers.get("origin").is_some() {
        same_origin(&host, &headers)?;
    }
    Ok(Json(
        json!({"configured":host.auth.configured().map_err(auth_failure)?,"authenticated":host.auth.authenticated(cookie(&headers)) || host.auth.authenticated_key(cookie(&headers)).map(|id|host.keys.active(&id)).transpose().map_err(key_failure)?.unwrap_or(false),"owner":host.auth.authenticated(cookie(&headers))}),
    ))
}
async fn credentials(
    host: Host,
    headers: HeaderMap,
    input: Credentials,
    setup: bool,
) -> std::result::Result<Response, DashboardError> {
    same_origin(&host, &headers)?;
    host.auth.allow_attempt().map_err(auth_failure)?;
    host.auth
        .credentials(input, setup)
        .await
        .map_err(auth_failure)?;
    let session = host.auth.issue(cookie(&headers)).map_err(auth_failure)?;
    let mut response = (
        if setup {
            StatusCode::CREATED
        } else {
            StatusCode::OK
        },
        Json(json!({"authenticated":true})),
    )
        .into_response();
    response
        .headers_mut()
        .insert("set-cookie", session.parse().unwrap());
    Ok(response)
}
async fn login(
    State(host): State<Host>,
    headers: HeaderMap,
    Json(input): Json<Credentials>,
) -> std::result::Result<Response, DashboardError> {
    credentials(host, headers, input, false).await
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct KeyLogin {
    secret: String,
}
async fn key_login(
    State(host): State<Host>,
    headers: HeaderMap,
    Json(input): Json<KeyLogin>,
) -> std::result::Result<Response, DashboardError> {
    same_origin(&host, &headers)?;
    host.auth.allow_attempt().map_err(auth_failure)?;
    let keys = host.keys.clone();
    let id = tokio::task::spawn_blocking(move || keys.authenticate_id(&input.secret))
        .await
        .map_err(|_| key_failure(KeyError(503, "API keys are unavailable.")))?
        .map_err(key_failure)?
        .ok_or_else(|| DashboardError(StatusCode::UNAUTHORIZED, "Invalid API key.".into()))?;
    let session = host
        .auth
        .issue_key(cookie(&headers), id)
        .map_err(auth_failure)?;
    let mut response = Json(json!({"authenticated":true,"owner":false})).into_response();
    response
        .headers_mut()
        .insert("set-cookie", session.parse().unwrap());
    Ok(response)
}
async fn setup(
    State(host): State<Host>,
    headers: HeaderMap,
    Json(input): Json<Credentials>,
) -> std::result::Result<Response, DashboardError> {
    credentials(host, headers, input, true).await
}
async fn logout(
    State(host): State<Host>,
    headers: HeaderMap,
) -> std::result::Result<Response, DashboardError> {
    same_origin(&host, &headers)?;
    let mut response = Json(json!({"authenticated":false})).into_response();
    response.headers_mut().insert(
        "set-cookie",
        host.auth.logout(cookie(&headers)).parse().unwrap(),
    );
    Ok(response)
}
// Key management requires the owner cookie, never an automation bearer.
fn owner(
    host: &Host,
    headers: &HeaderMap,
    mutation: bool,
) -> std::result::Result<(), DashboardError> {
    if !host.auth.authenticated(cookie(headers)) {
        return Err(DashboardError(
            StatusCode::UNAUTHORIZED,
            "Sign in to manage API keys.".into(),
        ));
    }
    if mutation || headers.get("origin").is_some() {
        same_origin(host, headers)?;
    }
    Ok(())
}
fn key_failure(error: KeyError) -> DashboardError {
    DashboardError(StatusCode::from_u16(error.0).unwrap(), error.1.into())
}
async fn list_keys(State(host): State<Host>, headers: HeaderMap) -> Reply {
    owner(&host, &headers, false)?;
    let keys = host.keys.clone();
    let keys = tokio::task::spawn_blocking(move || keys.list())
        .await
        .map_err(|_| key_failure(KeyError(503, "API keys are unavailable.")))?
        .map_err(key_failure)?;
    owner(&host, &headers, false)?;
    Ok(Json(json!({"keys":keys})))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NewKey {
    name: String,
    profile_ids: Option<Vec<String>>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RevokeKey {
    id: String,
}
async fn create_key(
    State(host): State<Host>,
    headers: HeaderMap,
    Json(input): Json<NewKey>,
) -> std::result::Result<Response, DashboardError> {
    owner(&host, &headers, true)?;
    known_profiles(&host, input.profile_ids.as_deref()).await?;
    let cookie = cookie(&headers).unwrap().to_owned();
    let value = tokio::task::spawn_blocking(move || {
        host.keys.create_scoped(&input.name, input.profile_ids, || {
            if host.auth.authenticated(Some(&cookie)) {
                Ok(())
            } else {
                Err(KeyError(401, "Session expired. Sign in again."))
            }
        })
    })
    .await
    .map_err(|_| key_failure(KeyError(503, "API keys are unavailable.")))?
    .map_err(key_failure)?;
    Ok((StatusCode::CREATED, Json(value)).into_response())
}
async fn revoke_key(
    State(host): State<Host>,
    headers: HeaderMap,
    Json(input): Json<RevokeKey>,
) -> Reply {
    owner(&host, &headers, true)?;
    let cookie = cookie(&headers).unwrap().to_owned();
    tokio::task::spawn_blocking(move || {
        host.keys.revoke(&input.id, || {
            if host.auth.authenticated(Some(&cookie)) {
                Ok(())
            } else {
                Err(KeyError(401, "Session expired. Sign in again."))
            }
        })
    })
    .await
    .map_err(|_| key_failure(KeyError(503, "API keys are unavailable.")))?
    .map_err(key_failure)?;
    Ok(Json(json!({"revoked":true})))
}
async fn known_profiles(
    host: &Host,
    ids: Option<&[String]>,
) -> std::result::Result<(), DashboardError> {
    if let Some(ids) = ids {
        let profiles = host.profiles.list().await;
        if ids
            .iter()
            .any(|id| !profiles.iter().any(|profile| &profile.id == id))
        {
            return Err(DashboardError(
                StatusCode::BAD_REQUEST,
                "Unknown profile selection.".into(),
            ));
        }
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KeyPermissions {
    id: String,
    profile_ids: Option<Vec<String>>,
}
async fn key_permissions(
    State(host): State<Host>,
    headers: HeaderMap,
    Json(input): Json<KeyPermissions>,
) -> Reply {
    owner(&host, &headers, true)?;
    known_profiles(&host, input.profile_ids.as_deref()).await?;
    let cookie = cookie(&headers).unwrap().to_owned();
    tokio::task::spawn_blocking(move || {
        host.keys.permissions(&input.id, input.profile_ids, || {
            if host.auth.authenticated(Some(&cookie)) {
                Ok(())
            } else {
                Err(KeyError(401, "Session expired. Sign in again."))
            }
        })
    })
    .await
    .map_err(|_| key_failure(KeyError(503, "API keys are unavailable.")))?
    .map_err(key_failure)?;
    Ok(Json(json!({"updated":true})))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileContent {
    profile_id: String,
    file_id: String,
    #[serde(default)]
    preview: bool,
}
async fn file_content(
    State(host): State<Host>,
    headers: HeaderMap,
    Query(input): Query<FileContent>,
) -> std::result::Result<Response, DashboardError> {
    authorize(&host, &headers)?;
    let browser = host
        .profiles
        .browser(Some(&input.profile_id))
        .await
        .map_err(failure)?;
    let listing = browser
        .file_action("files", None, Value::Null)
        .await
        .map_err(failure)?;
    let root = PathBuf::from(
        listing["root"]
            .as_str()
            .ok_or_else(|| failure("File workspace unavailable"))?,
    );
    let range = headers
        .get("range")
        .and_then(|header| header.to_str().ok())
        .map(str::to_owned);
    let profile_id = input.profile_id.clone();
    let (bytes, total, start, end, mime, name) =
        tokio::task::spawn_blocking(move || -> crate::Result<_> {
            use std::io::{Read, Seek, SeekFrom};
            let files = crate::files::Files::new(&root)?;
            let path = files.existing(&input.file_id)?;
            let mut options = std::fs::OpenOptions::new();
            options.read(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.custom_flags(libc::O_NOFOLLOW);
            }
            let mut file = options.open(&path)?;
            let meta = file.metadata()?;
            if !meta.is_file() || meta.len() > crate::files::UPLOAD_LIMIT {
                return Err(crate::Error::Invalid("Invalid workspace file".into()));
            }
            let total = meta.len();
            let range = range
                .map(|range| -> crate::Result<(u64, u64)> {
                    let value = range
                        .strip_prefix("bytes=")
                        .ok_or_else(|| crate::Error::Invalid("Invalid byte range".into()))?;
                    let (start, end) = value
                        .split_once('-')
                        .ok_or_else(|| crate::Error::Invalid("Invalid byte range".into()))?;
                    let start = start
                        .parse::<u64>()
                        .map_err(|_| crate::Error::Invalid("Invalid byte range".into()))?;
                    let end = if end.is_empty() {
                        total.saturating_sub(1)
                    } else {
                        end.parse::<u64>()
                            .map_err(|_| crate::Error::Invalid("Invalid byte range".into()))?
                    };
                    if start >= total || end < start {
                        return Err(crate::Error::Invalid("Invalid byte range".into()));
                    }
                    Ok((start, end.min(total - 1)))
                })
                .transpose()?;
            let (start, end) = range.unwrap_or((0, total.saturating_sub(1)));
            file.seek(SeekFrom::Start(start))?;
            let mut bytes = Vec::new();
            file.take(if total == 0 { 0 } else { end - start + 1 })
                .read_to_end(&mut bytes)?;
            let record = files
                .list()?
                .into_iter()
                .find(|item| item.id == input.file_id)
                .ok_or_else(|| crate::Error::Invalid("File disappeared".into()))?;
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            let mime = if input.preview
                && matches!(
                    record.mime_type.as_str(),
                    "image/png" | "image/jpeg" | "image/webp" | "video/mp4" | "video/webm"
                ) {
                record.mime_type
            } else {
                "application/octet-stream".into()
            };
            Ok((bytes, total, start, end, mime, name))
        })
        .await
        .map_err(|_| failure("File read worker unavailable"))?
        .map_err(failure)?;
    authorize(&host, &headers)?;
    crate::identity::check_profile(&profile_id).map_err(failure)?;
    let partial = headers.contains_key("range");
    let mut response = (
        if partial {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        },
        bytes,
    )
        .into_response();
    let output = response.headers_mut();
    output.insert("content-type", mime.parse().unwrap());
    output.insert("accept-ranges", "bytes".parse().unwrap());
    output.insert("x-content-type-options", "nosniff".parse().unwrap());
    if partial {
        output.insert(
            "content-range",
            format!("bytes {start}-{end}/{total}").parse().unwrap(),
        );
    }
    let encoded: String = name.bytes().map(|byte| format!("%{byte:02X}")).collect();
    output.insert(
        "content-disposition",
        format!(
            "{}; filename*=UTF-8''{encoded}",
            if mime == "application/octet-stream" {
                "attachment"
            } else {
                "inline"
            }
        )
        .parse()
        .unwrap(),
    );
    Ok(response)
}
async fn features_script() -> impl IntoResponse {
    (
        [("content-type", "text/javascript; charset=utf-8")],
        include_str!("../ui/features.js"),
    )
}
async fn keys_script() -> impl IntoResponse {
    (
        [("content-type", "text/javascript; charset=utf-8")],
        include_str!("../ui/api-keys.js"),
    )
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
    authorize_mutation(&host, &headers)?;
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
    authorize_mutation(&host, &headers)?;
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
    authorize_mutation(&host, &headers)?;
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
    headers.insert("content-security-policy","default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self'; img-src data: blob:; media-src blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'".parse().unwrap());
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
pub async fn start(
    profiles: Profiles,
    port: u16,
    account: PathBuf,
    secure_cookie: bool,
    keys: Arc<ApiKeys>,
) -> Result<tokio::task::JoinHandle<()>> {
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    let address = listener.local_addr()?;
    let origin = format!("http://{address}");
    let token = format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
    eprintln!("Servo dashboard: {origin}/#token={token}");
    let host = Host {
        auth: Arc::new(DashboardAuth::new(account, secure_cookie)),
        keys,
        profiles,
        token,
        origin,
    };
    let app = Router::new()
        .route("/", get(index))
        .route("/styles.css", get(styles))
        .route("/api-keys.js", get(keys_script))
        .route("/features.js", get(features_script))
        .route("/api/files/content", get(file_content))
        .route(
            "/api/keys",
            get(list_keys)
                .post(create_key)
                .layer(DefaultBodyLimit::max(4096)),
        )
        .route(
            "/api/keys/revoke",
            post(revoke_key).layer(DefaultBodyLimit::max(4096)),
        )
        .route("/api/auth/status", get(auth_status))
        .route(
            "/api/auth/setup",
            post(setup).layer(DefaultBodyLimit::max(4096)),
        )
        .route("/api/login", post(login).layer(DefaultBodyLimit::max(4096)))
        .route(
            "/api/login/key",
            post(key_login).layer(DefaultBodyLimit::max(4096)),
        )
        .route(
            "/api/keys/permissions",
            post(key_permissions).layer(DefaultBodyLimit::max(4096)),
        )
        .route("/api/logout", post(logout))
        .route("/api/profiles", get(list_profiles).post(create))
        .route("/api/action", post(action))
        .route("/api/policies", post(policies))
        .layer(DefaultBodyLimit::max(65536))
        .layer(middleware::from_fn_with_state(host.clone(), observe))
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
                files_root: None,
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
            auth: Arc::new(DashboardAuth::new(
                std::env::temp_dir().join("servo-auth-test.json"),
                false,
            )),
            keys: Arc::new(
                ApiKeys::new(
                    std::env::temp_dir().join(format!("servo-keys-{}.json", uuid::Uuid::new_v4())),
                    None,
                )
                .unwrap(),
            ),
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
