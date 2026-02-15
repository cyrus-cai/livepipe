import { z } from "zod";

export const intentSchema = z.object({
  actionable: z.boolean().describe("Whether this content requires user action"),
  noteworthy: z
    .boolean()
    .describe("Whether this content is worth saving even without required action"),
  content: z.string().describe("Brief summary of what needs attention"),
  due_time: z
    .string()
    .nullable()
    .describe("When action is needed, e.g. '明天下午3点', '今天5pm', or null"),
  urgent: z.boolean().describe("Whether this item is urgent"),
});

export type IntentResult = z.infer<typeof intentSchema>;
