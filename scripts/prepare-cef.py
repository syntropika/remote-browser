"""Prepare the pinned extension-enabled CEF runtime; optionally build the Rust engine."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "src/engine/cef/runtime.json"
REQUIRED = (
    "libcef.so", "resources.pak", "icudtl.dat", "locales/en-US.pak",
    "include/cef_api_versions.h", "CMakeLists.txt", "LICENSE.txt", "CREDITS.html",
)


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def validate(runtime, asset):
    for name in REQUIRED:
        if not (runtime / name).is_file():
            raise ValueError(f"Incomplete CEF runtime: {name}")
    if digest(runtime / "libcef.so") != asset["librarySha256"]:
        raise ValueError("Cached CEF library checksum mismatch; remove its cache directory and retry")
    expected = {"type": "minimal", "name": asset["fileName"], "sha1": asset["sha1"]}
    if json.loads((runtime / "archive.json").read_text()) != expected:
        raise ValueError("CEF archive metadata does not match the pinned release")


def prepare(asset, cache):
    # The published runtime is Linux-only. Serialize competing local/CI builds.
    import fcntl

    cache.mkdir(parents=True, exist_ok=True)
    destination = cache / asset["sha256"]
    with (cache / (asset["sha256"] + ".lock")).open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if destination.exists():
            validate(destination, asset)
            return destination
        with tempfile.TemporaryDirectory(prefix=".prepare-", dir=cache) as temporary:
            stage = Path(temporary)
            archive = stage / "cef.tar.gz"
            print(f"Downloading {asset['fileName']}…", file=sys.stderr, flush=True)
            request = urllib.request.Request(asset["url"], headers={"User-Agent": "remote-browser-cef"})
            with urllib.request.urlopen(request, timeout=60) as response, archive.open("wb") as output:
                shutil.copyfileobj(response, output)
            if digest(archive) != asset["sha256"]:
                raise ValueError("CEF download checksum mismatch; nothing was installed")
            extracted = stage / "extracted"
            with tarfile.open(archive, "r:gz") as stream:
                members = stream.getmembers()
                for member in members:
                    path = PurePosixPath(member.name)
                    if (path.is_absolute() or ".." in path.parts or not path.parts
                            or path.parts[0] != asset["archiveRoot"]
                            or not (member.isfile() or member.isdir())):
                        raise ValueError("CEF archive contains an unexpected path or file type")
                stream.extractall(extracted, members=members, filter="data")
            source = extracted / asset["archiveRoot"]
            runtime = stage / "runtime"
            runtime.mkdir()
            for directory in ("Release", "Resources"):
                for child in (source / directory).iterdir():
                    shutil.move(child, runtime / child.name)
            for name in ("cmake", "include", "libcef_dll", "CMakeLists.txt", "LICENSE.txt", "CREDITS.html"):
                shutil.move(source / name, runtime / name)
            (runtime / "archive.json").write_text(json.dumps({
                "type": "minimal", "name": asset["fileName"], "sha1": asset["sha1"],
            }, indent=2) + "\n")
            validate(runtime, asset)
            runtime.rename(destination)
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build", action="store_true", help="Run cargo build with the prepared CEF_PATH")
    options, cargo_args = parser.parse_known_args()
    if cargo_args and not options.build:
        parser.error("Cargo arguments require --build")
    explicit = os.environ.get("CEF_PATH")
    if explicit:
        runtime = Path(explicit).expanduser().resolve()
        if not (runtime / "archive.json").is_file():
            raise ValueError("CEF_PATH must point to an existing flat CEF runtime with archive.json")
    else:
        if platform.system() != "Linux" or platform.machine().lower() not in ("x86_64", "amd64"):
            raise ValueError("The published custom CEF supports Linux x86-64; set CEF_PATH for another runtime")
        target = os.environ.get("CARGO_BUILD_TARGET", "x86_64-unknown-linux-gnu")
        for index, argument in enumerate(cargo_args):
            if argument == "--target" and index + 1 < len(cargo_args):
                target = cargo_args[index + 1]
            elif argument.startswith("--target="):
                target = argument.split("=", 1)[1]
        if target != "x86_64-unknown-linux-gnu":
            raise ValueError("Cross builds require an explicit matching CEF_PATH")
        manifest = json.loads(MANIFEST.read_text())
        if manifest["schemaVersion"] != 1:
            raise ValueError("Unsupported CEF runtime manifest version")
        asset = manifest["platforms"]["linux-x64"]
        cache = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "remote-browser/cef"
        runtime = prepare(asset, cache.resolve())
    if options.build:
        env = dict(os.environ, CEF_PATH=str(runtime))
        return subprocess.call([
            "cargo", "build", "--locked", "--manifest-path", str(ROOT / "src/engine/Cargo.toml"),
            *cargo_args,
        ], cwd=ROOT, env=env)
    print(runtime)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, tarfile.TarError) as error:
        print(f"CEF preparation failed: {error}", file=sys.stderr)
        sys.exit(1)
