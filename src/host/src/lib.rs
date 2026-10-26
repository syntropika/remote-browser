//! Local browser automation with an engine boundary and an MCP adapter.
pub mod access;
pub mod api_keys;
pub mod automation;
pub mod cli;
pub mod dashboard;
pub mod files;
pub mod handoff;
pub mod health;
pub mod http_mcp;
pub mod identity;
pub mod logging;
pub mod mcp;
pub mod media;
pub mod native;
pub mod native_extensions;
pub mod profiles;
pub mod reservations;
pub mod snapshot;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Invalid(String),
    #[error("Engine transport failed; completion is unknown. Restart the MCP server: {0}")]
    Transport(#[from] reqwest::Error),
    #[error("Browser completion is unknown. Restart the MCP server before further actions")]
    Uncertain,
    #[error("The human has control. Resume automation from the host application when finished")]
    HumanControl,
    #[error("The browser is busy. Retry after the current operation finishes")]
    Busy,
    #[error("{0}")]
    Protocol(String),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, Error>;
