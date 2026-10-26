/** Preserve the standalone pointer seam harness; requires its matching legacy HTML fixture. */
import filePath from "node:path";
import { parseArgs } from "node:util";

import { HARNESS } from "./fixtures/dashboard-pointer-seam-smoke.js";

const { resolve } = filePath;

export async function run(dashboard: string): Promise<void> {
  const child = Bun.spawn([process.execPath, "-e", HARNESS], {
    env: { ...process.env, REMOTE_BROWSER_DASHBOARD_HTML: resolve(dashboard) },
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) {
    throw new Error(
      `Pointer seam harness failed (${code}); provide the matching inline-script dashboard with --dashboard`,
    );
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { dashboard: { type: "string", default: "src/host/ui/index.html" } },
  });
  await run(values.dashboard);
}
