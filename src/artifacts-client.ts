import http from "node:http";

import type { Download, Locator, Page } from "playwright";

import type { ArtifactMetadata, RecordingStatus } from "./artifacts.js";
import { captureDownload } from "./browser-download.js";
import { isRecord, parseJson } from "./invariants.js";

type SavedArtifact = ArtifactMetadata & { url: string };
type Gallery = {
  files: SavedArtifact[];
  recording: RecordingStatus | null;
};

const screenshotLimit = 8 * 1024 * 1024;
const fileLimit = 20 * 1024 * 1024;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const uploadTypes = new Map([
  ["pdf", "application/pdf"],
  ["txt", "text/plain"],
  ["csv", "text/csv"],
  ["json", "application/json"],
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["zip", "application/zip"],
  ["doc", "application/msword"],
  ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
]);

export function createArtifactClient({
  socketPath = process.env.ARTIFACT_SOCKET_PATH || "/tmp/remote-browser/artifacts.sock",
  publicOrigin = "",
} = {}) {
  async function request<A = SavedArtifact>(
    method: string,
    route: string,
    body?: unknown,
  ): Promise<A> {
    const encoded = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const result = await new Promise<unknown>((resolve, reject) => {
      const req = http.request(
        {
          socketPath,
          method,
          path: route,
          headers: encoded
            ? {
                "content-type": "application/json",
                "content-length": encoded.length,
              }
            : {},
        },
        (res) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          res.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 2 * 1024 * 1024) {
              res.destroy(new Error("Artifact response is too large."));
            } else {
              chunks.push(chunk);
            }
          });
          res.on("error", reject);
          res.on("end", () => {
            try {
              const value = parseJson(Buffer.concat(chunks).toString("utf-8"));
              if ((res.statusCode ?? 500) >= 400) {
                const error = new Error(
                  isRecord(value) && typeof value.error === "string"
                    ? value.error
                    : "Artifact request failed.",
                );
                Object.assign(error, { status: res.statusCode });
                reject(error);
              } else {
                resolve(value);
              }
            } catch {
              reject(new Error("Artifact service returned an invalid response."));
            }
          });
        },
      );
      req.setTimeout(25_000, () => req.destroy(new Error("Artifact request timed out.")));
      req.on("error", reject);
      req.end(encoded);
    });
    const qualify = (value: unknown): unknown => {
      if (!isRecord(value)) {
        return value;
      }
      const file = value;
      return typeof file.url === "string" && file.url.startsWith("/") && publicOrigin
        ? { ...value, url: `${publicOrigin.replace(/\/$/u, "")}${file.url}` }
        : value;
    };
    const listing = isRecord(result) ? result : null;
    // SAFETY: This private socket serves the route-owned response contract A; URL qualification preserves its fields.
    return (
      Array.isArray(listing?.files)
        ? { ...listing, files: listing.files.map(qualify) }
        : qualify(result)
    ) as A;
  }

  return {
    files: {
      download: async (
        page: Page,
        action: () => Promise<unknown>,
        options: { name?: string; timeoutMs?: number } = {},
      ) =>
        captureDownload(page, action, options, async (bytes, name) =>
          request("POST", "/download", {
            name,
            base64: bytes.toString("base64"),
          }),
        ),
      async saveDownload(download: Download, { name }: { name?: string } = {}) {
        if (!download || typeof download.createReadStream !== "function") {
          throw new Error(
            'Pass the Playwright Download returned by page.waitForEvent("download").',
          );
        }
        const stream = await download.createReadStream();
        if (!stream) {
          throw new Error("The download failed or is unavailable.");
        }
        const chunks: Buffer[] = [];
        let size = 0;
        try {
          for await (const rawChunk of stream) {
            const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(String(rawChunk));
            size += chunk.length;
            if (size > fileLimit) {
              throw new Error("Downloads must be no larger than 20 MiB.");
            }
            chunks.push(chunk);
          }
          const saved = await request("POST", "/download", {
            name: name || download.suggestedFilename(),
            base64: Buffer.concat(chunks).toString("base64"),
          });
          await download.delete().catch((): void => undefined);
          return saved;
        } catch (cause) {
          stream.destroy();
          await download.cancel?.().catch((): void => undefined);
          await download.delete?.().catch((): void => undefined);
          throw cause;
        }
      },
      async uploadTo(locator: Locator, { id }: { id?: string } = {}) {
        if (
          typeof id !== "string" ||
          !/^[a-f0-9]{32}$/u.test(id) ||
          typeof locator?.setInputFiles !== "function"
        ) {
          throw new Error("Pass a file input Locator and a human upload id from files.list().");
        }
        const file = await new Promise<{
          name: string;
          mimeType: string;
          buffer: Buffer;
        }>((resolve, reject) => {
          const req = http.get({ socketPath, path: `/uploads/${id}` }, (res) => {
            const chunks: Buffer[] = [];
            let size = 0;
            res.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > fileLimit) {
                res.destroy(new Error("Uploaded file exceeds 20 MiB."));
              } else {
                chunks.push(chunk);
              }
            });
            res.on("error", reject);
            res.on("end", () => {
              if (res.statusCode !== 200) {
                reject(new Error("Choose an existing file uploaded by the human in Files."));
                return;
              }
              try {
                const name = decodeURIComponent(String(res.headers["x-file-name"]));
                resolve({
                  name,
                  mimeType:
                    uploadTypes.get((name.split(".").at(-1) ?? "").toLowerCase()) ||
                    "application/octet-stream",
                  buffer: Buffer.concat(chunks),
                });
              } catch {
                reject(new Error("Invalid upload metadata."));
              }
            });
          });
          req.setTimeout(25_000, () => req.destroy(new Error("Upload request timed out.")));
          req.on("error", reject);
        });
        await locator.setInputFiles(file);
        return { id, name: file.name, size: file.buffer.length };
      },
      async saveScreenshot(value: Uint8Array, { name }: { name?: string } = {}) {
        if (!(value instanceof Uint8Array)) {
          throw new Error("Pass the buffer returned by page.screenshot().");
        }
        const buffer = Buffer.from(value);
        if (!buffer.length || buffer.length > screenshotLimit) {
          throw new Error("Screenshots must be no larger than 8 MiB.");
        }
        const mimeType = buffer.subarray(0, 8).equals(pngSignature)
          ? "image/png"
          : buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255
            ? "image/jpeg"
            : null;
        if (!mimeType) {
          throw new Error("Only PNG and JPEG screenshots can be saved.");
        }
        return request("POST", "/screenshot", {
          name,
          base64: buffer.toString("base64"),
          mimeType,
        });
      },
      list: async () => request<Gallery>("GET", "/files"),
    },
    recording: {
      start: async (options: { name?: string; maxSeconds?: number } = {}) =>
        request<RecordingStatus>("POST", "/recording/start", options),
      stop: async () => request("POST", "/recording/stop", {}),
      status: async () => request<RecordingStatus | null>("GET", "/recording"),
    },
  };
}
