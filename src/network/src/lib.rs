//! A bounded TCP tunnel shared by the browser-side broker and the local MCP connector.
mod peer;
mod rules;
mod socks;

pub use peer::{Frame, Peer, Side};
pub use rules::{Rules, valid_host};
pub use socks::serve;
pub const CHUNK: usize = 16 * 1024;
pub const MAX_FRAME: usize = CHUNK + 1024;
pub const MAX_STREAMS: usize = 64;
pub const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

#[cfg(test)]
mod tests;

pub use tokio_util::sync::CancellationToken;
