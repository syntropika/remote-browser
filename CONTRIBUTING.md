# Contributing

Open an issue to describe a bug or proposed behavior change. For a pull request, explain the user-visible change and include the checks you ran.

Use Conventional Commits, such as `feat: add a browser action`, `fix: preserve control ownership` or `docs: clarify setup`.

Use Node.js 24 and install the locked dependencies:

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
```

Application modules live in `src/`, dashboard modules in `ui/`, and the container supervisor in `scripts/runtime.ts`. Use TypeScript and Effect for application workflows. Keep native transport, DOM and subprocess adapters at explicit boundaries. Do not edit generated `dist/` files.

Changes to browser control, persistence, the runtime or file transfers also need the dedicated container integration checks described in the README. Never run those checks against a real user's profile.

Preserve Chromium's sandbox, the human/agent control lease and authenticated account, key and file endpoints. Never commit `.env`, API keys, browser profiles, account records, screenshots, recordings or real website data. Use synthetic fixtures in tests. Report security issues privately as described in [SECURITY.md](SECURITY.md).
