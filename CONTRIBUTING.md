# Contributing

Open an issue to describe a bug or proposed behavior change. For a pull request, explain the
user-visible change and include the checks you ran.

Use Conventional Commits, such as `feat: add a browser action`, `fix: preserve control
ownership` or `docs: clarify setup`.

## Layout

- `src/host/` — the Rust host: dashboard, MCP, accounts, API keys, sessions, reservations.
- `src/engine/` — the Rust engine: one process per session, Chromium through CEF.
- `ui/` — the dashboard, React and TypeScript, with the HTML shell it loads.
- `scripts/build-ui.ts` — the bundle: Bun for the script, Tailwind for the stylesheet.
- `src/host/tests/` — Bun/TypeScript integration tests that drive both executables end to end.

The pair in `src/host/ui/` is generated from `ui/`, and the host embeds it at compile time
along with `ui/index.html`. Run `bun run build` after changing anything in `ui/` and commit
the result, or the next Rust build ships the old dashboard.

## Checks

Use Bun 1.3 and Rust 1.88 or newer, and install the locked dependencies:

```sh
bun install --frozen-lockfile
bun run check   # formatting, TypeScript, lint rules and the host's tests
bun run build
```

Run `bun run format` to format files and `bun run lint:fix` to apply safe lint fixes. Oxlint
and Oxfmt follow [Swarmie's configuration](https://github.com/syntropika/swarmie), using
Ultracite's core rules and assertion safety checks; the exceptions are documented in
`oxlint.config.ts`. Formatting uses double quotes, a 100-character line width, sorted imports
and trailing commas. Markdown and TOML remain manually formatted.

For the engine and the host together, run `cargo clippy --all-targets` in each crate and the
smoke tests that cover what you changed. Never run them against a real profile: they create
accounts, open pages and write files.

Preserve the sandbox, the human and agent control lease, and the authenticated account, key
and file endpoints. Never commit API keys, browser profiles, account records, screenshots,
recordings or real website data. Use synthetic fixtures in tests. Report security issues
privately as described in [SECURITY.md](SECURITY.md).
