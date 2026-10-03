# Contributing

Open an issue to describe a bug or proposed behavior change. For a pull request, explain the user-visible change and include the checks you ran.

Use Conventional Commits, such as `feat: add a browser action`, `fix: preserve control ownership` or `docs: clarify setup`.

Use Node.js 24 and install the locked dependencies:

```sh
npm ci --ignore-scripts
npm run check
npm run build
```

Application modules live in `src/`, dashboard modules in `ui/`, and the container supervisor in `scripts/runtime.ts`. Use TypeScript and Effect for application workflows. Keep native transport, DOM and subprocess adapters at explicit boundaries. Do not edit generated `dist/` files.

Run `npm run format` to format files and `npm run lint:fix` to apply safe lint fixes. `npm run check` checks formatting, TypeScript, lint rules, and tests. Oxlint and Oxfmt follow [Swarmie's configuration](https://github.com/syntropika/swarmie), using Ultracite's core rules and assertion safety checks. Framework-specific rules are omitted; native callback adapters, sequential browser operations, and synthetic test fixtures have documented exceptions in `oxlint.config.ts`. Formatting uses double quotes, a 100-character line width, sorted imports, and trailing commas. Markdown and TOML remain manually formatted.

Changes to browser control, persistence, the runtime or file transfers also need the dedicated container integration checks below. Never run those checks against a real user's profile.

Preserve Chromium's sandbox, the human/agent control lease and authenticated account, key and file endpoints. Never commit `.env`, API keys, browser profiles, account records, screenshots, recordings or real website data. Use synthetic fixtures in tests. Report security issues privately as described in [SECURITY.md](SECURITY.md).

## Container integration

The container integration test exercises a local fixture, real MCP, first-time account creation, password login, server-enforced observation, human typing, agent handoff, API key creation/authentication/revocation, native Playwright/CDP code mode, screenshot output, gallery preview/download/delete, MP4 recording, and persistent account/browser/key/file storage. It uses synthetic credentials only. Run it on a dedicated test deployment; it creates a test account and navigates the browser. It refuses to replace an existing user account:

```sh
docker compose exec --user node -T browser npm run test:integration
```

Container replacement must also be checked when changing the runtime or profile setup. The integration script has `seed` and `verify` phases for that purpose; see its command-line help.

```sh
docker compose exec --user node -T browser npm run test:integration -- seed
docker compose up -d --force-recreate --wait
docker compose exec --user node -T browser npm run test:integration -- verify
```

See [architecture](docs/architecture.md) for runtime and Effect conventions, and [Docker Hub releases](docs/releases.md) for publishing images.
