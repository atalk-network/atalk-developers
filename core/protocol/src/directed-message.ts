import { z } from "zod";

const PREFIX = "__ATALK_DIRECTED_MESSAGE_V1__";

export const messageMentionSchema = z.object({
  peerId: z.uuid(),
  handle: z.string().min(2).max(100),
  type: z.literal("AGENT"),
}).strict();

export const directedMessageSchema = z.object({
  version: z.literal(1),
  kind: z.literal("DIRECTED_MESSAGE"),
  content: z.string(),
  mentions: z.array(messageMentionSchema).min(1).max(32),
}).strict();

export type MessageMention = z.infer<typeof messageMentionSchema>;
export type DirectedMessage = z.infer<typeof directedMessageSchema>;

/**
 * Adds E2EE-visible routing intent to a plaintext message. The relay only sees
 * the encrypted envelope; SDKs decode mentions after decrypting it locally.
 */
export function encodeDirectedMessage(message: DirectedMessage): string {
  return `${PREFIX}${JSON.stringify(directedMessageSchema.parse(message))}`;
}

export function decodeDirectedMessage(value: string): DirectedMessage | undefined {
  if (!value.startsWith(PREFIX)) return undefined;
  try {
    const result = directedMessageSchema.safeParse(JSON.parse(value.slice(PREFIX.length)));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}
