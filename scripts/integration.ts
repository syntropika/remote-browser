/** Run selected real-engine suites sequentially, reporting every outcome. */
import { parseArgs } from "node:util";

const local = [
  "agent-api",
  "review-regressions",
  "cdp-adapter",
  "embedded",
  "unified",
  "http",
  "keys",
  "access",
  "files",
  "parity",
  "failure",
  "handoff",
  "logging",
  "metadata",
  "native-extensions",
  "human-pointer",
  "pointer-capture",
  "pointer-events",
  "pointer-fidelity",
  "pointer-screen",
  "release",
  "shutdown",
  "surface",
  "display-control",
  "page-editor",
  "label-activation",
  "user-activation",
  "webgl",
];
const optional = [
  "local-mcp",
  "extension-install",
  "extension-management",
  "dashboard-pointer",
  "dashboard-dialog",
  "dashboard-mobile",
  "dashboard-editor",
  "dashboard-viewers",
];
const { values } = parseArgs({
  options: {
    "engine-binary": { type: "string" },
    "local-mcp-binary": { type: "string" },
    "host-binary": { type: "string" },
    suite: { type: "string" },
    chrome: { type: "string" },
    "real-store": { type: "boolean" },
    "verify-expiry": { type: "boolean" },
    "protocol-only": { type: "boolean" },
    list: { type: "boolean" },
  },
});
if (values.list) {
  console.log(`Local suites: ${local.join(", ")}\nOpt-in suites: ${optional.join(", ")}`);
} else {
  const suites = values.suite
    ? values.suite.split(",")
    : [
        ...local,
        ...(values["local-mcp-binary"] ? ["local-mcp"] : []),
        ...(values["real-store"] ? ["extension-install", "extension-management"] : []),
        ...(values.chrome
          ? [
              "dashboard-pointer",
              "dashboard-dialog",
              "dashboard-mobile",
              "dashboard-editor",
              "dashboard-viewers",
            ]
          : []),
      ];
  const engine = values["engine-binary"] || process.env.REMOTE_BROWSER_ENGINE_BINARY;
  const host = values["host-binary"] || process.env.REMOTE_BROWSER_HOST_BINARY;
  if (!engine) {
    throw new Error("Pass --engine-binary or REMOTE_BROWSER_ENGINE_BINARY");
  }
  const hostSuites = new Set([
    "agent-api",
    "local-mcp",
    "review-regressions",
    "cdp-adapter",
    "unified",
    "http",
    "keys",
    "access",
    "files",
    "parity",
    "failure",
    "handoff",
    "logging",
    "metadata",
    "native-extensions",
    "release",
    "dashboard-pointer",
    "dashboard-dialog",
    "dashboard-mobile",
    "dashboard-editor",
    "dashboard-viewers",
  ]);
  if (suites.some((suite) => hostSuites.has(suite)) && !host) {
    throw new Error("Pass --host-binary or REMOTE_BROWSER_HOST_BINARY for host suites");
  }
  const outcomes: Record<string, string> = {};
  for (const suite of suites) {
    if (![...local, ...optional].includes(suite)) {
      throw new Error(`Unknown integration suite: ${suite}`);
    }
    if (suite.startsWith("dashboard-") && !values.chrome) {
      throw new Error(`${suite} requires --chrome`);
    }
  }
  for (const suite of suites) {
    const args = [
      "--engine-binary",
      engine,
      ...(suite === "local-mcp" && values["local-mcp-binary"]
        ? ["--local-mcp-binary", values["local-mcp-binary"]]
        : []),
      ...(host ? ["--host-binary", host] : []),
      ...(suite.startsWith("dashboard-") && values.chrome ? ["--chrome", values.chrome] : []),
      ...(suite === "extension-install" && values["verify-expiry"] ? ["--verify-expiry"] : []),
      ...(suite === "extension-install" && values["protocol-only"] ? ["--protocol-only"] : []),
    ];
    console.log(`Running ${suite}`);
    const child = Bun.spawn(
      [process.execPath, "run", `src/host/tests/${suite}-smoke.ts`, ...args],
      { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
    );
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        child.kill("SIGTERM");
      },
      suite === "extension-install" ? 600_000 : 180_000,
    );
    const code = await child.exited;
    clearTimeout(timer);
    outcomes[suite] = timedOut ? "timeout" : code === 0 ? "pass" : `failed (${code})`;
  }
  console.log(JSON.stringify(outcomes, null, 2));
  if (Object.values(outcomes).some((value) => value !== "pass")) {
    process.exitCode = 1;
  }
}
