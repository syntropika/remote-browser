# Native extension installation bridge

This integration targets CEF `154.0.34+g14c5a08+chromium-154.0.8037.98` on Linux.
It adds an explicit installation permission decision to windowless CEF. It is source
integration for a custom CEF build, not a patch to the downloaded binary distribution.
The standard CEF distribution does not export this bridge. On that distribution the
engine reports `available: false` and the dashboard does not show an install decision.

## Build dependency

### Reuse the compiled runtime

For Linux x86-64, use the pinned
[CEF release](https://github.com/syntropika/remote-browser/releases/tag/cef-154.0.34-rb.1):

```sh
bun run build:engine --release
```

`scripts/prepare-cef.py` downloads the versioned asset, checks the SHA-256
in `runtime.json`, safely extracts it, and prepares the flat layout expected by the
CEF Rust crate. It retains matching resources, headers, wrapper sources, licenses,
credits and archive metadata. The verified library is checked again on cache reuse.
Python 3.12 or newer is required. Build flags following `build:engine` go to Cargo.

To prepare the dependency for another build tool:

```sh
export CEF_PATH="$(python3 scripts/prepare-cef.py)"
cargo build --locked --manifest-path src/engine/Cargo.toml
```

An explicit `CEF_PATH` takes precedence and must already contain `archive.json`.
The published artifact is Linux x86-64 only. Cross builds require a matching explicit
runtime. To publish a replacement, use a new release tag and update the manifest's
archive/library hashes and source revision together; retain the old release for
reproducible checkouts. Do not commit compiled CEF archives to Git.

### Rebuild CEF from source

Prepare the matching Chromium source checkout and initialize CEF at commit `14c5a08`,
including its normal Chromium patches, using CEF's source-build workflow. Apply this
integration **after** those patches and **before** generating the final build:

```sh
python3 src/engine/cef/apply.py /path/to/chromium/src --check
python3 src/engine/cef/apply.py /path/to/chromium/src
```

The script checks both patches before changing either checkout. It refuses another
CEF revision, existing bridge files, or a partially applied patch. Reapply the
integration after any source update/reset that removes it. CEF's checkout scripts
must not reset the patched files between this step and the build.

On Linux, retain CEF's client allocator compatibility settings. Official CEF builds
set these automatically; when using `is_official_build=false`, explicitly add the
following to `GN_DEFINES` before regenerating the build:

```text
use_partition_alloc_as_malloc=false enable_backup_ref_ptr_support=false
```

These match the Linux settings in the pinned CEF revision's `tools/gn_args.py`.
They prevent `libcef.so` from replacing the embedding application's global allocator.
PartitionAlloc remains available for Chromium's internal uses. A nonofficial build
with the default allocator settings can abort during engine startup.

Regenerate and build a CEF binary distribution with the normal CEF tooling. Its
`libcef.so` must export `rb_extension_install_enable_v1`,
`rb_extension_install_poll_v1`, `rb_extension_install_resolve_v1`, and
`rb_extension_install_cancel_v1`. Installed-extension management additionally requires
`rb_extensions_manage_v1`. Keep the corresponding CEF resources and distribution
metadata together. Build the Rust engine with that distribution as `CEF_PATH`:

```sh
CEF_PATH=/path/to/custom/cef/distribution \
  cargo build --locked --manifest-path src/engine/Cargo.toml
```

The engine loads the bridge from its own adjacent `libcef.so`, after CEF initialization,
and requires ABI version 1. There is no helper service or separately installed Chrome.
Stock CEF remains usable for existing browsing operations, but its native store dialog
is unsupported: do not claim the Add to Chrome crash is fixed without the custom build.

## Native behavior

`chromium.patch` preserves the initiating WebContents even when there is no native
parent window, initializes the missing parent pointer, routes windowless extension
install prompts into the bridge, and suppresses Chrome's native post-install UI for
those contents. Windowed browsers retain their existing prompt handling.

`install_bridge.cc` retains Chromium's real permission data and one-shot completion
callback. It accepts only the ordinary install prompt from
`https://chromewebstore.google.com`. Other windowless prompt types are refused. It
does not replace package download, signature checking, policy checks, manifest matching,
installation, or extension storage. Supervised-account approval workflows are outside
this integration's supported scope.

The bridge does not add Chrome's native tab/window registry or toolbar popups.
Installation success does not establish compatibility with every extension; test
the behavior of each supported extension separately.

The native registry owns each opaque request token, the CEF browser identity, the
initiating page observer, permission warnings (including details), and a three-minute
deadline. It aborts on main-frame navigation, page destruction, browser closure,
engine shutdown, or timeout. At most 32 prompts can remain pending. A token can be
consumed once, only for its original browser. A consumed approval is not rolled back
by later cancellation; native installation may still fail after approval.

The independent C ABI is documented in `install_bridge_capi.h`. All calls run on CEF's
browser-process UI thread. It leaves the existing generated CEF Rust bindings and
the standard CEF C API unchanged. No internal data offsets, test auto-confirm globals,
JavaScript store overrides, or automatic acceptance are used.

## Host and dashboard

`extension_installs` returns bridge availability and pending requests for the engine's
profile. The engine maps native browser IDs to its own tab IDs. The dashboard polls
this observation and shows Chromium's permission warnings in its own modal.
`extension_install_decide` requires a human/dashboard call, the request token, an
explicit boolean decision, and the initiating tab. Other profiles and stale tabs
cannot resolve that request. Closing the modal cancels it. The UI distinguishes an
approved permission decision from a completed installation; the actual store reports
installation completion.

## Acceptance evidence required

Build and run against the custom CEF distribution before considering this feature
ready. A Rust build against stock CEF, a mocked bridge, patch applicability, or a UI
fixture alone does not establish that the native source integration compiles or works.

Run the browser shutdown regression and the real-store suite against the same engine:

```sh
python3 src/host/tests/shutdown_smoke.py --engine-binary /path/to/remote-browser-cef-engine
python3 src/host/tests/extension_install_smoke.py \
  --engine-binary /path/to/remote-browser-cef-engine --verify-expiry
```

Shutdown must close every native browser, release the engine's browser and DevTools
references, and receive all `OnBeforeClose` callbacks before calling `cef_shutdown`.
The shutdown regression checks both the protocol command and closed standard input,
including multiple tabs and reopening the same profile.

The real-store acceptance run must cover an enabled Add to Chrome click, the web
permission dialog, cancellation without installation, explicit approval, preserved
published extension identity, native installation completion, clean shutdown, and
extension-owned state after restart. Change an option through the extension's real
options UI, restart using the same profile without load flags, and verify the option
and resulting page behavior. Repeat with another option value. Also cover duplicate
decisions, wrong tabs, navigation, closure, timeout, and profile isolation. Test only
isolated profiles. The existing research spike supplies baseline behavior, not passing
acceptance evidence for this new integration.

## Installed extension management

The optional `rb_extensions_manage_v1` export provides a versioned JSON interface
for listing, enabling, disabling, removing, and opening options for installed user
extensions. See `extension_management_capi.h` for the single-call buffer contract.
The browser ID selects the owning profile; component extensions are excluded.
Chromium policy and permission-increase restrictions remain authoritative. Enabling
only clears an ordinary user-disabled state; extensions requiring additional review
are not enabled through this interface.

The dashboard toolbar includes an Extensions shortcut to Settings. Each session has
its own extension list, enable switch, options action, and confirmed removal action.
The host exposes `extensions` as an observation. Changes and opening options require
human/dashboard actions: `extension_set_enabled` needs an explicit boolean and
`extension_remove` needs `confirmed: true`. Older CEF builds report management as
unavailable. Chrome toolbar popups remain outside this integration.

Run the management acceptance suite against the custom runtime:

```sh
python3 src/host/tests/extension_management_smoke.py \
  --engine-binary /path/to/remote-browser-cef-engine
```

This isolated-profile suite checks a real Store extension, policy-aware metadata,
profile isolation, human-only changes, actual options, page behavior while disabled,
and persistence of disabled state, saved options, and removal across clean restarts.
