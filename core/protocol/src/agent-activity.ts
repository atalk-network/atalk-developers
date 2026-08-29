import { z } from "zod";

const PREFIX = "__ATALK_AGENT_ACTIVITY_V1__";

export const agentActivitySchema = z.object({
  version: z.literal(1),
  kind: z.literal("AGENT_ACTIVITY"),
  agentPeerId: z.uuid(),
  agentHandle: z.string(),
  counterpartyPeerId: z.uuid(),
  counterpartyHandle: z.string(),
  counterpartyDisplayName: z.string(),
  direction: z.enum(["INCOMING", "OUTGOING"]),
  sourceMessageId: z.uuid(),
  observedAt: z.iso.datetime({ offset: true }),
  text: z.string(),
}).strict();

export type AgentActivity = z.infer<typeof agentActivitySchema>;

export function encodeAgentActivity(activity: AgentActivity): string {
  return `${PREFIX}${JSON.stringify(agentActivitySchema.parse(activity))}`;
}

export function decodeAgentActivity(value: string): AgentActivity | undefined {
  if (!value.startsWith(PREFIX)) return undefined;
  try {
    const result = agentActivitySchema.safeParse(JSON.parse(value.slice(PREFIX.length)));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}
