fn main() {
    // CEF's runtime libraries are copied beside the executable, so the loader has to look
    // in the executable's own directory instead of the system paths. This keeps the folder
    // that ships the engine relocatable.
    println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN");
}
