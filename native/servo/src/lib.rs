//! Local Servo automation with an engine boundary and an MCP adapter.
pub mod automation;
pub mod cli;
pub mod dashboard;
pub mod health;
pub mod mcp;
pub mod native;
pub mod profiles;
pub mod reservations;
pub mod snapshot;
pub mod webdriver;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Invalid(String),
    #[error("Servo WebDriver error ({code}): {message}")]
    WebDriver { code: String, message: String },
    #[error("Servo transport failed; completion is unknown. Restart the MCP server: {0}")]
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
