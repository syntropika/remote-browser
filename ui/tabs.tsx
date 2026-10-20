/** The tab strip. Tabs share the width they have, as a browser's do, and the tabs an
 *  agent is working on are drawn together under its name. */
import { Button } from "@heroui/react";

import { agentColour, groupByAgent } from "./agents.js";
import { Icon } from "./icons.js";
import type { Tab } from "./model.js";

type Props = {
  tabs: Tab[];
  tabId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onOpen: () => void;
};

export function TabStrip({ tabs, tabId, onSelect, onClose, onOpen }: Props) {
  const closable = tabs.length > 1;
  const face = (tab: Tab) => {
    const selected = tab.id === tabId;
    // A blank page has no name of its own, and Chromium reports its address as the title,
    // which is not what a browser shows on the tab.
    const blank = !tab.url || tab.url === "about:blank";
    const named = tab.title && tab.title !== tab.url ? tab.title : "";
    const label = named || (blank ? "New tab" : tab.url.replace(/^https?:\/\//u, ""));
    const held = tab.reservation && tab.owner !== "human" ? tab.reservation : null;
    return (
      <div
        className={`group relative flex h-9 max-w-60 min-w-11 flex-1 items-stretch rounded-t-xl transition-colors ${
          selected ? "bg-chrome" : "hover:bg-strip/80"
        }`}
        key={tab.id}
      >
        <button
          aria-selected={selected}
          className={`flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-t-xl pr-8 pl-3 text-[13px] font-medium ${
            selected ? "text-foreground" : "text-ink-faint"
          }`}
          onClick={() => {
            onSelect(tab.id);
          }}
          role="tab"
          title={[label, tab.url, held && `${held.agentName}: ${held.task}`]
            .filter(Boolean)
            .join("\n")}
          type="button"
        >
          {tab.busy ? (
            <span className="size-1.5 flex-shrink-0 animate-pulse rounded-full bg-current" />
          ) : null}
          <span className="truncate">{label}</span>
        </button>
        {closable ? (
          <Button
            aria-label={`Close ${label}`}
            className={`absolute top-1/2 right-1.5 -translate-y-1/2 ${
              selected ? "" : "opacity-0 group-hover:opacity-100"
            }`}
            isDisabled={tab.uncertain}
            isIconOnly
            onPress={() => {
              onClose(tab.id);
            }}
            size="sm"
            variant="ghost"
          >
            <Icon name="close" />
          </Button>
        ) : null}
      </div>
    );
  };

  return (
    <div className="bg-strip flex items-stretch gap-2 px-2 pt-1.5">
      <div
        aria-label="Open tabs"
        className="flex min-w-0 flex-1 items-stretch gap-1"
        role="tablist"
      >
        {groupByAgent(tabs).map((group) =>
          group.agent === null ? (
            group.tabs.map(face)
          ) : (
            <div
              className="flex min-w-0 items-stretch gap-0.5 rounded-t-2xl px-1.5"
              data-colour={agentColour(group.agent)}
              key={`${group.agent}-${group.tabs[0]?.id}`}
              style={{
                background: "color-mix(in srgb, var(--agent) 13%, transparent)",
                boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--agent) 38%, transparent)",
              }}
            >
              <span
                className="flex max-w-40 items-center gap-1.5 self-center rounded-full px-2 py-0.5 text-[11px] font-semibold"
                style={{
                  background: "color-mix(in srgb, var(--agent) 20%, transparent)",
                  color: "var(--agent)",
                }}
                title={`${group.agent} is working here: ${group.task}`}
              >
                <span
                  aria-hidden="true"
                  className="size-1.5 flex-shrink-0 animate-pulse rounded-full"
                  style={{ background: "var(--agent)" }}
                />
                <span className="truncate">{group.agent}</span>
              </span>
              {group.tabs.map(face)}
            </div>
          ),
        )}
        <Button
          aria-label="New tab"
          className="self-center"
          isIconOnly
          onPress={onOpen}
          size="sm"
          variant="ghost"
        >
          <Icon name="plus" />
        </Button>
      </div>
    </div>
  );
}
