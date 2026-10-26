/** Native extensions installed in one session; mutations always require a dashboard action. */
import { Button, Chip, Label, Modal, Spinner, Switch } from "@heroui/react";
import { useCallback, useEffect, useRef, useState } from "react";

import { action, failure } from "./api.js";
import { background } from "./async-boundary.js";
import { Icon } from "./icons.js";
import { Group } from "./rows.js";
import { flag, list, record, text } from "./wire.js";

type Extension = {
  id: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  mayEnable: boolean;
  mayDisable: boolean;
  mayRemove: boolean;
  hasOptions: boolean;
};

function readExtension(value: unknown): Extension {
  const entry = record(value);
  return {
    id: text(entry.id),
    name: text(entry.name),
    version: text(entry.version),
    description: text(entry.description),
    enabled: flag(entry.enabled),
    mayEnable: flag(entry.mayEnable),
    mayDisable: flag(entry.mayDisable),
    mayRemove: flag(entry.mayRemove),
    hasOptions: flag(entry.hasOptions),
  };
}

export function ExtensionManager({
  profileId,
  profileName,
  onOpenTab,
  onStore,
}: {
  profileId: string;
  profileName: string;
  onOpenTab: (id: string, profile: string) => void;
  onStore: (profile: string) => Promise<void>;
}) {
  const [extensions, setExtensions] = useState<Extension[]>([]);
  const [available, setAvailable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [inventory, setInventory] = useState<"pending" | "loaded">("pending");
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [removing, setRemoving] = useState<Extension | null>(null);
  const mounted = useRef(true);
  const working = useRef(false);
  const sequence = useRef(0);

  const reload = useCallback(async () => {
    const request = ++sequence.current;
    const result = record(await action("extensions", {}, null, profileId));
    if (!mounted.current || request !== sequence.current) {
      return;
    }
    setInventory("loaded");
    setLoadError("");
    setAvailable(flag(result.available));
    setExtensions(
      list(result.extensions)
        .map(readExtension)
        .toSorted((left, right) => left.name.localeCompare(right.name)),
    );
    setLoading(false);
  }, [profileId]);

  const report = useCallback((cause: unknown) => {
    if (mounted.current) {
      setError(failure(cause).message);
      setLoading(false);
    }
  }, []);

  const reportLoad = useCallback((cause: unknown) => {
    if (mounted.current) {
      setLoadError(failure(cause).message);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    background(reload(), reportLoad);
    const interval = setInterval(() => {
      if (!document.hidden && !working.current) {
        background(reload(), reportLoad);
      }
    }, 5000);
    return () => {
      mounted.current = false;
      sequence.current += 1;
      clearInterval(interval);
    };
  }, [reload, reportLoad]);

  const run = (id: string, task: () => Promise<void>) => {
    if (working.current) {
      return;
    }
    working.current = true;
    sequence.current += 1;
    setBusy(id);
    setError("");
    setNotice("");
    background(
      (async () => {
        try {
          await task();
          if (mounted.current) {
            await reload();
          }
        } catch (cause) {
          report(cause);
        } finally {
          working.current = false;
          if (mounted.current) {
            setBusy("");
          }
        }
      })(),
    );
  };

  return (
    <div className="@container flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-ink-dim text-sm">Installed in {profileName}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            aria-label="Refresh extensions"
            isDisabled={loading || !!busy}
            isIconOnly
            onPress={() => {
              setError("");
              background(reload(), reportLoad);
            }}
            size="sm"
            variant="ghost"
          >
            <Icon name="reload" />
          </Button>
          <Button
            isDisabled={!!busy}
            onPress={() => run("store", () => onStore(profileId))}
            size="sm"
            variant="secondary"
          >
            {busy === "store" ? <Spinner size="sm" /> : <Icon name="globe" />}
            Chrome Web Store
          </Button>
        </div>
      </div>
      {error || loadError ? (
        <p className="text-danger text-sm" role="alert">
          {error || loadError}
        </p>
      ) : null}
      {notice ? (
        <p className="text-ink-dim text-sm" role="status">
          {notice}
        </p>
      ) : null}
      {loading ? (
        <div className="text-ink-dim flex items-center gap-3 py-8" role="status">
          <Spinner size="sm" /> Loading extensions…
        </div>
      ) : inventory === "pending" ? (
        <p className="text-ink-dim text-sm">Could not load extensions. Use Refresh to try again.</p>
      ) : available ? (
        extensions.length ? (
          <Group>
            {extensions.map((entry) => (
              <article
                className="border-line flex flex-col gap-4 border-b px-5 py-5 last:border-b-0"
                key={entry.id}
              >
                <div className="flex items-start gap-3">
                  <Icon className="text-ink-dim mt-1 size-5" name="extensions" />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <h3 className="text-sm font-semibold break-words">{entry.name}</h3>
                      <span className="text-ink-faint text-xs">Version {entry.version}</span>
                    </div>
                    <p className="text-ink-dim text-sm break-words">{entry.description}</p>
                    <p className="text-ink-faint mt-1 text-xs break-all">ID: {entry.id}</p>
                  </div>
                </div>
                <div className="flex flex-col gap-3 @md:flex-row @md:items-center @md:justify-between">
                  <div className="flex items-center gap-3">
                    <Switch
                      aria-label={`Enable ${entry.name}`}
                      isDisabled={!!busy || !(entry.enabled ? entry.mayDisable : entry.mayEnable)}
                      isSelected={entry.enabled}
                      onChange={(enabled) =>
                        run(entry.id, async () => {
                          await action(
                            "extension_set_enabled",
                            { id: entry.id, enabled },
                            null,
                            profileId,
                          );
                          if (mounted.current) {
                            setNotice(`${entry.name} ${enabled ? "enabled" : "disabled"}.`);
                          }
                        })
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
                    {busy === entry.id ? <Spinner size="sm" /> : null}
                    {entry.mayRemove ? null : (
                      <Chip size="sm" variant="soft">
                        Managed
                      </Chip>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {entry.hasOptions ? (
                      <Button
                        aria-label={`Options for ${entry.name}`}
                        isDisabled={!!busy || !entry.enabled}
                        onPress={() =>
                          run(entry.id, async () => {
                            const id = text(
                              await action("extension_options", { id: entry.id }, null, profileId),
                            );
                            if (mounted.current) {
                              onOpenTab(id, profileId);
                            }
                          })
                        }
                        size="sm"
                        variant="secondary"
                      >
                        Options
                      </Button>
                    ) : null}
                    <Button
                      aria-label={`Remove ${entry.name}`}
                      isDisabled={!!busy || !entry.mayRemove}
                      onPress={() => {
                        setError("");
                        setRemoving(entry);
                      }}
                      size="sm"
                      variant="ghost"
                    >
                      Remove
                    </Button>
                  </div>
                </div>
                {!entry.enabled && !entry.mayEnable ? (
                  <p className="text-ink-faint text-xs">
                    This extension requires a browser policy or permissions review before it can be
                    enabled.
                  </p>
                ) : null}
              </article>
            ))}
          </Group>
        ) : (
          <div className="border-line flex flex-col items-start gap-2 rounded-3xl border px-6 py-8">
            <h3 className="text-sm font-semibold">No extensions installed</h3>
            <p className="text-ink-dim max-w-prose text-sm">
              Add an extension from the Chrome Web Store. Its permissions will appear here for your
              approval.
            </p>
          </div>
        )
      ) : (
        <div className="border-line flex flex-col gap-2 rounded-3xl border px-6 py-6">
          <h3 className="text-sm font-semibold">Extension management is unavailable</h3>
          <p className="text-ink-dim text-sm">
            This browser build does not support managing extensions. Try again after updating the
            browser.
          </p>
        </div>
      )}
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
                <Modal.Heading>Remove {removing?.name}?</Modal.Heading>
                <Modal.CloseTrigger isDisabled={!!busy} />
              </Modal.Header>
              <Modal.Body>
                {error ? (
                  <p className="text-danger text-sm" role="alert">
                    {error}
                  </p>
                ) : null}
                <p className="text-ink-dim text-sm">
                  This removes the extension and its saved data from {profileName}. Other sessions
                  are not affected.
                </p>
                <div className="mt-5 flex justify-end gap-2">
                  <Button isDisabled={!!busy} onPress={() => setRemoving(null)} variant="ghost">
                    Cancel
                  </Button>
                  <Button
                    isDisabled={!!busy}
                    onPress={() => {
                      if (removing) {
                        const entry = removing;
                        run(entry.id, async () => {
                          await action(
                            "extension_remove",
                            { id: entry.id, confirmed: true },
                            null,
                            profileId,
                          );
                          if (mounted.current) {
                            setRemoving(null);
                            setNotice(`${entry.name} removed.`);
                          }
                        });
                      }
                    }}
                    variant="danger"
                  >
                    {busy ? "Removing…" : "Remove extension"}
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
