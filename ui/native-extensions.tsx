/** Built-in browser features share the extension list and own their Settings pages. */
import { Button, Chip, Label, Modal, Spinner, Switch } from "@heroui/react";
import { useCallback, useEffect, useRef, useState } from "react";

import { api, failure } from "./api.js";
import { background } from "./async-boundary.js";
import { Icon } from "./icons.js";
import { Keys } from "./keys.js";
import type { Profile } from "./model.js";
import { Group, Row } from "./rows.js";
import { flag, list, record, text } from "./wire.js";

export type NativeExtension = {
  id: string;
  name: string;
  description: string;
  installed: boolean;
  enabled: boolean;
  configured: boolean;
  username: string;
};

function readExtension(value: unknown): NativeExtension {
  const entry = record(value);
  return {
    id: text(entry.id),
    name: text(entry.name),
    description: text(entry.description),
    installed: flag(entry.installed),
    enabled: flag(entry.enabled),
    configured: flag(entry.configured),
    username: text(entry.username),
  };
}

export function useNativeExtensions() {
  const [entries, setEntries] = useState<NativeExtension[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const mounted = useRef(false);
  const working = useRef(false);
  const sequence = useRef(0);

  const reload = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const result = record(await api("/api/extensions/native"));
      if (mounted.current && request === sequence.current) {
        setEntries(list(result.extensions).map(readExtension));
        setLoadError("");
      }
    } catch (cause) {
      if (mounted.current && request === sequence.current) {
        setLoadError(failure(cause).message);
      }
    } finally {
      if (mounted.current && request === sequence.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    background(reload());
    const interval = setInterval(() => {
      if (!document.hidden && !working.current) {
        background(reload());
      }
    }, 5000);
    return () => {
      mounted.current = false;
      sequence.current += 1;
      clearInterval(interval);
    };
  }, [reload]);

  const change = async (id: string, action: string) => {
    if (working.current) {
      return false;
    }
    working.current = true;
    sequence.current += 1;
    setBusy(true);
    setError("");
    try {
      const value = await api("/api/extensions/native", {
        id,
        action,
        ...(action === "uninstall" ? { confirmed: true } : {}),
      });
      if (mounted.current) {
        const updated = readExtension(value);
        setEntries((current) =>
          current.map((entry) => (entry.id === updated.id ? updated : entry)),
        );
        setLoadError("");
      }
      return true;
    } catch (cause) {
      if (mounted.current) {
        setError(failure(cause).message);
      }
      return false;
    } finally {
      working.current = false;
      if (mounted.current) {
        setBusy(false);
      }
    }
  };

  return { entries, loading, busy, error: error || loadError, reload, change };
}

export type NativeState = ReturnType<typeof useNativeExtensions>;

