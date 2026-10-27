//! A portable local MCP adapter: the actual browser remains on the configured server.
mod network;
mod remote;
use clap::{Parser, Subcommand};
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc};
use tokio::{
    io::AsyncWriteExt,
    sync::{Semaphore, mpsc},
    task::JoinSet,
};
use tokio_util::codec::{FramedRead, LinesCodec};

#[derive(Parser)]
#[command(version=env!("LOCAL_MCP_VERSION"),about="Connect a local MCP client and optional local-network tunnels to Remote Browser")]
struct Args {
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    Mcp {
        /// Remote Browser base URL, or its /mcp endpoint.
        #[arg(long, env = "REMOTE_BROWSER_SERVER")]
        connect: url::Url,
        /// Read the API key from a file instead of REMOTE_BROWSER_API_KEY.
        #[arg(long)]
        api_key_file: Option<PathBuf>,
    },
}
fn main() {
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(_) => {
            eprintln!("Remote Browser MCP: could not start the client runtime");
            std::process::exit(1);
        }
    };
    let result = runtime.block_on(run());
    // Tokio stdin uses a blocking reader that may remain open after an MCP host sends SIGTERM.
    runtime.shutdown_timeout(std::time::Duration::from_millis(100));
    if let Err(error) = result {
        eprintln!("Remote Browser MCP: {error}");
        std::process::exit(1);
    }
}
async fn run() -> Result<(), String> {
    let Command::Mcp {
        connect,
        api_key_file,
    } = Args::parse().command;
    let token = if let Some(path) = api_key_file {
        let metadata = std::fs::metadata(&path).map_err(|_| "Could not read the API key file")?;
        if !metadata.is_file() || metadata.len() > 1024 {
            return Err("The API key file must be a small regular file".into());
        }
        std::fs::read_to_string(path).map_err(|_| "Could not read the API key file")?
    } else {
        std::env::var("REMOTE_BROWSER_API_KEY")
            .map_err(|_| "Set REMOTE_BROWSER_API_KEY or --api-key-file")?
    };
    let remote = Arc::new(remote::Remote::new(connect, token.trim())?);
    let networks = Arc::new(network::Networks::new(remote.clone()));
    let (output, mut responses) = mpsc::channel::<Value>(32);
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(response) = responses.recv().await {
            let mut bytes = serde_json::to_vec(&response)?;
            bytes.push(b'\n');
            stdout.write_all(&bytes).await?;
            stdout.flush().await?;
        }
        Ok::<_, std::io::Error>(())
    });
    let mut input = FramedRead::new(
        tokio::io::stdin(),
        LinesCodec::new_with_max_length(128 * 1024),
    );
    let slots = Arc::new(Semaphore::new(16));
    let mut tasks = JoinSet::new();
    let stop = shutdown_signal();
    tokio::pin!(stop);
    loop {
        let line = tokio::select! {_= &mut stop=>break,line=input.next()=>line};
        let Some(line) = line else {
            break;
        };
        let line = line.map_err(|_| "MCP input exceeds the frame limit or is invalid UTF-8")?;
        let message: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => {
                output
                    .send(error(Value::Null, -32700, "Invalid JSON"))
                    .await
                    .map_err(|_| "MCP output closed")?;
                continue;
            }
        };
        if message["jsonrpc"] != "2.0" || !message["method"].is_string() {
            output
                .send(error(
                    message.get("id").cloned().unwrap_or(Value::Null),
                    -32600,
                    "Invalid MCP request",
                ))
                .await
                .map_err(|_| "MCP output closed")?;
            continue;
        }
        let permit = tokio::select! {
            _ = &mut stop => break,
            result = slots.clone().acquire_owned() => result.map_err(|_| "MCP connection closed")?,
        };
        let remote = remote.clone();
        let networks = networks.clone();
        let output = output.clone();
        tasks.spawn(async move {
            let _permit = permit;
            if let Some(response) = handle(&remote, &networks, message).await {
                let _ = output.send(response).await;
            }
        });
        while tasks.try_join_next().is_some() {}
    }
    // Drain completed page operations rather than cancelling an unknown mutation on stdin EOF.
    let drain = async { while tasks.join_next().await.is_some() {} };
    let drained = tokio::time::timeout(std::time::Duration::from_secs(150), drain).await;
    networks.shutdown().await;
    if drained.is_err() {
        tasks.abort_all();
        return Err(
            "Timed out draining MCP requests; observe remote page state before retrying".into(),
        );
    }
    drop(output);
    writer
        .await
        .map_err(|_| "MCP output task failed")?
        .map_err(|_| "MCP output closed")?;
    Ok(())
}
fn error(id: Value, code: i32, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}
async fn handle(
    remote: &remote::Remote,
    networks: &network::Networks,
    message: Value,
) -> Option<Value> {
    let id = message.get("id").cloned();
    if id.is_none()
        && !message["method"]
            .as_str()
            .is_some_and(|method| method.starts_with("notifications/"))
    {
        return None;
    }
    let result = if message["method"] == "tools/call"
        && message["params"]["name"] == "browser_network"
    {
        let outcome = networks.call(message["params"]["arguments"].clone()).await;
        let body = match outcome {
            Ok(value) => {
                json!({"content":[{"type":"text","text":value.to_string()}],"structuredContent":value,"isError":false})
            }
            Err(cause) => json!({"content":[{"type":"text","text":cause}],"isError":true}),
        };
        Ok(Some(json!({"jsonrpc":"2.0","id":id,"result":body})))
    } else {
        remote.mcp(&message).await.map(|mut reply| {
            if message["method"] == "tools/list"
                && let Some(tools) = reply
                    .as_mut()
                    .and_then(|r| r["result"]["tools"].as_array_mut())
            {
                tools.push(network::tool());
            }
            reply
        })
    };
    id.map(|id| match result {
        Ok(Some(reply)) => reply,
        Ok(None) => error(id, -32603, "Remote Browser returned no result"),
        Err(cause) => error(id, -32000, &cause),
    })
}
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        if let Ok(mut term) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            tokio::select! {_=term.recv()=>{},_=tokio::signal::ctrl_c()=>{}};
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}
