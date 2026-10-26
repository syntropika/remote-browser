/** Bun entry points for the operations that Cargo must execute natively. */
import process from "node:process";

const [task, ...args] = process.argv.slice(2);
const commands = new Map<string, string[]>([
  ["build:host", ["cargo", "build", "--locked", "--manifest-path", "src/host/Cargo.toml"]],
  ["test:host", ["cargo", "test", "--locked", "--manifest-path", "src/host/Cargo.toml"]],
  [
    "lint:host",
    [
      "cargo",
      "clippy",
      "--locked",
      "--manifest-path",
      "src/host/Cargo.toml",
      "--all-targets",
      "--",
      "-D",
      "warnings",
    ],
  ],
]);
const command = commands.get(task);
if (!command) {
  throw new Error(`Unknown native task: ${task}`);
}
process.exitCode = await Bun.spawn([...command, ...args], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
}).exited;
