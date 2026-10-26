/** Browser commands stay inside one panel, including sessions and capture options. */
import { Button, Dropdown } from "@heroui/react";
import { useState } from "react";

import { Icon } from "./icons.js";
import type { Profile, Tab } from "./model.js";

type Props = {
  profiles: Profile[];
  profileId: string;
  tab: Tab | undefined;
  interactive: boolean;
  controls: boolean;
  recording: boolean;
  onProfile: (id: string) => void;
  onHistory: (op: "back" | "forward" | "reload") => void;
  onMenu: (key: string) => void;
  onTake: () => void;
  onReturn: () => void;
};

export function BrowserMenu({
  profiles,
  profileId,
  tab,
  interactive,
  controls,
  recording,
  onProfile,
  onHistory,
  onMenu,
  onTake,
  onReturn,
}: Props) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<"main" | "sessions" | "capture">("main");
  const human = controls && tab?.owner === "human";
  const dispatch = (key: string) => {
    if (key === "main" || key === "sessions" || key === "capture") {
      return;
    }
    if (key.startsWith("profile:")) {
      onProfile(key.slice(8));
    } else if (key === "back" || key === "forward" || key === "reload") {
      onHistory(key);
    } else if (key === "control") {
      if (human) {
        onReturn();
      } else {
        onTake();
      }
    } else {
      onMenu(key);
    }
  };
  return (
    <Dropdown
      isOpen={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setPage("main");
        }
      }}
    >
      <Button
        aria-label="More options"
        className="min-h-11 min-w-11 @2xl:min-h-9 @2xl:min-w-9"
        isIconOnly
        size="sm"
        variant="ghost"
      >
        <Icon name="more" />
      </Button>
      <Dropdown.Popover
        className="max-h-[calc(100dvh-1rem)] max-w-[calc(100vw-1rem)] overflow-y-auto"
        containerPadding={8}
        placement="bottom end"
      >
        <Dropdown.Menu
          aria-label={
            page === "main" ? "Browser menu" : page === "sessions" ? "Choose a session" : "Capture"
          }
          autoFocus="first"
          key={page}
          onAction={(key) => dispatch(String(key))}
        >
          {page === "main" ? (
            <>
              <Dropdown.Section aria-label="Navigation">
                <Dropdown.Item
                  id="back"
                  textValue="Back"
                  isDisabled={!interactive || !tab?.canGoBack}
                >
                  <Icon name="back" />
                  Back
                </Dropdown.Item>
                <Dropdown.Item
                  id="forward"
                  textValue="Forward"
                  isDisabled={!interactive || !tab?.canGoForward}
                >
                  <Icon name="forward" />
                  Forward
                </Dropdown.Item>
                <Dropdown.Item id="reload" textValue="Reload page" isDisabled={!interactive}>
                  <Icon name="reload" />
                  Reload page
                </Dropdown.Item>
              </Dropdown.Section>
              <Dropdown.Section aria-label="Session and control">
                <Dropdown.Item
                  id="sessions"
                  textValue="Sessions"
                  shouldCloseOnSelect={false}
                  onAction={() => setPage("sessions")}
                >
                  <Icon name="profile" />
                  Sessions
                  <Icon name="forward" className="ml-auto size-4" />
                </Dropdown.Item>
                <Dropdown.Item
                  id="control"
                  textValue={human ? "Return this tab to agents" : "Ask for control"}
                  isDisabled={!tab || tab.uncertain}
                >
                  <Icon name="hand" />
                  {human ? "Return this tab to agents" : "Ask for control"}
                </Dropdown.Item>
              </Dropdown.Section>
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
                <Dropdown.Item
                  id="capture"
                  textValue="Capture"
                  shouldCloseOnSelect={false}
                  onAction={() => setPage("capture")}
                >
                  <Icon name="screen" />
                  Capture
                  <Icon name="forward" className="ml-auto size-4" />
                </Dropdown.Item>
                <Dropdown.Item id="clipboard" textValue="Clipboard">
                  <Icon name="clipboard" />
                  Clipboard
                </Dropdown.Item>
              </Dropdown.Section>
            </>
          ) : (
            <>
              <Dropdown.Section aria-label="Menu navigation">
                <Dropdown.Item
                  id="main"
                  textValue="Back to browser menu"
                  shouldCloseOnSelect={false}
                  onAction={() => setPage("main")}
                >
                  <Icon name="back" />
                  {page === "sessions" ? "Sessions" : "Capture"}
                </Dropdown.Item>
              </Dropdown.Section>
              {page === "sessions" ? (
                <Dropdown.Section aria-label="Sessions">
                  {profiles.map((profile) => (
                    <Dropdown.Item
                      id={`profile:${profile.id}`}
                      key={profile.id}
                      isDisabled={!profile.backgroundTabs}
                      textValue={profile.name}
                    >
                      {profile.name}
                      {profile.id === profileId ? (
                        <Icon name="check" className="ml-auto size-4" />
                      ) : null}
                    </Dropdown.Item>
                  ))}
                  <Dropdown.Item id="new-profile" textValue="New session">
                    <Icon name="plus" />
                    New session…
                  </Dropdown.Item>
                </Dropdown.Section>
              ) : (
                <Dropdown.Section aria-label="Capture options">
                  <Dropdown.Item id="screenshot" textValue="Save screenshot">
                    <Icon name="screen" />
                    Save screenshot
                  </Dropdown.Item>
                  <Dropdown.Item id="recording" textValue="Record browser">
                    <Icon name="window" />
                    {recording ? "Stop recording" : "Record browser"}
                  </Dropdown.Item>
                </Dropdown.Section>
              )}
            </>
          )}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
