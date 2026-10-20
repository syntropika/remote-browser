use std::{path::PathBuf, time::Duration};

use crate::{
    Error, Result,
    mcp::NativeMcp,
    profiles::{ProfileConfig, ProfileDefinition, Profiles},
};
use clap::Parser;
use rmcp::ServiceExt;

#[derive(Parser)]
#[command(version, about = "Native browser automation MCP over stdio; no Docker")]
struct Args {
    /// Protected API key registry shared by dashboard management and HTTP MCP.
    #[arg(long, env = "REMOTE_BROWSER_API_KEYS_FILE")]
    api_keys_file: Option<PathBuf>,
    /// Optional loopback Streamable HTTP MCP listener sharing the stdio browser.
    #[arg(long)]
    mcp_http_port: Option<u16>,
    /// Protected file holding the bearer required for HTTP MCP requests.
    #[arg(long, env = "REMOTE_BROWSER_MCP_HTTP_TOKEN_FILE")]
    mcp_http_token_file: Option<PathBuf>,
    /// Local file workspace root; each embedded profile gets its own subdirectory.
    #[arg(long, env = "REMOTE_BROWSER_FILES_ROOT")]
    files_root: Option<PathBuf>,
    /// JSON catalog of independent local browser profiles.
    #[arg(long)]
    profiles_config: Option<PathBuf>,
    /// Persistent profile root for a single embedded profile.
    #[arg(long, conflicts_with = "profiles_config")]
    profile_root: Option<PathBuf>,
    /// The engine executable to run for that profile, when this binary is not one itself.
    #[arg(long, env = "REMOTE_BROWSER_ENGINE_BINARY", requires = "profile_root")]
    engine_binary: Option<PathBuf>,
    /// Operation transport deadline. Engine deadlines are shorter.
    #[arg(long, default_value_t = 15, value_parser = clap::value_parser!(u64).range(2..=120))]
    timeout_seconds: u64,
    /// Open a loopback dashboard for the embedded profiles. Zero chooses a free port.
    #[arg(long)]
    dashboard_port: Option<u16>,
    /// Structured diagnostics on stderr. Debug includes frequent observation operations.
    #[arg(
        long,
        env = "REMOTE_BROWSER_LOG_LEVEL",
        value_enum,
        default_value = "info"
    )]
    log_level: crate::logging::Level,
}

pub fn main(embedded_binary: Option<PathBuf>) {
    let args = Args::parse();
    crate::logging::configure(args.log_level);
    crate::logging::lifecycle("runtime", "service_started", None);
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            crate::logging::service_error(&Error::Io(error));
            crate::logging::flush();
            std::process::exit(1);
        }
    };
    let result = runtime.block_on(run(args, embedded_binary));
    // Tokio's stdin reader uses blocking I/O and cannot be cancelled while stdin stays open.
    // Session cleanup completes in run(); bound runtime teardown so SIGTERM still exits.
    runtime.shutdown_timeout(Duration::from_millis(100));
    if let Err(error) = &result {
        crate::logging::service_error(error);
    }
    crate::logging::lifecycle("runtime", "service_stopped", None);
    crate::logging::flush();
    if result.is_err() {
        std::process::exit(1);
    }
}

