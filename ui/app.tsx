/** The dashboard: one browser, its tabs, and the people and agents sharing it. */
import { useCallback, useEffect, useRef, useState } from "react";

import type { Tone } from "./alert.js";
import { Alert } from "./alert.js";
import { action, api, failure, whenUnauthorized } from "./api.js";
import { asyncHandler, background } from "./async-boundary.js";
import { Chrome } from "./chrome.js";
import { ClipboardDialog, HandoffDialog, MediaDialog, NewProfileDialog } from "./dialogs.js";
import { Display } from "./display.js";
import { ExtensionInstalls } from "./extensions.js";
import { FilesPanel } from "./files.js";
import { Icon } from "./icons.js";
import type { Health, ManagedFile, Policy, Profile, Tab } from "./model.js";
import { editable, origin, readHealth, readPolicy, readProfile, readTab } from "./model.js";
import type { SettingsSection } from "./settings.js";
import { Settings } from "./settings.js";
import { TabStrip } from "./tabs.js";
import { flag, list, record, text } from "./wire.js";

const TABS_INTERVAL = 1000;
const HEALTH_INTERVAL = 15_000;
const RECORDING_INTERVAL = 3000;
const HANDOFF_INTERVAL = 1000;

type Handoff = { id: string; tabId: string; profileId: string; seconds: number };

