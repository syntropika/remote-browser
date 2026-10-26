import filePath from "node:path";

import { assert, cli, Engine, temporary } from "./harness.js";

const { join } = filePath;

export async function run(binary: string) {
  await temporary(async (root) => {
    for (const eof of [false, true]) {
      const engine = new Engine(binary, join(root, "profile"));
      try {
        const tab = (await engine.call("tabs"))[0].id;
        assert.equal(await engine.call("evaluate", tab, { script: "return 42;" }), 42);
        const closing = await engine.call("open");
        await engine.call("open");
        await engine.call("close", closing, {}, { human: true });
        await engine.stop(eof);
      } finally {
        if (engine.process.exitCode === null) {
          engine.process.kill("SIGKILL");
        }
      }
    }
  });
  console.log("PASS: multiple views close on shutdown/EOF and the same profile restarts");
}

if (import.meta.main) {
  await cli(run);
}
