import { defineTool, Type } from "../interface.js";
import { getSessionStore } from "../../session/index.js";
import type { Message, AssistantMessage } from "@mariozechner/pi-ai";
import { requireRequestContext } from "../../runtime/request-context.js";

export const sessionsListTool = defineTool({
  name: "sessions_list",
  label: "List Sessions",
  description:
    "List your previous conversation sessions. " +
    "Use this to find past conversations you can reference or continue. " +
    "Returns session IDs, agent names, and last activity timestamps.",
  parameters: Type.Object({
    limit: Type.Optional(
      Type.Number({ description: "Max sessions to return. Defaults to 20" })
    ),
  }),
  execute: async (params) => {
    const { userId } = requireRequestContext();
    const store = getSessionStore();
    const sessions = await store.list(userId);

    const sorted = sessions
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, params.limit ?? 20);

    return JSON.stringify(
      sorted.map((s) => ({
        sessionKey: s.id,
        agent: s.toolSet,
        lastActive: new Date(s.updatedAt).toISOString(),
      })),
      null,
      2
    );
  },
});

export const sessionsHistoryTool = defineTool({
  name: "sessions_history",
  label: "Session History",
  description:
    "Retrieve the conversation history of a specific session. " +
    "Use this to recall what was discussed in a previous conversation. " +
    "Returns the messages exchanged between the user and agent.",
  parameters: Type.Object({
    sessionKey: Type.String({ description: "The session key to retrieve history for" }),
    lastN: Type.Optional(
      Type.Number({ description: "Only return the last N messages. Defaults to all." })
    ),
  }),
  execute: async (params) => {
    const { userId } = requireRequestContext();
    const store = getSessionStore();
    const session = await store.load(params.sessionKey, userId);

    if (!session) {
      return JSON.stringify({ error: "Session not found or access denied" });
    }

    let messages = session.messages;
    if (params.lastN) {
      messages = messages.slice(-params.lastN);
    }

    const simplified = messages.map((msg) => {
      const m = msg as Message;
      if (m.role === "user") {
        return { role: "user", content: typeof m.content === "string" ? m.content : "[complex content]" };
      }
      if (m.role === "assistant") {
        const a = m as AssistantMessage;
        const text = a.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("");
        return { role: "assistant", content: text || "[tool calls only]" };
      }
      if (m.role === "toolResult") {
        return { role: "toolResult", tool: m.toolName, isError: m.isError };
      }
      return { role: "unknown" };
    });

    return JSON.stringify({
      sessionKey: params.sessionKey,
      agent: session.toolSet,
      messageCount: simplified.length,
      messages: simplified,
    }, null, 2);
  },
});
