/** Installation permission decisions belong to the dashboard, outside the remote page. */
import { Button, Modal } from "@heroui/react";
import { useEffect, useRef, useState } from "react";

import { action, failure } from "./api.js";
import { background } from "./async-boundary.js";
import { list, record, text } from "./wire.js";

type Request = {
  id: string;
  tabId: string;
  extensionId: string;
  name: string;
  version: string;
  origin: string;
  permissions: string[];
};

function readRequest(value: unknown): Request {
  const request = record(value);
  return {
    id: text(request.id),
    tabId: text(request.tabId),
    extensionId: text(request.extensionId),
    name: text(request.name),
    version: text(request.version),
    origin: text(request.origin),
    permissions: list(request.permissions).map((permission) => text(permission)),
  };
}

function Decision({
  request,
  profileId,
  onResolved,
}: {
  request: Request;
  profileId: string;
  onResolved: (id: string, allowed: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  useEffect(() => {
    // Match Chrome's short install-button delay so the click that opened the
    // permission prompt cannot accidentally confirm it as well.
    const delay = setTimeout(() => setReady(true), 500);
    return () => clearTimeout(delay);
  }, []);
  const decide = (allow: boolean) => {
    if (busy || (allow && !ready)) {
      return;
    }
    setBusy(true);
    setError("");
    background(
      (async () => {
        try {
          await action(
            "extension_install_decide",
            { id: request.id, allow },
            request.tabId,
            profileId,
          );
          onResolved(request.id, allow);
        } catch (cause) {
          setError(failure(cause).message);
        } finally {
          setBusy(false);
        }
      })(),
    );
  };

  return (
    <Modal
      isOpen
      onOpenChange={(open) => {
        if (!open) {
          decide(false);
        }
      }}
    >
      <Modal.Backdrop>
        <Modal.Container size="md">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>Install {request.name}?</Modal.Heading>
              <Modal.CloseTrigger isDisabled={busy} />
            </Modal.Header>
            <Modal.Body>
              <div className="flex flex-col gap-4">
                <p className="text-ink-faint text-sm">
                  Version {request.version} from {request.origin}
                </p>
                {request.permissions.length > 0 ? (
                  <div className="flex flex-col gap-2">
                    <p className="text-sm font-medium">This extension requests permission to:</p>
                    <ul className="list-disc space-y-2 pl-5 text-sm">
                      {request.permissions.map((permission) => (
                        <li className="break-words whitespace-pre-line" key={permission}>
                          {permission}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="text-sm">
                    This extension requests no additional permission warnings.
                  </p>
                )}
                <p className="text-ink-faint text-sm break-all">
                  Extension ID: {request.extensionId}
                </p>
                {error ? (
                  <p className="text-danger text-sm" role="alert">
                    {error}
                  </p>
                ) : null}
                <div className="flex justify-end gap-2">
                  <Button isDisabled={busy} onPress={() => decide(false)} variant="ghost">
                    Cancel
                  </Button>
                  <Button
                    isDisabled={busy || !ready}
                    onPress={() => decide(true)}
                    variant="primary"
                  >
                    {busy ? "Submitting…" : "Install extension"}
                  </Button>
                </div>
              </div>
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

export function ExtensionInstalls({
  profileId,
  onNotice,
}: {
  profileId: string;
  onNotice: (message: string) => void;
}) {
  const [requests, setRequests] = useState<Request[]>([]);
  const resolved = useRef(new Set<string>());
  useEffect(() => {
    let live = true;
    let running = false;
    let unavailable = false;
    const refresh = async () => {
      if (running || unavailable || document.hidden) {
        return;
      }
      running = true;
      try {
        const status = record(await action("extension_installs", {}, null, profileId));
        if (live) {
          unavailable = status.available === false;
          setRequests(
            list(status.requests)
              .map(readRequest)
              .filter((request) => !resolved.current.has(request.id)),
          );
        }
      } catch {
        // A transient engine operation leaves the existing decision visible. Its
        // native token is still checked when submitted, and a later poll reconciles it.
      } finally {
        running = false;
      }
    };
    background(refresh());
    const interval = setInterval(() => background(refresh()), 1000);
    return () => {
      live = false;
      clearInterval(interval);
    };
  }, [profileId]);
  const request = requests[0];
  return request ? (
    <Decision
      key={request.id}
      onResolved={(id, allowed) => {
        resolved.current.add(id);
        setRequests((current) => current.filter((entry) => entry.id !== id));
        onNotice(
          allowed
            ? "Installation approved. Check the store for completion."
            : "Extension installation cancelled.",
        );
      }}
      profileId={profileId}
      request={request}
    />
  ) : null;
}
