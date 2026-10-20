/** Who is working where. An agent keeps one colour across the tabs it holds, so a glance
 *  at the strip says which tabs belong to which agent. */
import type { Tab } from "./model.js";

/** A small fixed palette reads as a set of names rather than as arbitrary colour. */
const PALETTE = ["purple", "blue", "green", "orange", "pink", "red", "yellow"] as const;

export type AgentColour = (typeof PALETTE)[number];

/** The same name always takes the same colour, in this profile and the next. */
export function agentColour(name: string): AgentColour {
  let hash = 0;
  for (const character of name) {
    hash = (hash * 31 + (character.codePointAt(0) || 0)) % 1_000_003;
  }
  return PALETTE[hash % PALETTE.length] ?? "purple";
}

export type TabGroup = {
  /** The agent holding every tab in this run, or null for tabs nobody reserved. */
  agent: string | null;
  task: string;
  tabs: Tab[];
};

/** Runs of neighbouring tabs held by the same agent, which are drawn as one group. */
export function groupByAgent(tabs: Tab[]): TabGroup[] {
  const groups: TabGroup[] = [];
  for (const tab of tabs) {
    const agent = tab.reservation && tab.owner !== "human" ? tab.reservation.agentName : null;
    const last = groups.at(-1);
    if (last && last.agent === agent) {
      last.tabs.push(tab);
      continue;
    }
    groups.push({ agent, task: tab.reservation?.task || "", tabs: [tab] });
  }
  return groups;
}