export function NativeExtensionList({
  state,
  onSettings,
}: {
  state: NativeState;
  onSettings: (id: string) => void;
}) {
  const [removing, setRemoving] = useState<NativeExtension | null>(null);
  const { entries, loading, busy, error, change, reload } = state;
  return (
    <div className="flex flex-col gap-3">
      <Group
        description="Optional features included with this browser. Apply to every session."
        title="Native extensions"
      >
        {loading ? (
          <div className="text-ink-dim flex items-center gap-3 px-6 py-5" role="status">
            <Spinner size="sm" /> Loading native extensions…
          </div>
        ) : entries.length ? (
          entries.map((entry) => (
            <article
              className="border-line @container flex flex-col gap-4 border-b px-5 py-5 last:border-b-0"
              key={entry.id}
            >
              <div className="flex items-start gap-3">
                <Icon className="text-ink-dim mt-1 size-5" name="extensions" />
                <div className="flex min-w-0 flex-col gap-1">
                  <h3 className="text-sm font-semibold">{entry.name}</h3>
                  <p className="text-ink-dim text-sm">{entry.description}</p>
                  {entry.id === "access" && entry.installed && !entry.configured ? (
                    <p className="text-ink-faint text-xs">
                      Set up a login in Settings before enabling Access.
                    </p>
                  ) : null}
                </div>
              </div>
              <div className="flex flex-col gap-3 @md:flex-row @md:items-center @md:justify-between">
                {entry.installed ? (
                  <Switch
                    aria-label={`Enable ${entry.name}`}
                    isDisabled={busy || (entry.id === "access" && !entry.configured)}
                    isSelected={entry.enabled}
                    onChange={(enabled) =>
                      background(change(entry.id, enabled ? "enable" : "disable"))
                    }
                    size="sm"
                  >
                    <Switch.Content>
                      <Switch.Control>
                        <Switch.Thumb />
                      </Switch.Control>
                      <Label>{entry.enabled ? "Enabled" : "Disabled"}</Label>
                    </Switch.Content>
                  </Switch>
                ) : (
                  <span className="text-ink-faint text-sm">Available to install</span>
                )}
                <div className="flex items-center gap-2">
                  {busy ? <Spinner size="sm" /> : null}
                  {entry.installed ? (
                    <>
                      <Button
                        isDisabled={busy}
                        onPress={() => onSettings(entry.id)}
                        size="sm"
                        variant="secondary"
                      >
                        Settings
                      </Button>
                      <Button
                        isDisabled={busy}
                        onPress={() => setRemoving(entry)}
                        size="sm"
                        variant="ghost"
                      >
                        Uninstall
                      </Button>
                    </>
                  ) : (
                    <Button
                      isDisabled={busy}
                      onPress={() => background(change(entry.id, "install"))}
                      size="sm"
                      variant="secondary"
                    >
                      Install {entry.name}
                    </Button>
                  )}
                </div>
              </div>
            </article>
          ))
        ) : (
          <Row description="Refresh to try again." title="Native extensions could not be loaded">
            <Button onPress={() => background(reload())} size="sm" variant="secondary">
              Refresh
            </Button>
          </Row>
        )}
      </Group>
      {error ? (
        <p className="text-danger text-sm" role="alert">
          {error}
        </p>
      ) : null}
      <Modal
        isOpen={!!removing}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setRemoving(null);
          }
        }}
      >
        <Modal.Backdrop>
          <Modal.Container size="sm">
            <Modal.Dialog>
              <Modal.Header>
                <Modal.Heading>Uninstall {removing?.name}?</Modal.Heading>
                <Modal.CloseTrigger isDisabled={busy} />
              </Modal.Header>
              <Modal.Body>
                <p className="text-ink-dim text-sm">
                  {removing?.id === "mcp"
                    ? "Agents will lose access through MCP. Its saved API keys are kept for a later reinstall."
                    : "Browser login will be disabled. Its saved login configuration is kept for a later reinstall."}{" "}
                  The extension’s Settings page will be removed.
                </p>
                {error ? (
                  <p className="text-danger mt-3 text-sm" role="alert">
                    {error}
                  </p>
                ) : null}
                <div className="mt-5 flex justify-end gap-2">
                  <Button isDisabled={busy} onPress={() => setRemoving(null)} variant="ghost">
                    Cancel
                  </Button>
                  <Button
                    isDisabled={busy}
                    onPress={() =>
                      background(
                        (async () => {
                          if (removing && (await change(removing.id, "uninstall"))) {
                            setRemoving(null);
                          }
                        })(),
                      )
                    }
                    variant="danger"
                  >
                    {busy ? "Uninstalling…" : `Uninstall ${removing?.name || "extension"}`}
                  </Button>
                </div>
              </Modal.Body>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </div>
  );
}

export function McpSettings({
  entry,
  endpoint,
  profiles,
}: {
  entry: NativeExtension;
  endpoint: string;
  profiles: Profile[];
}) {
  return (
    <>
      <Group title="MCP extension">
        <Row
          description="Connection settings and API keys belong to this extension."
          title="Agent connections"
        >
          <Chip variant="soft">{entry.enabled ? "Enabled" : "Disabled"}</Chip>
        </Row>
      </Group>
      {entry.enabled ? null : (
        <p className="text-ink-dim text-sm" role="status">
          MCP connections are disabled. Enable MCP in Extensions when you are ready. Configuration
          and API keys are kept.
        </p>
      )}
      <Keys endpoint={endpoint} profiles={profiles} />
      <Group description="Control which sessions each agent can reach." title="Agent permissions">
        <Row
          description="HTTP clients must provide an API key. Each key reaches one session or every session, including future ones."
          title="Agent permissions"
        >
          <Icon name="lock" />
        </Row>
        <Row
          description="The connection is available only on this machine. The local browser dashboard remains accessible independently of MCP."
          title="Local connection"
        >
          <Chip variant="soft">Loopback only</Chip>
        </Row>
      </Group>
    </>
  );
}
