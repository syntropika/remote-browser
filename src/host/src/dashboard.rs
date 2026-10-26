//! Loopback dashboard routes human input through the same per-tab ownership checks.
use crate::{
    Result,
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
    origin: String,
    extension: Arc<crate::native_extensions::McpExtension>,
    access: Arc<crate::access::AccessExtension>,
}
type Reply = std::result::Result<Json<Value>, DashboardError>;
async fn observe(request: Request, next: Next) -> Response {
    // Every request here arrived at this browser's own address, so they all log as one client.
    let client = crate::identity::Client {
        id: "dashboard".into(),
        keys: None,
    };
    let op = match (request.method().as_str(), request.uri().path()) {
        ("POST", "/api/profiles") => "create_profile",
        ("POST", "/api/keys/permissions") => "key_permissions",
        ("POST", "/api/keys/revoke") => "revoke_key",
        ("POST", "/api/keys") => "create_key",
        (_, "/api/keys") => "keys",
        (_, "/api/files/content") => "file_content",
        (_, "/api/profiles") => "profiles",
        (_, "/api/action") => "action",
        (_, "/api/extensions/native") => "native_extensions",
        (_, "/api/extensions/access/configure") => "access_settings",
        (_, "/api/access/login") => "login",
        (_, "/api/access/logout") => "logout",
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
/// The dashboard listens on loopback and asks for no credential: opening its address is the
/// whole of it. What it still refuses is a request from another origin, so a web page cannot
/// drive this browser from the side. Anything else running on this machine can.
fn authorize(host: &Host, headers: &HeaderMap) -> std::result::Result<(), DashboardError> {
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
/// The same rule as a read. A browser always says which page a request came from, so refusing
/// a foreign origin is what keeps another page from driving this browser; a local tool sends no
/// origin at all and is allowed, because it could set any header it liked anyway.
fn authorize_mutation(host: &Host, headers: &HeaderMap) -> std::result::Result<(), DashboardError> {
    authorize(host, headers)
}
// Keys are managed from the dashboard's own address, never by a key signed in with itself:
// a key cannot widen its own reach or mint another.
fn manager(
    host: &Host,
    headers: &HeaderMap,
    mutation: bool,
) -> std::result::Result<(), DashboardError> {
    authorize(host, headers)?;
    if mutation || headers.get("origin").is_some() {
        same_origin(host, headers)?;
    }
    Ok(())
}
fn extension_keys(host: &Host) -> std::result::Result<Arc<ApiKeys>, DashboardError> {
    host.extension.keys().map_err(failure)
}

async fn native_extensions(State(host): State<Host>, headers: HeaderMap) -> Reply {
    manager(&host, &headers, false)?;
    Ok(Json(
        json!({"extensions":[host.extension.describe().map_err(failure)?, host.access.describe().map_err(failure)?]}),
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeExtensionAction {
    id: String,
    action: String,
    confirmed: Option<bool>,
}

async fn change_native_extension(
    State(host): State<Host>,
    headers: HeaderMap,
    Json(input): Json<NativeExtensionAction>,
) -> std::result::Result<Response, DashboardError> {
    manager(&host, &headers, true)?;
    if input.action == "uninstall" && input.confirmed != Some(true) {
        return Err(DashboardError(
            StatusCode::BAD_REQUEST,
            "Confirm removal of the native extension first".into(),
        ));
    }
    let access = host.access.clone();
    let is_access = input.id == "access";
    let value = tokio::task::spawn_blocking(move || match input.id.as_str() {
        "mcp" => host.extension.update(&input.id, &input.action),
        "access" => host.access.update(&input.action),
        _ => Err(crate::Error::Invalid("Unknown native extension".into())),
    })
    .await
    .map_err(|_| failure("Native extension settings are unavailable"))?
    .map_err(failure)?;
    let response = Json(value.clone()).into_response();
    if is_access && value["enabled"] == true {
        access_cookie(response, &access.session().map_err(failure)?)
    } else {
        Ok(response)
    }
}

fn cookie(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("cookie")?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|part| part.trim().strip_prefix("rb_access="))
}

fn access_cookie(
    mut response: Response,
    token: &str,
) -> std::result::Result<Response, DashboardError> {
    response.headers_mut().insert(
        "set-cookie",
        format!("rb_access={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200")
            .parse()
            .map_err(|_| failure("Browser session is unavailable"))?,
    );
    Ok(response)
}

async fn browser_access(State(host): State<Host>, request: Request, next: Next) -> Response {
    let path = request.uri().path();
    let public = matches!(path, "/api/access/status" | "/api/access/login");
    if path.starts_with("/api/") && !public {
        let allowed = host.access.required().and_then(|required| {
            if required {
                host.access.authenticated(cookie(request.headers()))
            } else {
                Ok(true)
            }
        });
        match allowed {
            Ok(true) => {}
            Ok(false) => {
                return DashboardError(StatusCode::UNAUTHORIZED, "Sign in to this browser".into())
                    .into_response();
            }
            Err(_) => {
                return DashboardError(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Browser access is unavailable".into(),
                )
                .into_response();
            }
        }
    }
    next.run(request).await
}

async fn access_status(State(host): State<Host>, headers: HeaderMap) -> Reply {
    authorize(&host, &headers)?;
    Ok(Json(
        json!({"required":host.access.required().map_err(failure)?, "authenticated":host.access.authenticated(cookie(&headers)).map_err(failure)?}),
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Credentials {
    username: String,
    password: String,
}

async fn access_login(
    State(host): State<Host>,
    headers: HeaderMap,
    Json(input): Json<Credentials>,
) -> std::result::Result<Response, DashboardError> {
    same_origin(&host, &headers)?;
    let token =
        tokio::task::spawn_blocking(move || host.access.login(&input.username, &input.password))
            .await
            .map_err(|_| failure("Browser login is unavailable"))?
            .map_err(|error| DashboardError(StatusCode::UNAUTHORIZED, error.to_string()))?;
    access_cookie(Json(json!({"authenticated":true})).into_response(), &token)
}

async fn configure_access(
    State(host): State<Host>,
    headers: HeaderMap,
    Json(input): Json<Credentials>,
) -> std::result::Result<Response, DashboardError> {
    manager(&host, &headers, true)?;
    let access = host.access;
    let (value, token) = tokio::task::spawn_blocking(move || {
        access.configure(&input.username, &input.password)?;
        Ok::<_, crate::Error>((access.describe()?, access.session()?))
    })
    .await
    .map_err(|_| failure("Access settings are unavailable"))?
    .map_err(failure)?;
    access_cookie(Json(value).into_response(), &token)
}

async fn access_logout(
    State(host): State<Host>,
    headers: HeaderMap,
) -> std::result::Result<Response, DashboardError> {
    same_origin(&host, &headers)?;
    host.access.logout(cookie(&headers)).map_err(failure)?;
    let mut response = Json(json!({"authenticated":false})).into_response();
    response.headers_mut().insert(
        "set-cookie",
        "rb_access=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"
            .parse()
            .unwrap(),
    );
    Ok(response)
}

fn key_failure(error: KeyError) -> DashboardError {
    DashboardError(StatusCode::from_u16(error.0).unwrap(), error.1.into())
}
async fn list_keys(State(host): State<Host>, headers: HeaderMap) -> Reply {
    manager(&host, &headers, false)?;
    let keys = extension_keys(&host)?;
    let keys = tokio::task::spawn_blocking(move || keys.list())
        .await
        .map_err(|_| key_failure(KeyError(503, "API keys are unavailable.")))?
        .map_err(key_failure)?;
    manager(&host, &headers, false)?;
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
    manager(&host, &headers, true)?;
    known_profiles(&host, input.profile_ids.as_deref()).await?;
    let keys = extension_keys(&host)?;
    let value = tokio::task::spawn_blocking(move || {
        keys.create_scoped(&input.name, input.profile_ids, || Ok(()))
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
    manager(&host, &headers, true)?;
    let keys = extension_keys(&host)?;
    tokio::task::spawn_blocking(move || keys.revoke(&input.id, || Ok(())))
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
    manager(&host, &headers, true)?;
    known_profiles(&host, input.profile_ids.as_deref()).await?;
    let keys = extension_keys(&host)?;
    tokio::task::spawn_blocking(move || keys.permissions(&input.id, input.profile_ids, || Ok(())))
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
async fn dashboard_script() -> impl IntoResponse {
    (
        [("content-type", "text/javascript; charset=utf-8")],
        include_str!("../ui/app.js"),
    )
}
async fn dashboard_styles() -> impl IntoResponse {
    (
        [
            ("content-type", "text/css; charset=utf-8"),
            ("cache-control", "no-store"),
        ],
        include_str!("../ui/app.css"),
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
    // The dashboard's own code is a served file, so inline scripts are not allowed at all.
    // Inline styles are allowed only when they carry this response's nonce, which the
    // overlay library reads from the page to sign the style layers it injects.
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let mut response =
        Html(include_str!("../../../ui/index.html").replace("{nonce}", &nonce)).into_response();
    let headers = response.headers_mut();
    headers.insert("cache-control", "no-store".parse().unwrap());
    headers.insert("referrer-policy", "no-referrer".parse().unwrap());
    headers.insert("x-frame-options", "DENY".parse().unwrap());
    headers.insert(
        "content-security-policy",
        format!(
            "default-src 'none'; script-src 'self'; style-src 'self' 'nonce-{nonce}'; img-src data: blob:; media-src blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
        )
        .parse()
        .unwrap(),
    );
    response
}
pub async fn start(
    profiles: Profiles,
    port: u16,
    extension: Arc<crate::native_extensions::McpExtension>,
    access: Arc<crate::access::AccessExtension>,
) -> Result<tokio::task::JoinHandle<()>> {
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    let address = listener.local_addr()?;
    let origin = format!("http://{address}");
    eprintln!("Remote Browser dashboard: {origin}");
    let mcp = crate::http_mcp::router(profiles.clone(), extension.clone(), address);
    let host = Host {
        access,
        extension,
        profiles,
        origin,
    };
    let app = Router::new()
        .route("/", get(index))
        .route("/app.js", get(dashboard_script))
        .route("/app.css", get(dashboard_styles))
        .route("/api/access/status", get(access_status))
        .route(
            "/api/access/login",
            post(access_login).layer(DefaultBodyLimit::max(4096)),
        )
        .route("/api/access/logout", post(access_logout))
        .route(
            "/api/extensions/access/configure",
            post(configure_access).layer(DefaultBodyLimit::max(4096)),
        )
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
        .route(
            "/api/keys/permissions",
            post(key_permissions).layer(DefaultBodyLimit::max(4096)),
        )
        .route(
            "/api/extensions/native",
            get(native_extensions).post(change_native_extension),
        )
        .route("/api/profiles", get(list_profiles).post(create))
        .route("/api/action", post(action))
        .route("/api/policies", post(policies))
        .layer(middleware::from_fn_with_state(host.clone(), browser_access))
        .layer(DefaultBodyLimit::max(65536))
        .layer(middleware::from_fn_with_state(host.clone(), observe))
        .with_state(host)
        .merge(mcp);
    Ok(tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn opens_without_a_credential_and_rejects_foreign_origins() {
        let profiles = Profiles::new(
            crate::profiles::ProfileConfig {
                default_profile_id: "default".into(),
                engine_binary: std::env::current_exe().unwrap(),
                data_root: None,
                files_root: None,
                profiles: vec![crate::profiles::ProfileDefinition {
                    id: "default".into(),
                    name: "Default".into(),
                    data_directory: std::env::temp_dir()
                        .join(format!("browser-dashboard-{}", uuid::Uuid::new_v4())),
                    services: Vec::new(),
                }],
            },
            std::time::Duration::from_secs(15),
        )
        .unwrap();
        let host = Host {
            access: crate::access::AccessExtension::open(
                std::env::temp_dir().join(format!("browser-access-{}.json", uuid::Uuid::new_v4())),
            )
            .unwrap(),
            extension: crate::native_extensions::McpExtension::open(
                std::env::temp_dir().join(format!("browser-native-{}.json", uuid::Uuid::new_v4())),
                std::env::temp_dir().join(format!("browser-keys-{}.json", uuid::Uuid::new_v4())),
                None,
                false,
            )
            .unwrap(),
            profiles,
            origin: "http://127.0.0.1:8000".into(),
        };
        // A request with no origin at all is a local tool, which may read and change.
        let mut headers = HeaderMap::new();
        assert!(authorize(&host, &headers).is_ok());
        assert!(authorize_mutation(&host, &headers).is_ok());
        // One that names another page is refused either way.
        headers.insert("origin", "https://foreign.example".parse().unwrap());
        assert_eq!(
            authorize_mutation(&host, &headers).unwrap_err().0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            authorize(&host, &headers).unwrap_err().0,
            StatusCode::FORBIDDEN
        );
        headers.insert("origin", host.origin.parse().unwrap());
        assert!(authorize(&host, &headers).is_ok());
        assert!(authorize_mutation(&host, &headers).is_ok());
    }
}
