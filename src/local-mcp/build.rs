fn main() {
    println!("cargo:rerun-if-env-changed=REMOTE_BROWSER_BUILD_REVISION");
    let revision =
        std::env::var("REMOTE_BROWSER_BUILD_REVISION").unwrap_or_else(|_| "development".into());
    assert!(
        revision == "development"
            || (revision.len() == 40 && revision.bytes().all(|b| b.is_ascii_hexdigit())),
        "Invalid source revision"
    );
    println!(
        "cargo:rustc-env=LOCAL_MCP_VERSION={}+{}",
        env!("CARGO_PKG_VERSION"),
        revision
    );
}
