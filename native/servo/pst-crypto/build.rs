use std::{env, path::PathBuf, process::Command};

const REVISION: &str = "5b83e5d1abf0ae0033ae52ab579d906b67633b2c";

fn main() {
    println!("cargo:rerun-if-env-changed=SERVO_PST_BORINGSSL_SOURCE");
    println!("cargo:rerun-if-changed=bridge.cc");
    let source =
        PathBuf::from(env::var_os("SERVO_PST_BORINGSSL_SOURCE").expect(
            "set SERVO_PST_BORINGSSL_SOURCE to the pinned BoringSSL checkout (see README.md)",
        ));
    let revision = Command::new("git")
        .arg("-C")
        .arg(&source)
        .args(["rev-parse", "HEAD"])
        .output()
        .expect("read BoringSSL revision");
    assert!(revision.status.success());
    assert_eq!(
        String::from_utf8_lossy(&revision.stdout).trim(),
        REVISION,
        "BoringSSL revision must match the audited pin"
    );
    assert!(
        Command::new("git")
            .arg("-C")
            .arg(&source)
            .args(["diff", "--quiet", "HEAD", "--"])
            .status()
            .unwrap()
            .success(),
        "BoringSSL source must be unmodified"
    );
    println!(
        "cargo:rerun-if-changed={}",
        source.join(".git/HEAD").display()
    );
    let output = cmake::Config::new(&source)
        .define("BUILD_TESTING", "OFF")
        .define("BUILD_SHARED_LIBS", "OFF")
        .define("CMAKE_POSITION_INDEPENDENT_CODE", "ON")
        .define("BORINGSSL_PREFIX", "servo_pst")
        .profile("Release")
        .build_target("crypto")
        .build();
    cc::Build::new()
        .cpp(true)
        .std("c++17")
        .file("bridge.cc")
        .define("BORINGSSL_PREFIX", "servo_pst")
        .include(source.join("include"))
        .compile("servo_pst_bridge");
    println!(
        "cargo:rustc-link-search=native={}",
        output.join("build").display()
    );
    println!("cargo:rustc-link-lib=static=crypto");
}
