/** Run selected real-engine suites sequentially, reporting every outcome. */
import { parseArgs } from "node:util";

const local = [
  "agent-api",
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
  "label-activation",
  "user-activation",
  "webgl",
];
const optional = ["extension-install", "extension-management", "dashboard-pointer"];
const { values } = parseArgs({
  options: {
    "engine-binary": { type: "string" },
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
        ...(values["real-store"] ? ["extension-install", "extension-management"] : []),
        ...(values.chrome ? ["dashboard-pointer"] : []),
      ];
  const engine = values["engine-binary"] || process.env.REMOTE_BROWSER_ENGINE_BINARY;
  const host = values["host-binary"] || process.env.REMOTE_BROWSER_HOST_BINARY;
  if (!engine) {
    throw new Error("Pass --engine-binary or REMOTE_BROWSER_ENGINE_BINARY");
  }
  const hostSuites = new Set([
    "agent-api",
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
  ]);
  if (suites.some((suite) => hostSuites.has(suite)) && !host) {
    throw new Error("Pass --host-binary or REMOTE_BROWSER_HOST_BINARY for host suites");
  }
  const outcomes: Record<string, string> = {};
  for (const suite of suites) {
    if (![...local, ...optional].includes(suite)) {
      throw new Error(`Unknown integration suite: ${suite}`);
    }
    if (suite === "dashboard-pointer" && !values.chrome) {
      throw new Error("dashboard-pointer requires --chrome");
    }
  }
  for (const suite of suites) {
    const args = [
      "--engine-binary",
      engine,
      ...(host ? ["--host-binary", host] : []),
      ...(suite === "dashboard-pointer" && values.chrome ? ["--chrome", values.chrome] : []),
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
