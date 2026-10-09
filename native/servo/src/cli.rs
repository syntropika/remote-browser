use std::{path::PathBuf, time::Duration};

use crate::{
    Error, Result,
    mcp::ServoMcp,
    profiles::{ProfileConfig, ProfileDefinition, Profiles},
};
use clap::Parser;
use rmcp::ServiceExt;

#[derive(Parser)]
#[command(
    version,
    about = "Experimental Servo automation MCP over stdio; no Docker or CDP"
)]
struct Args {
    /// Existing local Servo WebDriver origin. The browser process is externally managed.
    #[arg(
        long,
        env = "SERVO_WEBDRIVER_URL",
        default_value = "http://127.0.0.1:7002"
    )]
    webdriver_url: String,
    /// JSON catalog of independent local Servo profiles.
    #[arg(long, conflicts_with = "webdriver_url")]
    profiles_config: Option<PathBuf>,
    /// Persistent profile root for the executable with the embedded engine.
    #[arg(long, conflicts_with_all = ["webdriver_url", "profiles_config"])]
    profile_root: Option<PathBuf>,
    /// Operation transport deadline. Engine deadlines are shorter.
    #[arg(long, default_value_t = 15, value_parser = clap::value_parser!(u64).range(2..=120))]
    timeout_seconds: u64,
    /// Open a loopback dashboard for the embedded profiles. Zero chooses a free port.
    #[arg(long)]
    dashboard_port: Option<u16>,
}

pub fn main(embedded_binary: Option<PathBuf>) {
    let args = Args::parse();
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("Servo MCP runtime: {error}");
            std::process::exit(1);
        }
    };
    let result = runtime.block_on(run(args, embedded_binary));
    // Tokio's stdin reader uses blocking I/O and cannot be cancelled while stdin stays open.
    // Session cleanup completes in run(); bound runtime teardown so SIGTERM still exits.
    runtime.shutdown_timeout(Duration::from_millis(100));
    if let Err(error) = result {
        eprintln!("Servo MCP: {error}");
        std::process::exit(1);
    }
}

async fn run(args: Args, embedded_binary: Option<PathBuf>) -> Result<()> {
    let (config, catalog) = if let Some(root) = args.profile_root {
        let binary = embedded_binary.ok_or_else(|| {
            Error::Invalid(
                "--profile-root requires the executable with the embedded Servo engine".into(),
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
                profiles: vec![ProfileDefinition {
                    id: "default".into(),
                    name: "Default".into(),
                    webdriver_url: None,
                    data_directory: Some(root.join("profiles/default")),
                    services: Vec::new(),
                }],
            };
            crate::profiles::initialize_catalog(&catalog, &config)?;
            config
        };
        config.engine_binary = Some(binary);
        (config, Some(catalog))
    } else if let Some(path) = args.profiles_config {
        let bytes = std::fs::read(&path)?;
        if bytes.len() > 65536 {
            return Err(Error::Invalid("Profile catalog exceeds 64 KiB".into()));
        }
        (serde_json::from_slice(&bytes)?, Some(path))
    } else {
        (
            ProfileConfig {
                default_profile_id: "default".into(),
                engine_binary: None,
                data_root: None,
                profiles: vec![ProfileDefinition {
                    id: "default".into(),
                    name: "Default".into(),
                    webdriver_url: Some(args.webdriver_url),
                    data_directory: None,
                    services: Vec::new(),
                }],
            },
            None,
        )
    };
    let profiles =
        Profiles::with_catalog(config, Duration::from_secs(args.timeout_seconds), catalog)?;
    // Preserve the original startup handshake and fail early if the default browser is unavailable.
    profiles.browser(None).await?;
    let dashboard = if let Some(port) = args.dashboard_port {
        Some(crate::dashboard::start(profiles.clone(), port).await?)
    } else {
        None
    };
    let result = async {
        let shutdown = shutdown_signal();
        tokio::pin!(shutdown);
        let handler = ServoMcp { profiles: profiles.clone() };
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
