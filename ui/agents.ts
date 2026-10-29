/** Who is working where. An agent keeps one colour across the tabs it holds, so a glance
 *  at the strip says which tabs belong to which agent. */
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
