/** Everything about this browser that is not a page, as an administration panel. */
import { Button, Chip, Input, Spinner } from "@heroui/react";
import { useEffect, useState } from "react";

import { AccessSettings } from "./access.js";
import { failure } from "./api.js";
import { asyncHandler } from "./async-boundary.js";
import { ExtensionManager } from "./extension-manager.js";
import { Icon } from "./icons.js";
import type { Policy, Profile } from "./model.js";
import { origin } from "./model.js";
import { McpSettings, NativeExtensionList, useNativeExtensions } from "./native-extensions.js";
import { FormRow, Group, Row } from "./rows.js";

export type SettingsSection = "sessions" | "extensions" | "mcp" | "checks" | "display" | "access";

type Props = {
  initialSection: SettingsSection;
  onOpenTab: (id: string, profile: string) => void;
  onStore: (profile: string) => Promise<void>;
  profiles: Profile[];
  profileId: string;
  endpoint: string;
  policies: Policy[];
  /** The address of the tab a session check would be written for. */
  url: string;
  /** The surface the display is rendering at, for the display page. */
  surface: string;
  onProfile: (id: string) => void;
  onNewSession: () => void;
  onSavePolicy: (policy: Policy) => Promise<void>;
  onReconnect: () => void;
  onClose: () => void;
};

const SECTIONS: { id: SettingsSection; label: string; icon: string; blurb: string }[] = [
  {
    id: "sessions",
    label: "Sessions",
    icon: "profile",
    blurb: "Separate browsers, each with its own sign-ins",
  },
  {
    id: "extensions",
    label: "Extensions",
    icon: "extensions",
    blurb: "Browser features and extensions installed in this session",
  },
  {
    id: "mcp",
    label: "MCP",
    icon: "key",
    blurb: "Agent connections and API keys",
  },
  {
    id: "checks",
    label: "Session checks",
    icon: "lock",
    blurb: "How a signed-in site is verified",
  },
  {
    id: "display",
    label: "Display",
    icon: "screen",
    blurb: "The frames this dashboard shows",
  },
  {
    id: "access",
    label: "Access",
    icon: "lock",
    blurb: "Protect this browser with a login",
  },
];

