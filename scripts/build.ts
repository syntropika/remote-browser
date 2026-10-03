import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";

import { Effect } from "effect";
import { build } from "esbuild";

import { attempt, nativeError, run } from "../src/effects.js";

const command = promisify(execFile);
const program = Effect.gen(function* program() {
  yield* attempt(async () => rm("dist", { recursive: true, force: true }));
  for (const args of [["--noEmit"], ["-p", "tsconfig.build.json"], ["-p", "tsconfig.tools.json"]]) {
    yield* attempt(async () =>
      command(process.execPath, ["node_modules/typescript/bin/tsc", ...args]),
    );
  }
  yield* attempt(async () =>
    build({
      entryPoints: ["ui/app.ts"],
      outfile: "dist/public/app.js",
      bundle: true,
      format: "esm",
      external: ["/vendor/*"],
      target: "es2022",
      minify: true,
      logLevel: "info",
    }),
  );
  console.log("TypeScript application and dashboard built in dist/.");
});
run(program).catch((cause: unknown) => {
  const error = nativeError(cause);
  console.error(error.stdout || error.stderr || error.message);
  process.exitCode = 1;
});
