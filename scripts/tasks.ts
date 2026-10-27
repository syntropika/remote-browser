/** Bun entry points for the operations that Cargo must execute natively. */
import process from "node:process";

const [task, ...args] = process.argv.slice(2);
const [operation, component] = (task || "").split(":");
const operations = new Map([
  ["build", "build"],
  ["test", "test"],
  ["lint", "clippy"],
]);
const verb = operations.get(operation);
if (!verb || !["host", "engine", "network", "local-mcp"].includes(component)) {
  throw new Error(`Unknown native task: ${task}`);
}
let { env } = process;
if (component === "engine") {
  const preparation = Bun.spawn([process.execPath, "run", "scripts/prepare-cef.ts"], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const runtime = (await new Response(preparation.stdout).text()).trim();
  if ((await preparation.exited) !== 0 || !runtime) {
    throw new Error("CEF preparation failed");
  }
  env = { ...env, CEF_PATH: runtime };
}
const command = [
  "cargo",
  verb,
  "--locked",
  "--manifest-path",
  `src/${component}/Cargo.toml`,
  ...(operation === "lint" ? ["--all-targets"] : []),
  ...args,
  ...(operation === "lint" ? ["--", "-D", "warnings"] : []),
];
process.exitCode = await Bun.spawn(command, {
  env,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
}).exited;
