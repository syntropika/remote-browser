"""Apply the installation bridge to an initialized, pinned Chromium/CEF checkout."""
import argparse
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent
CEF_REVISION = "14c5a08"


def git(directory, *arguments):
    return subprocess.run(
        ["git", "-C", str(directory), *arguments],
        check=True, capture_output=True, text=True,
    ).stdout.strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("chromium", type=Path, help="Chromium src directory containing cef/")
    parser.add_argument("--check", action="store_true", help="Check applicability without writing")
    args = parser.parse_args()
    chromium = args.chromium.resolve()
    cef = chromium / "cef"
    revision = git(cef, "rev-parse", "HEAD")
    if not revision.startswith(CEF_REVISION):
        parser.error(f"Expected CEF revision {CEF_REVISION}; received {revision}")
    patches = [(chromium, ROOT / "chromium.patch"), (cef, ROOT / "cef.patch")]
    copies = [
        (ROOT / name, cef / "libcef/browser" / ("remote_browser_" + name))
        for name in ["install_bridge.h", "install_bridge.cc", "install_bridge_capi.h",
                     "extension_management.cc", "extension_management_capi.h"]
    ]
    # Complete preflight before the first mutation. Refuse partial/repeated application
    # instead of guessing which source changes belong to this integration.
    for directory, patch in patches:
        git(directory, "apply", "--check", str(patch))
    for source, destination in copies:
        if destination.exists():
            parser.error(f"Refusing to replace existing source: {destination}")
        if not source.is_file():
            parser.error(f"Missing bridge source: {source.name}")
    if args.check:
        print("The native integration patches apply to this checkout.")
        return
    for directory, patch in patches:
        git(directory, "apply", str(patch))
    for source, destination in copies:
        shutil.copyfile(source, destination)
    print("Native installation bridge applied. Regenerate and build CEF before packaging.")


if __name__ == "__main__":
    main()
