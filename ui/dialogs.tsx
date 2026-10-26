/** The dashboard's dialogs: a session, the clipboard, saved media, an agent's request. */
import { Alert, Button, Input, Label, Modal, TextArea, TextField } from "@heroui/react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";

import { action, failure } from "./api.js";
import { asyncHandler, background } from "./async-boundary.js";
import type { JsDialog } from "./model.js";
import { record, text } from "./wire.js";

type Shell = {
  children: ReactNode;
  isOpen: boolean;
  onClose: () => void;
  title: string;
  size?: "sm" | "md" | "lg";
};

/** A website's blocking dialog, resolved through its native callback. */
export function WebsiteDialog({
  dialog,
  profileId,
  tabId,
  onResolved,
}: {
  dialog: JsDialog;
  profileId: string;
  tabId: string;
  onResolved: () => Promise<void>;
}) {
  const [value, setValue] = useState(dialog.defaultPromptText);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const resolve = async (accept: boolean) => {
    if (busy) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      await action("js_dialog", { id: dialog.id, accept, promptText: value }, tabId, profileId);
      await onResolved();
    } catch (cause) {
      setError(failure(cause).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      isOpen
      onOpenChange={(open) => {
        if (!open) {
          background(resolve(false));
        }
      }}
    >
      <Modal.Backdrop isDismissable={false}>
        <Modal.Container size="sm">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>
                {dialog.type === "prompt"
                  ? "Website prompt"
                  : dialog.type === "confirm"
                    ? "Confirm action"
                    : "Website message"}
              </Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <form
                className="flex flex-col gap-4"
                onSubmit={asyncHandler(async (event: { preventDefault: () => void }) => {
                  event.preventDefault();
                  await resolve(true);
                })}
              >
                {dialog.origin ? (
                  <p className="text-ink-faint text-sm break-words">{dialog.origin}</p>
                ) : null}
                <p className="max-h-[40dvh] overflow-auto break-words whitespace-pre-wrap">
                  {dialog.message}
                </p>
                {dialog.type === "prompt" ? (
                  <TextField isDisabled={busy}>
                    <Label>Your response</Label>
                    <Input
                      autoFocus
                      maxLength={8192}
                      value={value}
                      onChange={(event) => setValue(event.target.value)}
                    />
                  </TextField>
                ) : null}
                {error ? (
                  <p className="text-danger text-sm" role="alert">
                    {error}
                  </p>
                ) : null}
                <div className="flex justify-end gap-2">
                  {dialog.type !== "alert" && (
                    <Button
                      isDisabled={busy}
                      variant="ghost"
                      onPress={asyncHandler(async () => {
                        await resolve(false);
                      })}
                    >
                      Cancel
                    </Button>
                  )}
                  <Button
                    autoFocus={dialog.type !== "prompt"}
                    isDisabled={busy}
                    type="submit"
                    variant="primary"
                  >
                    {busy ? "Responding…" : "OK"}
                  </Button>
                </div>
              </form>
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

function Overlay({ children, isOpen, onClose, title, size = "md" }: Shell) {
  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <Modal.Backdrop>
        <Modal.Container size={size}>
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>{title}</Modal.Heading>
              <Modal.CloseTrigger />
            </Modal.Header>
            <Modal.Body>{children}</Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

export function NewProfileDialog({
  isOpen,
  onClose,
  onCreate,
}: {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (isOpen) {
      setName("");
      setError("");
    }
  }, [isOpen]);
  return (
    <Overlay isOpen={isOpen} onClose={onClose} title="New session" size="sm">
      <form
        className="flex flex-col gap-4"
        onSubmit={asyncHandler(async (event: { preventDefault: () => void }) => {
          event.preventDefault();
          try {
            await onCreate(name);
          } catch (cause) {
            setError(failure(cause).message);
          }
        })}
      >
        <p className="text-ink-faint text-sm">
          Each session keeps its own websites, sign-ins and storage.
        </p>
        <TextField isRequired>
          <Label>Session name</Label>
          <Input
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Personal"
            value={name}
          />
        </TextField>
        {error ? <p className="text-danger text-sm">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button onPress={onClose} variant="ghost">
            Cancel
          </Button>
          <Button isDisabled={!name.trim()} type="submit" variant="primary">
            Create session
          </Button>
        </div>
      </form>
    </Overlay>
  );
}

/** Text moves between the page and the device through this session's own clipboard. */
export function ClipboardDialog({
  isOpen,
  onClose,
  profileId,
  tabId,
}: {
  isOpen: boolean;
  onClose: () => void;
  profileId: string;
  tabId: string;
}) {
  const [value, setValue] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    setStatus("");
    setError("");
    const read = async () => {
      try {
        setValue(text(record(await action("clipboard_read", {}, tabId, profileId)).text));
      } catch (cause) {
        setError(failure(cause).message);
      }
    };
    background(read());
  }, [isOpen, profileId, tabId]);

  const run = (work: () => Promise<void>) =>
    asyncHandler(async () => {
      setError("");
      try {
        await work();
      } catch (cause) {
        setError(failure(cause).message);
      }
    });

  return (
    <Overlay isOpen={isOpen} onClose={onClose} title="Clipboard">
      <div className="flex flex-col gap-4">
        <p className="text-ink-faint text-sm">
          Copy what the page has selected, or paste text into the field it has focused.
        </p>
        <TextField>
          <Label>Clipboard text</Label>
          <TextArea
            maxLength={8192}
            onChange={(event) => setValue(event.target.value)}
            rows={6}
            value={value}
          />
        </TextField>
        {status ? <p className="text-success text-sm">{status}</p> : null}
        {error ? <p className="text-danger text-sm">{error}</p> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            onPress={run(async () => {
              await action("clipboard_copy", {}, tabId, profileId);
              setValue(text(record(await action("clipboard_read", {}, tabId, profileId)).text));
              setStatus("Copied the page selection.");
            })}
            variant="secondary"
          >
            Copy from browser
          </Button>
          <Button
            onPress={run(async () => {
              try {
                await navigator.clipboard.writeText(value);
                setStatus("Copied to your device.");
              } catch {
                setStatus("Select the text above and use your device's Copy action.");
              }
            })}
            variant="secondary"
          >
            Copy to device
          </Button>
          <Button
            onPress={run(async () => {
              await action("clipboard_write", { text: value }, tabId, profileId);
              await action("clipboard_paste", {}, tabId, profileId);
              setStatus("Pasted into the browser.");
            })}
            variant="primary"
          >
            Paste into browser
          </Button>
        </div>
      </div>
    </Overlay>
  );
}

/** A saved capture or recording, fetched with the dashboard's own credentials. */
export function MediaDialog({
  file,
  onClose,
  profileId,
}: {
  file: { id: string; mimeType: string } | null;
  onClose: () => void;
  profileId: string;
}) {
  const [source, setSource] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (!file) {
      setSource("");
      return;
    }
    let url = "";
    let active = true;
    const load = async () => {
      const query = new URLSearchParams({ profileId, fileId: file.id, preview: "true" });
      const response = await fetch(`/api/files/content?${query.toString()}`, {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!response.ok) {
        throw new Error("File preview unavailable. Refresh the file list.");
      }
      const blob = await response.blob();
      if (!active) {
        return;
      }
      url = URL.createObjectURL(blob);
      setSource(url);
    };
    setError("");
    load().catch((cause: unknown) => {
      setError(failure(cause).message);
    });
    return () => {
      active = false;
      if (url) {
        URL.revokeObjectURL(url);
      }
    };
  }, [file, profileId]);

  return (
    <Overlay
      isOpen={!!file}
      onClose={onClose}
      size="lg"
      title={file?.id.split("/").pop() || "Saved media"}
    >
      {error ? <p className="text-danger text-sm">{error}</p> : null}
      {file?.mimeType.startsWith("video/") ? (
        <video
          className="max-h-[70dvh] w-full rounded-lg bg-black"
          controls
          playsInline
          src={source}
        />
      ) : (
        <img
          alt="Saved capture"
          className="max-h-[70dvh] w-full rounded-lg bg-black object-contain"
          src={source}
        />
      )}
    </Overlay>
  );
}

/** An agent asking for a tab a person is holding. */
export function HandoffDialog({
  seconds,
  isOpen,
  error,
  onCancel,
}: {
  seconds: number;
  isOpen: boolean;
  error: string;
  onCancel: () => void;
}) {
  return (
    <Modal isOpen={isOpen}>
      <Modal.Backdrop isDismissable={false}>
        <Modal.Container size="sm">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>The agent wants control</Modal.Heading>
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-4">
              <p className="text-ink-faint text-sm">
                Cancel to keep browsing. Otherwise your input pauses while the agent uses this tab.
              </p>
              <p className="text-warning font-medium tabular-nums">
                Returning control in {seconds} seconds
              </p>
              {error ? (
                <Alert status="danger">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Description>{error}</Alert.Description>
                  </Alert.Content>
                </Alert>
              ) : null}
              <Button autoFocus onPress={onCancel} variant="primary">
                Cancel · keep control
              </Button>
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
