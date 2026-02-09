import { z } from "zod";

export const intentSchema = z.object({
  actionable: z.boolean().describe("Whether this content requires user action"),
  type: z
    .enum(["reminder", "todo", "meeting", "deadline", "note"])
    .describe("Type of actionable item"),
  content: z.string().describe("Brief summary of what needs attention"),
  due_time: z
    .string()
    .nullable()
    .describe("When action is needed, e.g. '明天下午3点', '今天5pm', or null"),
});

export type IntentResult = z.infer<typeof intentSchema>;
