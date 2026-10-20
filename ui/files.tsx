/** The session's files: captures, recordings, downloads, and what a page may upload. */
import { Alert, Button, Card, Checkbox, Input, Label, TextField } from "@heroui/react";
import { useCallback, useEffect, useState } from "react";

import { action, failure } from "./api.js";
import { asyncHandler, background } from "./async-boundary.js";
import { Icon } from "./icons.js";
import type { ManagedFile } from "./model.js";
import { readFiles } from "./model.js";
import { count, record, text } from "./wire.js";

/** Staged in pieces, because one request carries at most 64 KiB. */
const CHUNK = 32_768;
const UPLOAD_LIMIT = 64 * 1024 * 1024;

type Props = {
  profileId: string;
  tabId: string;
  /** A page is waiting for files; closing the panel cancels its request. */
  picker: boolean;
  onClose: () => void;
  onNotice: (message: string) => void;
  onPreview: (file: ManagedFile) => void;
  recording: boolean;
  onStopRecording: () => void;
};

function readable(bytes: number): string {
  return bytes < 1024
    ? `${bytes} B`
    : `${(bytes / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KiB`;
}

function Thumbnail({ file, profileId }: { file: ManagedFile; profileId: string }) {
  const [source, setSource] = useState("");
  useEffect(() => {
    let url = "";
    let active = true;
    const load = async () => {
      const query = new URLSearchParams({ profileId, fileId: file.id, preview: "true" });
      const headers: Record<string, string> = {};
      if (file.mimeType.startsWith("video/")) {
        headers.Range = "bytes=0-524287";
      }
      const response = await fetch(`/api/files/content?${query.toString()}`, {
        cache: "no-store",
        credentials: "same-origin",
        headers,
      });
      if (!response.ok || !active) {
        return;
      }
      url = URL.createObjectURL(await response.blob());
      setSource(url);
    };
    load().catch(() => undefined);
    return () => {
      active = false;
      if (url) {
        URL.revokeObjectURL(url);
      }
    };
  }, [file, profileId]);
  const shape = "h-28 w-44 flex-shrink-0 rounded-lg bg-black object-contain";
  if (file.mimeType.startsWith("video/")) {
    return <video className={shape} muted preload="metadata" src={source} />;
  }
  return <img alt="" className={shape} src={source} />;
}