async fn run(args: Args, embedded_binary: Option<PathBuf>) -> Result<()> {
    let (mut config, catalog) = if let Some(root) = args.profile_root {
        let binary = args.engine_binary.or(embedded_binary).ok_or_else(|| {
            Error::Invalid(
                "--profile-root needs --engine-binary, or an executable with an engine inside"
                    .into(),
            )
        })?;
        std::fs::create_dir_all(&root)?;
        let root = std::fs::canonicalize(root)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))?;
        }
        let catalog = root.join("profiles.json");
        let mut config: ProfileConfig = if catalog.exists() {
            let bytes = std::fs::read(&catalog)?;
            if bytes.len() > 65536 {
                return Err(Error::Invalid("Profile catalog exceeds 64 KiB".into()));
            }
            serde_json::from_slice(&bytes)?
        } else {
            let config = ProfileConfig {
                default_profile_id: "default".into(),
                engine_binary: Some(binary.clone()),
                data_root: Some(root.join("profiles")),
                files_root: None,
                profiles: vec![ProfileDefinition {
                    id: "default".into(),
                    name: "Default".into(),
                    data_directory: Some(root.join("profiles/default")),
                    services: Vec::new(),
                }],
            };
            crate::profiles::initialize_catalog(&catalog, &config)?;
            config
        };
        config.engine_binary = Some(binary);
        // A single embedded profile keeps its files beside itself, so captures and
        // downloads have somewhere to go without another flag.
        config.files_root.get_or_insert_with(|| root.join("files"));
        (config, Some(catalog))
    } else if let Some(path) = args.profiles_config {
        let bytes = std::fs::read(&path)?;
        if bytes.len() > 65536 {
            return Err(Error::Invalid("Profile catalog exceeds 64 KiB".into()));
        }
        (serde_json::from_slice(&bytes)?, Some(path))
    } else {
        return Err(Error::Invalid(
            "Pass --profile-root for an embedded profile, or --profiles-config for a catalog"
                .into(),
        ));
    };
    if let Some(root) = args.files_root {
        std::fs::create_dir_all(&root)?;
        config.files_root = Some(std::fs::canonicalize(root)?);
    }
    // Where this browser keeps what outlives a run: the catalog's own directory, unless the
    // keys are given a file of their own.
    let state = catalog
        .as_ref()
        .or(args.mcp_http_token_file.as_ref())
        .and_then(|path| path.parent())
        .map(std::path::Path::to_path_buf);
    let keys = if args.dashboard_port.is_some() || args.mcp_http_port.is_some() {
        let path = args
            .api_keys_file
            .or_else(|| state.as_ref().map(|parent| parent.join("api-keys.json")))
            .ok_or_else(|| {
                Error::Invalid("Dashboard or HTTP MCP requires a persistent --api-keys-file".into())
            })?;
        let seed = args
            .mcp_http_token_file
            .as_deref()
            .map(crate::http_mcp::token)
            .transpose()?;
        Some(std::sync::Arc::new(
            crate::api_keys::ApiKeys::new(path, seed)
                .map_err(|error| Error::Invalid(error.1.into()))?,
        ))
    } else {
        None
    };
    let profiles =
        Profiles::with_catalog(config, Duration::from_secs(args.timeout_seconds), catalog)?;
    // Preserve the original startup handshake and fail early if the default browser is unavailable.
    profiles.browser(None).await?;
    let dashboard = if let Some(port) = args.dashboard_port {
        Some(
            crate::dashboard::start(
                profiles.clone(),
                port,
                keys.as_ref().unwrap().clone(),
            )
            .await?,
        )
    } else {
        None
    };
    let http_mcp = if let Some(port) = args.mcp_http_port {
        Some(crate::http_mcp::start(profiles.clone(), port, keys.unwrap()).await?)
    } else {
        None
    };
    let result = async {
        let shutdown = shutdown_signal();
        tokio::pin!(shutdown);
        let handler = NativeMcp { profiles: profiles.clone() };
        let server = tokio::select! {
            result = handler.serve(rmcp::transport::stdio()) => result.map_err(|error| Error::Protocol(error.to_string()))?,
            signal = &mut shutdown => { signal?; return Ok(()); }
        };
        let cancellation = server.cancellation_token();
        tokio::select! {
            result = server.waiting() => { result.map_err(|error| Error::Protocol(error.to_string()))?; }
            signal = &mut shutdown => { signal?; cancellation.cancel(); }
        }
        Ok(())
    }.await;
    // Save embedded profiles on engine shutdown; external browsers keep running.
    if let Some(dashboard) = dashboard {
        dashboard.abort();
    }
    if let Some(http_mcp) = http_mcp {
        http_mcp.abort();
    }
    profiles.close().await;
    result
}

async fn shutdown_signal() -> std::io::Result<()> {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tokio::select! {
            result = tokio::signal::ctrl_c() => result,
            _ = terminate.recv() => Ok(()),
        }
    }
    #[cfg(not(unix))]
    tokio::signal::ctrl_c().await
}