export function Settings({
  initialSection,
  onOpenTab,
  onStore,
  profiles,
  profileId,
  endpoint,
  policies,
  url,
  surface,
  onProfile,
  onNewSession,
  onSavePolicy,
  onReconnect,
  onClose,
}: Props) {
  const native = useNativeExtensions();
  const mcp = native.entries.find((entry) => entry.id === "mcp");
  const access = native.entries.find((entry) => entry.id === "access");
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [policy, setPolicy] = useState<Policy>({
    origin: "",
    cookieNames: [],
    authenticatedSelector: null,
    loginSelector: null,
    warningSeconds: 86_400,
  });
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const here = origin(url);
    const existing = policies.find((entry) => origin(entry.origin) === here);
    setPolicy({
      origin: existing?.origin || here || "",
      cookieNames: existing?.cookieNames || [],
      authenticatedSelector: existing?.authenticatedSelector || null,
      loginSelector: existing?.loginSelector || null,
      warningSeconds: existing?.warningSeconds || 86_400,
    });
  }, [policies, url]);

  useEffect(() => {
    if (
      !native.loading &&
      ((section === "mcp" && !mcp?.installed) || (section === "access" && !access?.installed))
    ) {
      setSection("extensions");
    }
  }, [native.loading, section, mcp?.installed, access?.installed]);

  const current = SECTIONS.find((entry) => entry.id === section);

  return (
    <section
      aria-label="Settings"
      className="bg-card absolute inset-0 z-30 flex flex-col sm:flex-row"
    >
      <aside className="flex w-full shrink-0 flex-col gap-1 p-2 sm:w-64 sm:p-3">
        <Button
          aria-label="Back to browser"
          className="justify-start"
          onPress={onClose}
          size="sm"
          variant="ghost"
        >
          <Icon name="back" />
          <span>Back to browser</span>
        </Button>
        <h1 className="sr-only text-lg font-semibold tracking-tight sm:not-sr-only sm:px-3 sm:pt-4 sm:pb-2">
          Settings
        </h1>
        <nav aria-label="Settings sections" className="flex gap-0.5 overflow-x-auto sm:flex-col">
          {SECTIONS.filter(
            (entry) =>
              (entry.id !== "mcp" || mcp?.installed) &&
              (entry.id !== "access" || access?.installed),
          ).map((entry) => (
            <button
              aria-current={entry.id === section}
              aria-label={entry.label}
              title={entry.label}
              className={`flex min-h-11 shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm whitespace-nowrap transition-colors ${
                entry.id === section
                  ? "text-ink bg-white/10 font-medium"
                  : "text-ink-dim hover:bg-raised"
              }`}
              key={entry.id}
              onClick={() => {
                setSection(entry.id);
              }}
              type="button"
            >
              <Icon name={entry.icon} />
              <span>{entry.label}</span>
            </button>
          ))}
        </nav>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="shrink-0 px-4 py-4 sm:px-8">
          <h2 className="text-xl font-semibold tracking-tight">{current?.label}</h2>
          <p className="text-ink-faint text-sm">{current?.blurb}</p>
        </header>
        {/* The page the sections write on: a darker canvas whose corner is rounded where the
            sidebar and the header meet it, the way the reference browser lays its settings out. */}
        <div className="bg-page min-h-0 flex-1 overflow-auto rounded-tl-3xl">
          <div className="mx-auto flex max-w-3xl flex-col gap-7 px-4 py-5 sm:px-8 sm:py-7">
            {section === "extensions" ? (
              <>
                <NativeExtensionList
                  state={native}
                  onSettings={(id) => {
                    if (id === "mcp" || id === "access") {
                      setSection(id);
                    }
                  }}
                />
                <ExtensionManager
                  key={profileId}
                  onOpenTab={onOpenTab}
                  onStore={onStore}
                  profileId={profileId}
                  profileName={
                    profiles.find((profile) => profile.id === profileId)?.name || "this session"
                  }
                />
              </>
            ) : null}
            {section === "sessions" ? (
              <>
                <Group
                  description="A session is a browser of its own: its own cookies, sign-ins and files."
                  title="This browser's sessions"
                >
                  {profiles.map((profile) => (
                    <Row
                      description={
                        profile.backgroundTabs ? "Ready" : "Not available in this catalog"
                      }
                      key={profile.id}
                      title={profile.name}
                    >
                      {profile.id === profileId ? (
                        <Chip color="success" variant="soft">
                          Open
                        </Chip>
                      ) : (
                        <Button
                          isDisabled={!profile.backgroundTabs}
                          onPress={() => {
                            onProfile(profile.id);
                          }}
                          size="sm"
                          variant="secondary"
                        >
                          Switch to
                        </Button>
                      )}
                    </Row>
                  ))}
                </Group>
                <Group title="Add">
                  <Row
                    description="Starts an engine of its own the first time you open it."
                    title="New session"
                  >
                    <Button onPress={onNewSession} size="sm" variant="primary">
                      <Icon name="plus" />
                      Create
                    </Button>
                  </Row>
                </Group>
              </>
            ) : null}

            {section === "mcp" && mcp?.installed ? (
              <McpSettings entry={mcp} endpoint={endpoint} profiles={profiles} />
            ) : null}

            {section === "checks" ? (
              <>
                <Group
                  description="What the browser looks for to say a site is still signed in."
                  title="Configured checks"
                >
                  {policies.length === 0 ? (
                    <Row
                      description="Add one below for the site in the current tab."
                      title="None yet"
                    />
                  ) : null}
                  {policies.map((entry) => (
                    <Row
                      description={
                        entry.cookieNames.length
                          ? `Cookies: ${entry.cookieNames.join(", ")}`
                          : "No cookies named"
                      }
                      key={entry.origin}
                      title={entry.origin}
                    >
                      <Button
                        onPress={() => {
                          setPolicy({ ...entry });
                        }}
                        size="sm"
                        variant="secondary"
                      >
                        Edit
                      </Button>
                    </Row>
                  ))}
                </Group>
                <Group
                  description="Cookie dates estimate credential expiry; they do not prove a session is valid."
                  title="Check for a site"
                >
                  <form
                    onSubmit={asyncHandler(async (event: { preventDefault: () => void }) => {
                      event.preventDefault();
                      setError("");
                      setSaved("");
                      setSaving(true);
                      try {
                        await onSavePolicy(policy);
                        setSaved("Check saved.");
                      } catch (cause) {
                        setError(failure(cause).message);
                      } finally {
                        setSaving(false);
                      }
                    })}
                  >
                    <FormRow title="Service origin">
                      <Input
                        aria-label="Service origin"
                        onChange={(event) => {
                          setPolicy({ ...policy, origin: event.target.value });
                        }}
                        placeholder="https://example.com"
                        value={policy.origin}
                      />
                    </FormRow>
                    <FormRow description="Separated by commas." title="Authentication cookie names">
                      <Input
                        aria-label="Authentication cookie names"
                        onChange={(event) => {
                          setPolicy({
                            ...policy,
                            cookieNames: event.target.value
                              .split(",")
                              .map((name) => name.trim())
                              .filter(Boolean),
                          });
                        }}
                        placeholder="session, auth_token"
                        value={policy.cookieNames.join(", ")}
                      />
                    </FormRow>
                    <FormRow title="Authenticated page selector">
                      <Input
                        aria-label="Authenticated page selector"
                        onChange={(event) => {
                          setPolicy({
                            ...policy,
                            authenticatedSelector: event.target.value || null,
                          });
                        }}
                        placeholder="[data-account-menu]"
                        value={policy.authenticatedSelector || ""}
                      />
                    </FormRow>
                    <FormRow title="Sign-in page selector">
                      <Input
                        aria-label="Sign-in page selector"
                        onChange={(event) => {
                          setPolicy({
                            ...policy,
                            loginSelector: event.target.value || null,
                          });
                        }}
                        placeholder="form[data-sign-in]"
                        value={policy.loginSelector || ""}
                      />
                    </FormRow>
                    <Row
                      description={error || saved || "Saved for this session's catalog."}
                      title="Save"
                    >
                      {saving ? <Spinner size="sm" /> : null}
                      <Button isDisabled={saving} type="submit" variant="primary">
                        Save check
                      </Button>
                    </Row>
                  </form>
                </Group>
              </>
            ) : null}

            {section === "display" ? (
              <Group
                description="The page is streamed as frames, at the size this window leaves for it."
                title="This display"
              >
                <Row description="Pixels the engine is painting" title="Surface">
                  <span className="text-ink-faint text-sm tabular-nums">{surface}</span>
                </Row>
                <Row
                  description="Starts the stream again if the view stops following the page."
                  title="Reconnect"
                >
                  <Button onPress={onReconnect} size="sm" variant="secondary">
                    <Icon name="reload" />
                    Reconnect display
                  </Button>
                </Row>
              </Group>
            ) : null}

            {section === "access" && access?.installed ? (
              <AccessSettings entry={access} onSaved={native.reload} />
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
