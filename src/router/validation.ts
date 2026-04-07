import { z } from "zod";

export const AgentRequestSchema = z.object({
  prompt: z.string().min(1, "prompt is required"),
  agent: z.string().optional(),
  userId: z.string().min(1, "userId is required"),
  sessionKey: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  maxTurns: z.number().int().min(1).max(50).optional(),
});

export type AgentRequestBody = z.infer<typeof AgentRequestSchema>;
