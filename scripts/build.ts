import { Effect } from 'effect';
import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { attempt, run } from '../src/effects.js';

const command = promisify(execFile);
const program = Effect.gen(function* () {
  yield* attempt(() => rm('dist', { recursive: true, force: true }));
  for (const args of [['--noEmit'], ['-p', 'tsconfig.build.json'], ['-p', 'tsconfig.tools.json']]) {
    yield* attempt(() => command(process.execPath, ['node_modules/typescript/bin/tsc', ...args]));
  }
  yield* attempt(() => build({ entryPoints: ['ui/app.ts'], outfile: 'dist/public/app.js', bundle: true,
    format: 'esm', external: ['/vendor/*'], target: 'es2022', minify: true, logLevel: 'info' }));
  console.log('TypeScript application and dashboard built in dist/.');
});
run(program).catch((cause: unknown) => {
  const error = cause as Error & { stdout?: string; stderr?: string };
  console.error(error.stdout || error.stderr || error.message);
  process.exitCode = 1;
});
