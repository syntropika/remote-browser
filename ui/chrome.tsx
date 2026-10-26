/** The browser chrome: history, address, session, control and the menu. */
import { Button, Dropdown, InputGroup, Tooltip } from "@heroui/react";
import { useEffect, useRef, useState } from "react";

import { BrowserMenu } from "./browser-menu.js";
import { Icon } from "./icons.js";
import type { Health, Profile, Tab } from "./model.js";
import { MobileTabs } from "./tabs.js";

type Props = {
  tab: Tab | undefined;
  interactive: boolean;
  controls: boolean;
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
  tabs: Tab[];
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onOpenTab: () => void;
};

const healthNames: Record<Health["state"], string> = {
  active: "Session active",
  expiring: "Credential expiry is near",
  reauthRequired: "Sign in required",
  unknown: "Session validity unknown",
};

/** Who is holding this tab right now. */
function holder(tab: Tab | undefined, controls: boolean): "agent" | "you" | "other" | "free" {
  if (tab?.displayController && !controls) {
    return "other";
  }
  if (tab?.reservation && tab.owner !== "human") {
    return "agent";
  }
  return tab?.owner === "human" ? "you" : "free";
}

export function Chrome({
  tab,
  interactive,
  controls,
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
  tabs,
  onSelectTab,
  onCloseTab,
  onOpenTab,
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
  const holding = holder(tab, controls);
  const working = tab?.reservation && holding === "agent" ? tab.reservation : null;
  const availability = tab?.uncertain
    ? "This tab needs an engine restart"
    : holding === "other"
      ? "Viewing this tab · another screen controls it"
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
    <div className="bg-chrome @container flex flex-col px-2 py-1.5">
      <div
        aria-label="Browser toolbar"
        className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1 @2xl:grid-cols-[minmax(10.5rem,1fr)_minmax(0,3fr)_minmax(10.5rem,1fr)] @2xl:gap-1.5"
      >
        <div className="flex shrink-0 items-center @2xl:gap-1.5">
          <Tooltip>
            <Tooltip.Trigger>
              <Button
                aria-label="Back"
                className="size-11 min-w-11 @2xl:size-8 @2xl:min-w-8"
                isDisabled={!interactive || !tab?.canGoBack}
                isIconOnly
                onPress={() => {
                  onHistory("back");
                }}
                size="sm"
                variant="ghost"
              >
                <Icon name="back" className="size-4 @2xl:size-[18px]" />
              </Button>
            </Tooltip.Trigger>
            <Tooltip.Content>Back</Tooltip.Content>
          </Tooltip>
          <Tooltip>
            <Tooltip.Trigger>
              <Button
                aria-label="Forward"
                className="size-11 min-w-11 @2xl:size-8 @2xl:min-w-8"
                isDisabled={!interactive || !tab?.canGoForward}
                isIconOnly
                onPress={() => {
                  onHistory("forward");
                }}
                size="sm"
                variant="ghost"
              >
                <Icon name="forward" className="size-4 @2xl:size-[18px]" />
              </Button>
            </Tooltip.Trigger>
            <Tooltip.Content>Forward</Tooltip.Content>
          </Tooltip>
          <Tooltip>
            <Tooltip.Trigger>
              <Button
                aria-label="Reload page"
                className="hidden @2xl:inline-flex"
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
        </div>
        <form
          aria-label="Open a website"
          className="min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            onNavigate(address.trim());
          }}
        >
          <InputGroup className="bg-address border-line/70 w-full min-w-0 overflow-hidden rounded-full border">
            <InputGroup.Prefix className="hidden @2xl:flex">
              <Icon name="globe" />
            </InputGroup.Prefix>
            <InputGroup.Input
              aria-label="Page address"
              className="w-0 min-w-0 flex-1 ps-2.5 @2xl:ps-0"
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
                    className={`ms-1 me-[9px] block size-2 shrink-0 rounded-full ${working ? "bg-danger" : "bg-success"}`}
                    role="status"
                  />
                </Tooltip.Trigger>
                <Tooltip.Content>{availability}</Tooltip.Content>
              </Tooltip>
              {health ? (
                <span
                  className="text-ink-faint hidden max-w-52 truncate text-xs @3xl:block"
                  title={`${state} · ${health.evidence}`}
                >
                  {state}
                </span>
              ) : null}
            </InputGroup.Suffix>
          </InputGroup>
        </form>
        <div className="flex shrink-0 items-center justify-end @2xl:gap-1.5">
          <MobileTabs
            tabs={tabs}
            tabId={tab?.id || ""}
            onSelect={onSelectTab}
            onClose={onCloseTab}
            onOpen={onOpenTab}
          />
          <Dropdown>
            <Button
              aria-label={`Session: ${profileName}`}
              className="hidden whitespace-nowrap @2xl:inline-flex"
              isIconOnly
              size="sm"
              variant="ghost"
            >
              <Icon name="profile" />
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
                className="hidden @2xl:inline-flex"
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
                className="hidden @2xl:inline-flex"
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
          <BrowserMenu
            controls={controls}
            profiles={profiles}
            profileId={profileId}
            tab={tab}
            interactive={interactive}
            recording={recording}
            onProfile={onProfile}
            onHistory={onHistory}
            onMenu={onMenu}
            onTake={onTake}
            onReturn={onReturn}
          />
        </div>
      </div>
    </div>
  );
}
