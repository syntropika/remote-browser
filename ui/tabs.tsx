/** Tabs share the available width; a compact marker identifies each agent-held tab. */
import { Button, Modal, Tooltip } from "@heroui/react";
import { useState } from "react";
import type { ComponentPropsWithRef } from "react";

import { agentColour } from "./agents.js";
import { Icon } from "./icons.js";
import type { Tab } from "./model.js";

type Props = {
  tabs: Tab[];
  tabId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onOpen: () => void;
};

function tabLabel(tab: Tab): string {
  const blank = !tab.url || tab.url === "about:blank";
  const named = tab.title && tab.title !== tab.url ? tab.title : "";
  return named || (blank ? "New tab" : tab.url.replace(/^https?:\/\//u, ""));
}

function tabSite(tab: Tab): string {
  try {
    return new URL(tab.url).hostname || "New tab";
  } catch {
    return "New tab";
  }
}

function renderTabButton(props: ComponentPropsWithRef<"button">) {
  return <button {...props} />;
}

function TabButton({
  agentName,
  ...props
}: ComponentPropsWithRef<"button"> & { agentName?: string }) {
  return agentName ? (
    <Tooltip delay={180}>
      <Tooltip.Trigger<"button"> {...props} render={renderTabButton} title={undefined} />
      <Tooltip.Content className="max-w-72 break-normal break-words" placement="bottom">
        {agentName}
      </Tooltip.Content>
    </Tooltip>
  ) : (
    <button {...props} />
  );
}

function AgentIndicator({ name }: { name: string }) {
  return (
    <span
      aria-label={`Agent: ${name}`}
      className="inline-block size-2 shrink-0 rounded-full"
      data-colour={agentColour(name)}
      role="img"
      style={{ background: "var(--agent)" }}
    />
  );
}

/** The mobile browser leaves its current page only when the person opens the tab overview. */
export function MobileTabs({ tabs, tabId, onSelect, onClose, onOpen }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="@2xl:hidden">
        <Button
          aria-label={`Show ${tabs.length} open tabs`}
          className="min-h-11 min-w-11"
          isIconOnly
          onPress={() => setOpen(true)}
          variant="ghost"
        >
          <span className="text-foreground grid size-6 shrink-0 place-items-center rounded-md border-2 border-current text-xs font-semibold tabular-nums">
            {tabs.length}
          </span>
        </Button>
      </div>
      <Modal isOpen={open} onOpenChange={setOpen}>
        <Modal.Backdrop>
          <Modal.Container size="full">
            <Modal.Dialog>
              <Modal.Header className="flex-row items-center justify-between gap-3 pr-10">
                <Modal.Heading>Open tabs · {tabs.length}</Modal.Heading>
                <Modal.CloseTrigger />
              </Modal.Header>
              <Modal.Body className="grid min-h-0 flex-1 grid-cols-2 content-start gap-3 overflow-y-auto">
                {tabs.map((tab) => (
                  <div
                    className={`bg-address relative min-w-0 overflow-hidden rounded-xl border ${tab.id === tabId ? "border-foreground" : "border-line-strong"}`}
                    data-colour={
                      tab.reservation && tab.owner !== "human"
                        ? agentColour(tab.reservation.agentName)
                        : undefined
                    }
                    key={tab.id}
                    style={
                      tab.reservation && tab.owner !== "human"
                        ? {
                            borderLeftColor: "var(--agent)",
                            borderRightColor: "var(--agent)",
                            borderTopColor: "var(--agent)",
                          }
                        : undefined
                    }
                  >
                    <TabButton
                      agentName={
                        tab.reservation && tab.owner !== "human"
                          ? tab.reservation.agentName
                          : undefined
                      }
                      aria-current={tab.id === tabId ? "page" : undefined}
                      aria-label={`Switch to ${tabLabel(tab)}`}
                      className="focus-visible:outline-foreground flex min-h-44 w-full min-w-0 flex-col gap-3 rounded-xl p-3 text-left focus-visible:outline-2 focus-visible:-outline-offset-2"
                      onClick={() => {
                        onSelect(tab.id);
                        setOpen(false);
                      }}
                      type="button"
                    >
                      <span className="line-clamp-2 w-full pr-8 text-sm leading-5 font-medium">
                        {tabLabel(tab)}
                      </span>
                      <span className="text-ink-dim mt-auto w-full truncate text-xs">
                        {tabSite(tab)}
                      </span>
                      {tab.reservation && tab.owner !== "human" ? (
                        <span className="flex h-4 items-center">
                          <AgentIndicator name={tab.reservation.agentName} />
                        </span>
                      ) : (
                        <span className="text-ink-faint w-full truncate text-xs">
                          {tab.id === tabId ? "Current tab" : "Open tab"}
                        </span>
                      )}
                    </TabButton>
                    {tabs.length > 1 ? (
                      <Button
                        aria-label={`Close ${tabLabel(tab)}`}
                        className="absolute top-0 right-0 min-h-11 min-w-11"
                        isIconOnly
                        onPress={() => onClose(tab.id)}
                        variant="ghost"
                      >
                        <Icon name="close" />
                      </Button>
                    ) : null}
                  </div>
                ))}
              </Modal.Body>
              <Modal.Footer>
                <Button
                  onPress={() => {
                    onOpen();
                    setOpen(false);
                  }}
                  variant="primary"
                >
                  <Icon name="plus" />
                  New tab
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </>
  );
}

export function TabStrip({ tabs, tabId, onSelect, onClose, onOpen }: Props) {
  const closable = tabs.length > 1;
  const face = (tab: Tab) => {
    const selected = tab.id === tabId;
    // A blank page has no name of its own, and Chromium reports its address as the title,
    // which is not what a browser shows on the tab.
    const label = tabLabel(tab);
    const held = tab.reservation && tab.owner !== "human" ? tab.reservation : null;
    return (
      <div
        className={`group flex h-9 max-w-60 min-w-32 flex-1 items-stretch rounded-t-xl border border-b-0 border-transparent transition-colors ${
          selected ? "bg-chrome" : "hover:bg-strip/80"
        }`}
        data-colour={held ? agentColour(held.agentName) : undefined}
        key={tab.id}
        style={held ? { borderColor: "var(--agent)" } : undefined}
      >
        <TabButton
          agentName={held?.agentName}
          aria-selected={selected}
          className={`flex min-w-0 flex-1 items-center gap-1.5 rounded-t-xl pr-1 pl-3 text-[13px] font-medium ${
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
          {held ? (
            <AgentIndicator name={held.agentName} />
          ) : tab.busy ? (
            <span className="size-1.5 flex-shrink-0 animate-pulse rounded-full bg-current" />
          ) : null}
          <span className="min-w-0 flex-1 truncate">{label}</span>
        </TabButton>
        {closable ? (
          <Button
            aria-label={`Close ${label}`}
            className={`mr-1 shrink-0 self-center ${
              selected ? "" : "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
            }`}
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
    <div className="bg-strip @container">
      <div className="hidden items-stretch gap-2 px-2 pt-1.5 @2xl:flex">
        <div
          aria-label="Open tabs"
          className="flex min-w-0 flex-1 items-stretch gap-1 overflow-x-auto overflow-y-hidden"
          role="tablist"
        >
          {tabs.map(face)}
        </div>
        <Button
          aria-label="New tab"
          className="shrink-0 self-center"
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