export function FilesPanel({
  profileId,
  tabId,
  picker,
  onClose,
  onNotice,
  onPreview,
  recording,
  onStopRecording,
}: Props) {
  const [files, setFiles] = useState<ManagedFile[]>([]);
  const [progress, setProgress] = useState(
    "Up to 64 MiB per upload. Existing files are never overwritten.",
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [armed, setArmed] = useState("");
  const [link, setLink] = useState({ url: "", name: "" });

  const load = useCallback(async () => {
    setFiles(readFiles(await action("files", {}, null, profileId)));
  }, [profileId]);

  const work = useCallback(
    (task: () => Promise<void>) =>
      asyncHandler(async () => {
        if (busy) {
          return;
        }
        setBusy(true);
        setError("");
        try {
          await task();
        } catch (cause) {
          setError(failure(cause).message);
        } finally {
          setBusy(false);
        }
      }),
    [busy],
  );

  useEffect(() => {
    background(
      load().catch((cause: unknown) => {
        setError(failure(cause).message);
      }),
    );
  }, [load]);

  const save = (file: ManagedFile) =>
    work(async () => {
      const parts: string[] = [];
      let offset = 0;
      for (;;) {
        const part = record(
          await action("read_file", { fileId: file.id, offset }, null, profileId),
        );
        const next = count(part.nextOffset);
        if (next <= offset) {
          break;
        }
        parts.push(atob(text(part.data)));
        offset = next;
        if (offset >= file.bytes) {
          break;
        }
      }
      const binary = parts.join("");
      const bytes = new Uint8Array(new ArrayBuffer(binary.length));
      for (let at = 0; at < binary.length; at++) {
        bytes[at] = binary.codePointAt(at) || 0;
      }
      const url = URL.createObjectURL(new Blob([bytes]));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.id.split("/").pop() || "file";
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });

  const upload = (selected: File[]) =>
    work(async () => {
      for (const file of selected) {
        if (file.size > UPLOAD_LIMIT) {
          throw new Error(`Upload exceeds 64 MiB: ${file.name}`);
        }
        for (let offset = 0; offset < file.size || offset === 0; offset += CHUNK) {
          const chunk = new Uint8Array(await file.slice(offset, offset + CHUNK).arrayBuffer());
          let encoded = "";
          for (const byte of chunk) {
            encoded += String.fromCodePoint(byte);
          }
          await action(
            "stage_file",
            { name: file.name, offset, data: btoa(encoded) },
            null,
            profileId,
          );
          setProgress(
            `Adding ${file.name}: ${Math.min(
              100,
              Math.round(((offset + chunk.length) / Math.max(1, file.size)) * 100),
            )}%`,
          );
          if (!file.size) {
            break;
          }
        }
      }
      setProgress(
        picker
          ? "Files added. Select a file to attach it to this page."
          : "Files added to this session's uploads folder.",
      );
      await load();
    });

  return (
    <section aria-label="Files" className="bg-page absolute inset-0 z-30 overflow-auto p-6">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <Button className="self-start" onPress={onClose} size="sm" variant="ghost">
          <Icon name="back" />
          Back to browser
        </Button>
        <header className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold tracking-tight">Files</h1>
            <p className="text-ink-faint text-sm">
              {picker
                ? "Choose files for this page, or go back to cancel."
                : "Captures, recordings and downloads in this session. Add a file for your agent to attach on a website."}
            </p>
          </div>
          {recording ? (
            <Button onPress={onStopRecording} size="sm" variant="danger-soft">
              Stop recording
            </Button>
          ) : null}
        </header>

        {error ? (
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{error}</Alert.Description>
            </Alert.Content>
          </Alert>
        ) : null}

        <Card>
          <Card.Header>
            <Card.Title>Add files from this device</Card.Title>
            <Card.Description>{progress}</Card.Description>
          </Card.Header>
          <Card.Content>
            <input
              aria-label="Add files from this device"
              className="border-line-field bg-page file:bg-raised file:text-ink w-full rounded-2xl border px-3 py-2.5 text-sm file:mr-3 file:rounded-full file:border-0 file:px-3 file:py-1.5 file:text-sm"
              multiple
              onChange={(event) => {
                const selected = [...(event.target.files || [])];
                event.target.value = "";
                if (selected.length) {
                  upload(selected)();
                }
              }}
              type="file"
            />
          </Card.Content>
        </Card>

        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">In this session</h2>
            <Button
              isDisabled={busy}
              onPress={work(async () => {
                await load();
              })}
              size="sm"
              variant="ghost"
            >
              <Icon name="reload" />
              Refresh
            </Button>
          </div>
          {files.length === 0 ? (
            <p className="text-ink-faint text-sm">
              No files yet. Add one, or save a download link.
            </p>
          ) : null}
          {files.map((file) => {
            const previewable =
              file.mimeType.startsWith("image/") || file.mimeType.startsWith("video/");
            return (
              <Card key={file.id}>
                <Card.Content className="flex flex-wrap items-center gap-4">
                  {previewable ? <Thumbnail file={file} profileId={profileId} /> : null}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      {picker ? (
                        <Checkbox
                          aria-label={`Choose ${file.id}`}
                          isSelected={chosen.includes(file.id)}
                          onChange={(selected) =>
                            setChosen(
                              selected
                                ? [...chosen, file.id]
                                : chosen.filter((id) => id !== file.id),
                            )
                          }
                        />
                      ) : null}
                      <p className="truncate font-medium">{file.id.split("/").pop()}</p>
                    </div>
                    <p className="text-ink-faint text-xs">
                      {[
                        file.mimeType || "File",
                        readable(file.bytes),
                        new Date(file.createdAt).toLocaleString(),
                      ].join(" · ")}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {previewable ? (
                      <Button onPress={() => onPreview(file)} size="sm" variant="ghost">
                        Preview
                      </Button>
                    ) : null}
                    <Button onPress={save(file)} size="sm" variant="ghost">
                      Save copy
                    </Button>
                    <Button
                      onPress={
                        armed === file.id
                          ? work(async () => {
                              await action("delete_file", { fileId: file.id }, null, profileId);
                              setArmed("");
                              await load();
                            })
                          : () => setArmed(file.id)
                      }
                      size="sm"
                      variant={armed === file.id ? "danger" : "danger-soft"}
                    >
                      {armed === file.id ? "Confirm delete" : "Delete"}
                    </Button>
                  </div>
                </Card.Content>
              </Card>
            );
          })}
          {picker ? (
            <Button
              className="self-start"
              onPress={work(async () => {
                if (!chosen.length) {
                  throw new Error("Select a file first.");
                }
                await action("choose_files", { fileIds: chosen }, tabId, profileId);
                onNotice("Files attached to the page.");
                onClose();
              })}
              variant="primary"
            >
              Use selected files
            </Button>
          ) : null}
        </section>

        <Card>
          <Card.Header>
            <Card.Title>Save a download link</Card.Title>
            <Card.Description>
              Fetched with this page's session. Up to 20 MiB; cross-site links require CORS.
            </Card.Description>
          </Card.Header>
          <Card.Content>
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                work(async () => {
                  await action("download", { url: link.url, name: link.name }, tabId, profileId);
                  setLink({ url: "", name: "" });
                  await load();
                  setProgress("Download saved.");
                })();
              }}
            >
              <TextField isRequired>
                <Label>Download URL</Label>
                <Input
                  onChange={(event) => setLink({ ...link, url: event.target.value })}
                  placeholder="https://example.com/report.pdf"
                  value={link.url}
                />
              </TextField>
              <TextField isRequired>
                <Label>Save as</Label>
                <Input
                  maxLength={180}
                  onChange={(event) => setLink({ ...link, name: event.target.value })}
                  placeholder="report.pdf"
                  value={link.name}
                />
              </TextField>
              <Button className="self-start" type="submit" variant="secondary">
                Save to downloads
              </Button>
            </form>
          </Card.Content>
        </Card>
      </div>
    </section>
  );
}
