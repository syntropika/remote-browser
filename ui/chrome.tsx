/** The browser chrome: history, address, session, control and the menu. */
import { Button, Dropdown, InputGroup, Tooltip } from "@heroui/react";
import { useEffect, useRef, useState } from "react";

import { agentColour } from "./agents.js";
import { Icon } from "./icons.js";
import type { Health, Profile, Tab } from "./model.js";

type Props = {
  tab: Tab | undefined;
  interactive: boolean;
  profiles: Profile[];
  profileId: string;
  recording: boolean;
  health: Health | null;
  healthNote: string;
  onNavigate: (url: string) => void;
  onHistory: (op: "back" | "forward" | "reload") => void;
  onProfile: (id: string) => void;
  onMenu: (key: string) => void;
  onTake: () => void;
  onReturn: () => void;
};

const healthNames: Record<Health["state"], string> = {
  active: "Session active",
  expiring: "Credential expiry is near",
  reauthRequired: "Sign in required",
  unknown: "Session validity unknown",
};

/** Who is holding this tab right now. */
function holder(tab: Tab | undefined): "agent" | "you" | "free" {
  if (tab?.reservation && tab.owner !== "human") {
    return "agent";
  }
  return tab?.owner === "human" ? "you" : "free";
}

export function Chrome({
  tab,
  interactive,
  profiles,
  profileId,
  recording,
  health,
  healthNote,
  onNavigate,
  onHistory,
  onProfile,
  onMenu,
  onTake,
  onReturn,
}: Props) {
  const [address, setAddress] = useState("");
  const field = useRef<HTMLInputElement | null>(null);
  const url = tab?.url || "";
  useEffect(() => {
    if (document.activeElement !== field.current) {
      setAddress(url);
    }
  }, [url]);

  const profileName = profiles.find((profile) => profile.id === profileId)?.name || "Sessions";
  const holding = holder(tab);
  const working = tab?.reservation && holding === "agent" ? tab.reservation : null;
  const availability = tab?.uncertain
    ? "This tab needs an engine restart"
    : working
      ? `In use by ${working.agentName}: ${working.task}`
      : holding === "you"
        ? "You control this tab"
        : "Free to use · the hand asks for control";
  const remaining =
    health?.secondsRemaining === null || health?.secondsRemaining === undefined
      ? ""
      : health.secondsRemaining < 3600
        ? ` · ${Math.max(1, Math.ceil(health.secondsRemaining / 60))}m left`
        : ` · ${Math.ceil(health.secondsRemaining / 3600)}h left`;
  const state = health ? healthNames[health.state] + remaining : healthNote;

  return (
    <div className="bg-chrome flex flex-col px-2 py-1.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <Tooltip>
          <Tooltip.Trigger>
            <Button
              aria-label="Back"
              isDisabled={!interactive || !tab?.canGoBack}
              isIconOnly
              onPress={() => {
                onHistory("back");
              }}
              size="sm"
              variant="ghost"
            >
              <Icon name="back" />
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Content>Back</Tooltip.Content>
        </Tooltip>
        <Tooltip>
          <Tooltip.Trigger>
            <Button
              aria-label="Forward"
              isDisabled={!interactive || !tab?.canGoForward}
              isIconOnly
              onPress={() => {
                onHistory("forward");
              }}
              size="sm"
              variant="ghost"
            >
              <Icon name="forward" />
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Content>Forward</Tooltip.Content>
        </Tooltip>
        <Tooltip>
          <Tooltip.Trigger>
            <Button
              aria-label="Reload page"
              isDisabled={!interactive}
              isIconOnly
              onPress={() => {
                onHistory("reload");
              }}
              size="sm"
              variant="ghost"
            >
              <Icon name="reload" />
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Content>Reload</Tooltip.Content>
        </Tooltip>
        <form
          aria-label="Open a website"
          className="min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            onNavigate(address.trim());
          }}
        >
          <InputGroup className="bg-address border-line/70 w-full rounded-full border">
            <InputGroup.Prefix>
              <Icon name="globe" />
            </InputGroup.Prefix>
            <InputGroup.Input
              aria-label="Page address"
              autoCapitalize="none"
              autoComplete="off"
              disabled={!interactive}
              enterKeyHint="go"
              inputMode="url"
              onChange={(event) => {
                setAddress(event.target.value);
              }}
              placeholder="Search or enter a website address"
              ref={field}
              spellCheck={false}
              value={address}
            />
            <InputGroup.Suffix>
              {recording ? (
                <span className="text-danger text-xs" title="Recording">
                  ●
                </span>
              ) : null}
              {/* Red while an agent is using the tab, green while it is there to be used. */}
              <Tooltip>
                <Tooltip.Trigger>
                  <span
                    aria-label={availability}
                    className={`mx-1 block size-2 rounded-full ${working ? "bg-danger" : "bg-success"}`}
                    role="status"
                  />
                </Tooltip.Trigger>
                <Tooltip.Content>{availability}</Tooltip.Content>
              </Tooltip>
              {health ? (
                <span
                  className="text-ink-faint max-w-52 truncate text-xs"
                  title={`${state} · ${health.evidence}`}
                >
                  {state}
                </span>
              ) : null}
            </InputGroup.Suffix>
          </InputGroup>
        </form>
        <div className="flex flex-shrink-0 items-center gap-1.5">
          {working ? (
            <span
              className="border-line flex max-w-56 items-center gap-1.5 truncate rounded-full border px-2.5 py-1 text-xs"
              data-colour={agentColour(working.agentName)}
              style={{ color: "var(--agent)" }}
              title={`${working.agentName}: ${working.task}`}
            >
              <Icon name="lock" />
              <span className="truncate max-sm:hidden">
                {working.agentName}: {working.task}
              </span>
            </span>
          ) : null}
          <Dropdown>
            <Button
              aria-label={`Session: ${profileName}`}
              className="whitespace-nowrap"
              size="sm"
              variant="ghost"
            >
              <Icon name="profile" />
              <span className="max-w-40 truncate max-sm:hidden">{profileName}</span>
            </Button>
            <Dropdown.Popover placement="bottom end">
              <Dropdown.Menu
                aria-label="Sessions"
                onAction={(key) => {
                  const id = String(key);
                  if (id === "new-profile") {
                    onMenu(id);
                  } else {
                    onProfile(id);
                  }
                }}
              >
                <Dropdown.Section aria-label="Open a session">
                  {profiles.map((profile) => (
                    <Dropdown.Item
                      id={profile.id}
                      isDisabled={!profile.backgroundTabs}
                      key={profile.id}
                      textValue={profile.name}
                    >
                      <span className="text-ink-faint w-4">
                        {profile.id === profileId ? "✓" : ""}
                      </span>
                      {profile.name}
                    </Dropdown.Item>
                  ))}
                </Dropdown.Section>
                <Dropdown.Section aria-label="Manage">
                  <Dropdown.Item id="new-profile" textValue="New session">
                    <Icon name="plus" />
                    New session…
                  </Dropdown.Item>
                </Dropdown.Section>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
          <Tooltip>
            <Tooltip.Trigger>
              <Button
                aria-label={holding === "you" ? "Return this tab to agents" : "Ask for control"}
                isDisabled={!tab || tab.uncertain}
                isIconOnly
                onPress={holding === "you" ? onReturn : onTake}
                size="sm"
                variant="ghost"
              >
                <Icon name="hand" />
              </Button>
            </Tooltip.Trigger>
            <Tooltip.Content>
              {holding === "you" ? "Return this tab to agents" : "Ask for control of this tab"}
            </Tooltip.Content>
          </Tooltip>
          <Tooltip>
            <Tooltip.Trigger>
              <Button
                aria-label="Extensions"
                isIconOnly
                onPress={() => onMenu("extensions")}
                size="sm"
                variant="ghost"
              >
                <Icon name="extensions" />
              </Button>
            </Tooltip.Trigger>
            <Tooltip.Content>Extensions</Tooltip.Content>
          </Tooltip>
          <Dropdown>
            <Button aria-label="More options" isIconOnly size="sm" variant="ghost">
              <Icon name="more" />
            </Button>
            <Dropdown.Popover placement="bottom end">
              <Dropdown.Menu
                aria-label="Browser menu"
                onAction={(key) => {
                  onMenu(String(key));
                }}
              >
                <Dropdown.Section aria-label="This browser">
                  <Dropdown.Item id="settings" textValue="Settings">
                    <Icon name="settings" />
                    Settings
                  </Dropdown.Item>
                  <Dropdown.Item id="extensions" textValue="Extensions">
                    <Icon name="extensions" />
                    Extensions
                  </Dropdown.Item>
                  <Dropdown.Item id="files" textValue="Files">
                    <Icon name="files" />
                    Files
                  </Dropdown.Item>
                </Dropdown.Section>
                <Dropdown.Section aria-label="This page">
                  <Dropdown.SubmenuTrigger>
                    <Dropdown.Item id="capture" textValue="Capture">
                      <Icon name="screen" />
                      Capture
                      <Dropdown.SubmenuIndicator />
                    </Dropdown.Item>
                    <Dropdown.Popover placement="left top">
                      <Dropdown.Menu
                        aria-label="Capture"
                        onAction={(key) => {
                          onMenu(String(key));
                        }}
                      >
                        <Dropdown.Item id="screenshot" textValue="Save screenshot">
                          <Icon name="screen" />
                          Save screenshot
                        </Dropdown.Item>
                        <Dropdown.Item id="recording" textValue="Record browser">
                          <Icon name="window" />
                          {recording ? "Stop recording" : "Record browser"}
                        </Dropdown.Item>
                      </Dropdown.Menu>
                    </Dropdown.Popover>
                  </Dropdown.SubmenuTrigger>
                  <Dropdown.Item id="clipboard" textValue="Clipboard">
                    <Icon name="clipboard" />
                    Clipboard
                  </Dropdown.Item>
                </Dropdown.Section>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        </div>
      </div>
    </div>
  );
}
