import type { Protocol } from "../node_modules/playwright-core/types/protocol.js";
import type { CDPSession } from "playwright";
import type { Page } from "playwright";
import { constants } from "node:fs";
import { chmod, mkdtemp, open, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const limit = 20 * 1024 * 1024;

// A CDP-attached daily-driver context keeps native defaults. Watch downloads on
// our own browser session instead of changing Playwright's private internals.
export async function captureDownload<A>(
  page: Page,
  action: () => Promise<unknown>,
  { name, timeoutMs = 30000 }: { name?: string; timeoutMs?: number } = {},
  save: (bytes: Buffer, name: string) => Promise<A>,
) {
  if (
    typeof action !== "function" ||
    !page?.context ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > 90000
  )
    throw new Error(
      "Pass a Page, async trigger function, and timeoutMs 1000–90000.",
    );
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "remote-browser-download-"),
  );
  await chmod(directory, 0o700);
  let session: CDPSession | undefined;
  let timer: NodeJS.Timeout | undefined;
  const selection: { value?: Protocol.Browser.downloadWillBeginPayload } = {};
  let completed = false;
  const downloads = new Set<string>();
  try {
    const pageSession = await page.context().newCDPSession(page);
    let frameTree;
    try {
      ({ frameTree } = await pageSession.send("Page.getFrameTree"));
    } finally {
      await pageSession.detach();
    }
    const frames = new Set();
    function addFrames(tree: Protocol.Page.FrameTree) {
      frames.add(tree.frame.id);
      for (const child of tree.childFrames || []) addFrames(child);
    }
    addFrames(frameTree);
    const browser = page.context().browser();
    if (!browser) throw new Error("The browser session is unavailable.");
    session = await browser.newBrowserCDPSession();
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const done = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    done.catch(() => {});
    session.on("Browser.downloadWillBegin", (event) => {
      if (!/^[a-f0-9-]{36}$/.test(event.guid)) {
        reject(new Error("Invalid download identifier."));
        return;
      }
      downloads.add(event.guid);
      if (!selection.value && frames.has(event.frameId))
        selection.value = event;
    });
    session.on("Browser.downloadProgress", (event) => {
      if (event.guid !== selection.value?.guid) return;
      if (event.receivedBytes > limit || event.totalBytes > limit)
        reject(new Error("Downloads must be no larger than 20 MiB."));
      else if (event.state === "completed") {
        completed = true;
        resolve();
      } else if (event.state === "canceled")
        reject(new Error("The browser download was canceled."));
    });
    timer = setTimeout(
      () => reject(new Error("The download did not finish in time.")),
      timeoutMs,
    );
    await session.send("Browser.setDownloadBehavior", {
      behavior: "allowAndName",
      downloadPath: directory,
      eventsEnabled: true,
    });
    await action();
    await done;
    if (!selection.value)
      throw new Error("The download did not provide file metadata.");
    const file = await open(
      path.join(directory, selection.value.guid),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let bytes;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > limit)
        throw new Error(
          "Downloads must be non-empty and no larger than 20 MiB.",
        );
      const chunks = [];
      let size = 0;
      for await (const chunk of file.createReadStream({ autoClose: false })) {
        size += chunk.length;
        if (size > limit)
          throw new Error("Downloads must be no larger than 20 MiB.");
        chunks.push(chunk);
      }
      bytes = Buffer.concat(chunks);
    } finally {
      await file.close();
    }
    return await save(bytes, name || selection.value.suggestedFilename);
  } finally {
    clearTimeout(timer);
    if (session) {
      for (const guid of downloads)
        if (guid !== selection.value?.guid || !completed)
          await session
            .send("Browser.cancelDownload", { guid })
            .catch(() => {});
      await session
        .send("Browser.setDownloadBehavior", {
          behavior: "default",
          eventsEnabled: false,
        })
        .catch(() => {});
      await session.detach().catch(() => {});
    }
    await rm(directory, { recursive: true, force: true });
  }
}
