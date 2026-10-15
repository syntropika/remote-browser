# Experimental Private State Tokens

This opt-in integration uses Servo's native WebIDL and Fetch paths, with the
BoringSSL `PST V1 VOPRF` implementation also used by Chromium. It does not launch
Chrome, run a JavaScript API shim, or generate credentials for public issuers.
The normal engine build keeps these APIs disabled.

The current experimental surface supports:

- `document.hasPrivateToken(issuer)` and `document.hasRedemptionRecord(issuer)`.
- `fetch()` and `Request` with `privateToken.version = 1`, operations
  `token-request`, `token-redemption`, and `send-redemption-record`.
- Proof verification against administrator-provisioned issuer commitments.
- Profile-local token storage and redemption records partitioned by top-level
  origin and issuer. Tokens themselves are stored per issuer, as in PST.
- Durable consumption before redemption is sent, issuer operation exclusion,
  two issuer associations per top-level origin, and bounded token storage.
- Key expiry/removal, redemption record expiry, private response-header removal,
  and aggregate counters in the native engine's `status` response.

## Deliberate experimental limits

Only secure, fully active **top-level documents** can perform these operations.
HTTP loopback is a potentially trustworthy origin for local fixtures. Explicit
`Permissions-Policy` denials are respected. Iframes and workers are denied until
policy delegation and inheritance are implemented. Unknown or complex policy
allowlists fail closed. XHR and iframe `privateToken` attributes are not supported.

Only `PrivateStateTokenV1VOPRF` is supported. Fetch failures currently use Servo's
network-error/`TypeError` path rather than Chromium's complete PST DOMException
mapping. A cached redemption with `refreshPolicy: 'none'` rejects without making
another request; use `hasRedemptionRecord` to query it. Redirects are rejected.
The redemption budget permits two attempts per issuer/top-level pair per 48 hours.

Commitments are read at process startup from `SERVO_PST_KEY_COMMITMENTS`, a public
JSON registry provisioned by the embedder. A page cannot provide or replace keys.
The format is a map of issuer origins to `PrivateStateTokenV1VOPRF` objects with
`batchsize` and `keys`; each key contains `Y` (base64) and `expiry` (Unix epoch
microseconds). Key identifiers must match the encoded key. The registry is shared
configuration; token/record state is private to each profile. Restart the process
to replace the registry. No automatic issuer registration or trusted distribution
service is included. Without a registered, unexpired issuer, issuance fails.

Records are opaque issuer data: the browser does not assert their downstream
meaning or signature validity. The consuming service must verify them. Local
self-issued test tokens do not establish trust with another issuer or website.
PST is distinct from Cloudflare Private Access Tokens, and successful fixture
results do not establish that a website uses PST or accepts this browser.

## Build and test

The `private-state-tokens` engine feature adds a native C++ build dependency.
Obtain a clean checkout of official BoringSSL outside the project, pinned to
`5b83e5d1abf0ae0033ae52ab579d906b67633b2c`, and set
`SERVO_PST_BORINGSSL_SOURCE` to that checkout. CMake and a C++17 compiler must be
available. The build verifies the pin and unchanged tracked sources, compiles the
crypto target statically with the `servo_pst` symbol prefix, and exposes only a
small safe Rust wrapper. The engine and browser service retain `unsafe_code =
"forbid"`. Upstream BoringSSL licenses remain in the external source distribution;
see its [license](https://boringssl.googlesource.com/boringssl/+/5b83e5d1abf0ae0033ae52ab579d906b67633b2c/LICENSE).

```sh
cargo build --locked --manifest-path native/servo/engine/Cargo.toml \
  --features private-state-tokens
```

The `tests/pst_issuer_fixture.cc` helper is a disposable local test issuer and is
never linked into the browser. Build it with C++17, the pinned BoringSSL include
path, `-DBORINGSSL_PREFIX=servo_pst`, and the `libcrypto.a` produced under the
`servo-pst-crypto` build output. Then run:

```sh
python3 native/servo/tests/private_state_tokens_smoke.py \
  --engine-binary <experimental-engine> --issuer-binary <fixture-helper>
```

This exercises the real browser seam: native API calls, HTTP exchange, a real
issuer signature, rejection of a corrupted proof, single-use consumption,
header privacy, restart persistence, profile isolation, top-level record
isolation, permission denial, expiry, key removal, and redirect rejection.
No public security challenge is solved or clicked by this test.

Protocol references: [PST specification](https://wicg.github.io/trust-token-api/),
[Chromium implementation](https://chromium.googlesource.com/chromium/src/+/main/services/network/trust_tokens/).
