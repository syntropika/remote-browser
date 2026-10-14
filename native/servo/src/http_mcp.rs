//! Optional authenticated HTTP adapter over the same profiles as stdio and the dashboard.
use crate::{Error, Result, mcp::ServoMcp, profiles::Profiles};
use axum::{
    Router,
    extract::{Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
};
use rmcp::transport::streamable_http_server::{
    StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
};
use std::{io::Read, path::Path, sync::Arc};
use subtle::ConstantTimeEq;

async fn authorize(State(token): State<Arc<String>>, request: Request, next: Next) -> Response {
    let supplied = request
        .headers()
        .get("authorization")
        .and_then(|header| header.to_str().ok())
        .and_then(|header| header.strip_prefix("Bearer "))
        .unwrap_or("");
    if !bool::from(token.as_bytes().ct_eq(supplied.as_bytes())) {
        return (
            StatusCode::UNAUTHORIZED,
            [
                ("www-authenticate", "Bearer realm=\"servo-mcp\""),
                ("cache-control", "no-store"),
            ],
            "MCP authorization required",
        )
            .into_response();
    }
    let mut log = crate::logging::Operation::begin(
        crate::logging::Context::current(),
        "mcp",
        "http_mcp",
        None,
        None,
    );
    let mut response = log.context.clone().scope(next.run(request)).await;
    log.finish_http(response.status().as_u16());
    response
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert("x-request-id", log.context.trace_id.parse().unwrap());
    response
}
fn token(path: &Path) -> Result<String> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() || meta.len() > 1024 {
        return Err(Error::Invalid(
            "HTTP MCP token file must be a small regular file".into(),
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o077 != 0 {
            return Err(Error::Invalid(
                "HTTP MCP token file must be private to its owner".into(),
            ));
        }
    }
    let mut bytes = Vec::new();
    file.take(1025).read_to_end(&mut bytes)?;
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| Error::Invalid("Invalid HTTP MCP token file".into()))?
        .trim();
    if !(32..=256).contains(&text.len()) || !text.bytes().all(|byte| byte.is_ascii_graphic()) {
        return Err(Error::Invalid(
            "HTTP MCP bearer must contain 32 to 256 printable ASCII bytes".into(),
        ));
    }
    Ok(text.to_owned())
}
pub async fn start(
    profiles: Profiles,
    port: u16,
    token_file: &Path,
) -> Result<tokio::task::JoinHandle<()>> {
    let token = Arc::new(token(token_file)?);
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    let address = listener.local_addr()?;
    let config = StreamableHttpServerConfig::default()
        .with_legacy_session_mode(false)
        .with_json_response(true)
        .with_allowed_hosts([address.to_string(), format!("localhost:{}", address.port())])
        .with_allowed_origins([format!("http://{address}")])
        .with_max_request_body_bytes(65536);
    let service = StreamableHttpService::new(
        move || {
            Ok(ServoMcp {
                profiles: profiles.clone(),
            })
        },
        Arc::new(LocalSessionManager::default()),
        config,
    );
    let app = Router::new()
        .route_service("/mcp", service)
        .layer(middleware::from_fn_with_state(token, authorize));
    Ok(tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    }))
}
