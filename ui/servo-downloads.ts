import { asyncHandler } from "../src/async-boundary.js";

type Chunk = { name: string; offset: number; data: string; done: boolean };
type Download = { name: string; bytes: Uint8Array; offset: number };
type LinkDownload = { kind: "url"; url: string; name: string };
declare global {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Window augmentation requires declaration merging.
  interface Window {
    __remoteBrowserDownloads?: { drain: () => Chunk | LinkDownload | null };
  }
}
if (!("download" in HTMLAnchorElement.prototype)) {
  Object.defineProperty(HTMLAnchorElement.prototype, "download", {
    configurable: true,
    get(this: HTMLAnchorElement) {
      return this.getAttribute("download") || "";
    },
    set(this: HTMLAnchorElement, value: string) {
      this.setAttribute("download", value);
    },
  });
}
if (!window.__remoteBrowserDownloads) {
  const queue: (Download | LinkDownload)[] = [];
  let active = false;
  window.__remoteBrowserDownloads = {
    drain() {
      const item = queue[0];
      if (!item) {
        return null;
      }
      if ("kind" in item) {
        queue.shift();
        return item;
      }
      const { offset } = item;
      const chunk = item.bytes.subarray(offset, offset + 32_768);
      let raw = "";
      for (const byte of chunk) {
        raw += String.fromCodePoint(byte);
      }
      item.offset += chunk.length;
      const done = item.offset === item.bytes.length;
      if (done) {
        queue.shift();
      }
      return { name: item.name, offset, data: btoa(raw), done };
    },
  };
  document.addEventListener(
    "click",
    asyncHandler(async (event: MouseEvent) => {
      if (!(event.target instanceof Element)) {
        return;
      }
      const anchor = event.target.closest("a[download]");
      if (!(anchor instanceof HTMLAnchorElement) || event.defaultPrevented) {
        return;
      }
      const url = new URL(anchor.href, location.href);
      if (!["http:", "https:", "blob:", "data:"].includes(url.protocol)) {
        return;
      }
      event.preventDefault();
      const name = anchor.getAttribute("download") || "download.bin";
      if (url.protocol === "http:" || url.protocol === "https:") {
        if (queue.length < 4) {
          queue.push({ kind: "url", url: url.href, name });
        }
        return;
      }
      if (active || queue.length >= 4) {
        return;
      }
      active = true;
      try {
        const response = await fetch(url.href);
        // Servo exposes Blob/arrayBuffer but not ReadableStream response bodies yet.
        const blob = await response.blob();
        if (blob.size > 20 * 1024 * 1024) {
          return;
        }
        const bytes = new Uint8Array(await blob.arrayBuffer());
        queue.push({ name, bytes, offset: 0 });
      } finally {
        active = false;
      }
    }),
  );
}