export function App() {
  const [phase, setPhase] = useState<"loading" | "closed" | "ready">("loading");
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileId, setProfileId] = useState("");
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [tabId, setTabId] = useState("");
  const [note, setNote] = useState<{ tone: Tone; text: string } | null>(null);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [healthNote, setHealthNote] = useState("Checking the session");
  const [ready, setReady] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [dialog, setDialog] = useState<"" | "profile" | "clipboard">("");
  const [panel, setPanel] = useState<"" | "files" | "settings">("");
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("sessions");
  const [preview, setPreview] = useState<ManagedFile | null>(null);
  const [surface, setSurface] = useState("—");
  const [recording, setRecording] = useState(false);
  const [recordedProfile, setRecordedProfile] = useState("");
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const [handoffError, setHandoffError] = useState("");
  const live = useRef({ profileId, tabId, profiles, tabs });
  live.current = { profileId, tabId, profiles, tabs };

  const tab = tabs.find((candidate) => candidate.id === tabId);
  const interactive = editable(tab) && ready;

  const report = useCallback((cause: unknown) => {
    setNote({ tone: "danger", text: failure(cause).message });
  }, []);
  /** Something worked and is worth saying once. */
  const done = useCallback((message: string) => {
    setNote({ tone: "success", text: message });
  }, []);
  /** Something is under way, or the page is asking for patience. */
  const inform = useCallback((message: string) => {
    setNote(message ? { tone: "info", text: message } : null);
  }, []);
  /** The display could not do what was asked, or is asking for patience. Kept stable,
   *  because the display watches it and would restart its frames with every new one. */
  const warn = useCallback((message: string) => {
    setNote({ tone: "warning", text: message });
  }, []);

  /** Nothing to sign in to: without this browser's own address there is simply no way in. */
  const showClosed = useCallback(() => {
    setPanel("");
    setDialog("");
    setPhase("closed");
  }, []);

  const refresh = useCallback(async (profile: string) => {
    const current = list(await action("tabs", {}, null, profile)).map(readTab);
    if (profile !== live.current.profileId) {
      return;
    }
    setTabs(current);
    setTabId((selected) => {
      if (current.some((candidate) => candidate.id === selected)) {
        return selected;
      }
      return current.find((candidate) => candidate.active)?.id || current[0]?.id || "";
    });
  }, []);

  const selectProfile = useCallback(
    async (id: string) => {
      setProfileId(id);
      setTabs([]);
      setTabId("");
      setReady(false);
      setHealth(null);
      live.current.profileId = id;
      const saved = record(await api("/api/policies", { profileId: id }));
      if (live.current.profileId !== id) {
        return;
      }
      const found = list(saved.policies).map(readPolicy);
      setPolicies(found);
      setHealthNote(found.length ? "Checking the session" : "No session check");
      await refresh(id);
    },
    [refresh],
  );

  const connect = useCallback(async () => {
    try {
      const catalog = list(record(await api("/api/profiles")).profiles).map(readProfile);
      setProfiles(catalog);
      const preferred =
        catalog.find((profile) => profile.id === live.current.profileId) ||
        catalog.find((profile) => profile.isDefault) ||
        catalog[0];
      setPhase("ready");
      if (preferred) {
        await selectProfile(preferred.id);
      }
    } catch (cause) {
      report(cause);
      showClosed();
    }
  }, [report, selectProfile, showClosed]);

  useEffect(() => {
    whenUnauthorized(showClosed);
    background(connect(), report);
  }, [connect, report, showClosed]);

  const checkHealth = useCallback(async () => {
    const current = live.current.tabs.find((candidate) => candidate.id === live.current.tabId);
    const here = current ? origin(current.url) : null;
    if (!here) {
      return;
    }
    const policy = policies.find((candidate) => origin(candidate.origin) === here);
    if (!policy) {
      setHealth(null);
      setHealthNote("No session check for this site");
      return;
    }
    try {
      setHealth(
        readHealth(
          await action("health", { ...policy }, live.current.tabId, live.current.profileId),
        ),
      );
    } catch (cause) {
      if (!/busy/iu.test(failure(cause).message)) {
        setHealth(null);
        setHealthNote("Session check unavailable");
      }
    }
  }, [policies]);

  // Tabs, session health, recording and handoff requests are polled; frames are not, so a
  // page that moves reaches the display without waiting for the next poll.
  useEffect(() => {
    if (phase !== "ready" || !profileId) {
      return;
    }
    const tick = setInterval(
      asyncHandler(async () => {
        if (document.hidden) {
          return;
        }
        try {
          await refresh(live.current.profileId);
        } catch (cause) {
          report(cause);
        }
      }),
      TABS_INTERVAL,
    );
    const healthTick = setInterval(asyncHandler(checkHealth), HEALTH_INTERVAL);
    background(checkHealth());
    return () => {
      clearInterval(tick);
      clearInterval(healthTick);
    };
  }, [phase, profileId, refresh, report, checkHealth]);

  useEffect(() => {
    if (phase !== "ready") {
      return;
    }
    const look = asyncHandler(async () => {
      let anywhere = "";
      for (const profile of new Set([
        live.current.profileId,
        ...live.current.profiles.map((entry) => entry.id),
      ])) {
        if (!profile) {
          continue;
        }
        try {
          const status = record(await action("record_status", {}, null, profile));
          if (flag(status.active)) {
            anywhere ||= profile;
            if (profile === live.current.profileId) {
              setRecording(true);
            }
          } else if (profile === live.current.profileId) {
            setRecording(false);
          }
        } catch {
          /* A profile that cannot report keeps its last known state. */
        }
      }
      setRecordedProfile(anywhere);
    });
    const tick = setInterval(look, RECORDING_INTERVAL);
    look();
    return () => clearInterval(tick);
  }, [phase]);

  useEffect(() => {
    if (phase !== "ready") {
      return;
    }
    const poll = asyncHandler(async () => {
      if (document.hidden) {
        return;
      }
      for (const profile of new Set([
        live.current.profileId,
        ...live.current.profiles.map((entry) => entry.id),
      ])) {
        if (!profile) {
          continue;
        }
        let waiting: Record<string, unknown> | null = null;
        try {
          const state = record(await action("handoff_status", {}, null, profile));
          waiting =
            list(state.requests)
              .map(record)
              .find((item) => !!text(item.id)) || null;
        } catch {
          continue;
        }
        if (!waiting) {
          continue;
        }
        const id = text(waiting.id);
        const target = text(waiting.tabId);
        const deadline = typeof waiting.deadline === "number" ? waiting.deadline : 0;
        setHandoffError("");
        setHandoff({
          id,
          tabId: target,
          profileId: profile,
          seconds: deadline ? Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) : 5,
        });
        try {
          await action("handoff_ack", { id }, target, profile);
        } catch (cause) {
          setHandoffError(failure(cause).message);
        }
        return;
      }
      setHandoff(null);
    });
    const tick = setInterval(poll, HANDOFF_INTERVAL);
    return () => clearInterval(tick);
  }, [phase]);

  const guard = useCallback(
    (work: () => Promise<void>) =>
      asyncHandler(async () => {
        try {
          await work();
        } catch (cause) {
          report(cause);
        }
      }),
    [report],
  );

  const openTab = guard(async () => {
    const profile = live.current.profileId;
    const id = text(await action("open", {}, null, profile));
    await action("view", {}, id, profile);
    if (profile !== live.current.profileId) {
      return;
    }
    setTabId(id);
    setReady(false);
    await refresh(profile);
  });

  const selectTab = (id: string) =>
    guard(async () => {
      const profile = live.current.profileId;
      await action("view", {}, id, profile);
      if (profile !== live.current.profileId) {
        return;
      }
      setTabId(id);
      setReady(false);
      setNote(null);
      await refresh(profile);
    })();

  const closeTab = (id: string) =>
    guard(async () => {
      const profile = live.current.profileId;
      await action("close", {}, id, profile);
      await refresh(profile);
    })();

  const navigate = (value: string) =>
    guard(async () => {
      if (!value) {
        return;
      }
      const url = value.includes(":") ? value : `https://${value}`;
      const profile = live.current.profileId;
      const target = live.current.tabId;
      await action("navigate", { url }, target, profile);
      setNote(null);
      await refresh(profile);
      await checkHealth();
    })();

  const history = (op: "back" | "forward" | "reload") =>
    guard(async () => {
      const profile = live.current.profileId;
      await action(op, {}, live.current.tabId, profile);
      await refresh(profile);
      await checkHealth();
    })();

  const menu = (key: string) => {
    if (key === "clipboard") {
      setDialog("clipboard");
      return;
    }
    if (key === "new-profile") {
      setDialog("profile");
      return;
    }
    if (key === "extensions") {
      setSettingsSection("extensions");
      setPanel("settings");
      return;
    }
    if (key === "files" || key === "settings") {
      setSettingsSection("sessions");
      setPanel(key);
      return;
    }
    if (key === "reconnect") {
      setReady(false);
      setEpoch((value) => value + 1);
      return;
    }
    if (key === "screenshot") {
      guard(async () => {
        const saved = record(
          await action(
            "save_screenshot",
            { name: `Page capture-${Date.now()}.png` },
            live.current.tabId,
            live.current.profileId,
          ),
        );
        done(`Screenshot saved in Files: ${text(saved.id, text(saved.path))}`);
      })();
      return;
    }
    if (key === "recording") {
      guard(async () => {
        const profile = live.current.profileId;
        if (recording) {
          await action("record_stop", {}, live.current.tabId, profile);
          setRecording(false);
          done("Recording saved in Files.");
        } else {
          await action(
            "record_start",
            { name: `Browser recording-${Date.now()}.mp4`, maxSeconds: 300 },
            live.current.tabId,
            profile,
          );
          setRecording(true);
        }
      })();
    }
  };

  const ownership = (op: "take" | "return") =>
    guard(async () => {
      const profile = live.current.profileId;
      if (op === "take") {
        inform("Waiting for the current action to finish…");
      }
      await action(op, {}, live.current.tabId, profile);
      setNote(null);
      await refresh(profile);
    })();

  /** Copy and cut belong to the page, not to the dashboard around it. */
  const shortcut = useCallback(
    (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !["c", "x"].includes(event.key.toLowerCase())) {
        return false;
      }
      event.preventDefault();
      guard(async () => {
        const profile = live.current.profileId;
        const target = live.current.tabId;
        await action(
          event.key.toLowerCase() === "x" ? "clipboard_cut" : "clipboard_copy",
          {},
          target,
          profile,
        );
        const copied = text(record(await action("clipboard_read", {}, target, profile)).text);
        if (copied) {
          try {
            await navigator.clipboard.writeText(copied);
            done("Copied to your device.");
          } catch {
            inform("Copied in the browser. Open Clipboard to copy it to this device.");
          }
        }
      })();
      return true;
    },
    [guard],
  );

  const paste = useCallback(
    (value: string) =>
      guard(async () => {
        const profile = live.current.profileId;
        const target = live.current.tabId;
        await action("clipboard_write", { text: value }, target, profile);
        await action("clipboard_paste", {}, target, profile);
      })(),
    [guard],
  );

  // A page asking for files opens the panel, as a file dialog would.
  useEffect(() => {
    if (tab?.filePicker && !panel && !dialog) {
      setPanel("files");
    }
  }, [tab?.filePicker, panel, dialog]);

  if (phase === "loading") {
    return <main className="bg-page h-dvh" />;
  }
  if (phase === "closed") {
    return (
      <main className="bg-page grid min-h-dvh place-items-center px-6 py-8">
        <section aria-labelledby="closed-title" className="w-full max-w-96">
          <div className="mb-10 flex items-center gap-2.5 text-sm font-semibold">
            <span className="border-line-strong bg-card grid size-10 place-items-center rounded-[14px] border">
              <Icon className="size-[22px]" name="window" />
            </span>
            Remote Browser
          </div>
          <h1
            className="text-[26px] leading-tight font-semibold tracking-[-0.025em] text-balance"
            id="closed-title"
          >
            Open this browser's own address
          </h1>
          <p className="text-ink-faint mt-3 text-sm leading-relaxed">
            This browser has no account and no sign-in. It prints an address carrying a one-time
            token when it starts, and that address is the only way in. Restart it to print a new
            one; an agent reaches it over MCP with an API key instead.
          </p>
          <p className="border-line-strong text-ink-faint mt-7 flex items-start gap-2 border-t pt-5 text-xs leading-relaxed">
            <Icon className="mt-0.5 size-[15px]" name="lock" />
            Your website sessions stay separate in each browser session.
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="bg-page relative flex h-dvh flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1 flex-col" inert={panel !== "" || undefined}>
        <TabStrip
          onClose={closeTab}
          onOpen={openTab}
          onSelect={selectTab}
          tabId={tabId}
          tabs={tabs}
        />
        <Chrome
          health={health}
          healthNote={healthNote}
          interactive={interactive}
          onHistory={history}
          onMenu={menu}
          onNavigate={navigate}
          onProfile={(id) => {
            background(selectProfile(id), report);
          }}
          onReturn={() => ownership("return")}
          onTake={() => ownership("take")}
          profileId={profileId}
          profiles={profiles}
          recording={recording}
          tab={tab}
        />
        <div className="bg-page relative min-h-0 flex-1 overflow-hidden">
          <Display
            epoch={epoch}
            interactive={interactive}
            onNotice={warn}
            onPaste={paste}
            onReady={setReady}
            onShortcut={shortcut}
            onSurface={setSurface}
            profileId={profileId}
            tabId={tabId}
          />
          {ready ? null : (
            <div className="bg-page text-ink-faint pointer-events-none absolute inset-0 grid place-items-center gap-3">
              <Icon name="screen" />
              <p className="text-sm">
                {tabId ? "Connecting to the page…" : "Open a tab to start browsing."}
              </p>
            </div>
          )}
        </div>
        {note ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center">
            <Alert description={note.text} onClose={() => setNote(null)} tone={note.tone} />
          </div>
        ) : null}
        {recordedProfile ? (
          <button
            className="border-danger/40 bg-danger/10 text-danger absolute top-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full border px-3 py-1.5 text-xs"
            onClick={() => {
              if (recordedProfile !== profileId) {
                background(selectProfile(recordedProfile), report);
              }
              setPanel("files");
            }}
            type="button"
          >
            <span aria-hidden="true" className="bg-danger size-2 animate-pulse rounded-full" />
            Recording · open Files
          </button>
        ) : null}
      </div>
      {panel === "files" ? (
        <FilesPanel
          onClose={() => {
            if (tab?.filePicker) {
              guard(async () => {
                await action("choose_files", { cancel: true }, tabId, profileId);
                await refresh(profileId);
              })();
            }
            setPanel("");
          }}
          onNotice={done}
          onPreview={setPreview}
          onStopRecording={() => menu("recording")}
          picker={!!tab?.filePicker}
          profileId={profileId}
          recording={recording}
          tabId={tabId}
        />
      ) : null}
      <NewProfileDialog
        isOpen={dialog === "profile"}
        onClose={() => setDialog("")}
        onCreate={async (name) => {
          const created = readProfile(await api("/api/profiles", { name }));
          setDialog("");
          const catalog = list(record(await api("/api/profiles")).profiles).map(readProfile);
          setProfiles(catalog);
          await selectProfile(created.id || profileId);
        }}
      />
      {panel === "settings" ? (
        <Settings
          initialSection={settingsSection}
          key={settingsSection}
          onOpenTab={(id, profile) => {
            if (profile === live.current.profileId) {
              setPanel("");
              selectTab(id);
            }
          }}
          onStore={async (profile) => {
            const id = text(await action("open", {}, null, profile));
            await action(
              "navigate",
              { url: "https://chromewebstore.google.com/category/extensions" },
              id,
              profile,
            );
            if (profile === live.current.profileId) {
              setPanel("");
              selectTab(id);
            }
          }}
          endpoint={`${location.origin}/mcp`}
          onClose={() => setPanel("")}
          onNewSession={() => setDialog("profile")}
          onProfile={(id) => {
            background(selectProfile(id), report);
          }}
          onReconnect={() => {
            setReady(false);
            setEpoch((value) => value + 1);
            setPanel("");
          }}
          onSavePolicy={async (policy) => {
            const saved = record(await api("/api/policies", { profileId, policy }));
            setPolicies(list(saved.policies).map(readPolicy));
            await checkHealth();
          }}
          policies={policies}
          profileId={profileId}
          profiles={profiles}
          surface={surface}
          url={tab?.url || ""}
        />
      ) : null}
      <ClipboardDialog
        isOpen={dialog === "clipboard"}
        onClose={() => setDialog("")}
        profileId={profileId}
        tabId={tabId}
      />
      <MediaDialog file={preview} onClose={() => setPreview(null)} profileId={profileId} />
      {profileId && !dialog && !panel && !handoff && !preview ? (
        <ExtensionInstalls key={profileId} onNotice={inform} profileId={profileId} />
      ) : null}
      <HandoffDialog
        error={handoffError}
        isOpen={!!handoff}
        onCancel={() => {
          const current = handoff;
          if (!current) {
            return;
          }
          guard(async () => {
            try {
              await action("handoff_cancel", { id: current.id }, current.tabId, current.profileId);
              setHandoff(null);
            } catch (cause) {
              setHandoffError(failure(cause).message);
            }
          })();
        }}
        seconds={handoff?.seconds || 0}
      />
    </main>
  );
}
