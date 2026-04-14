import { beforeEach, describe, expect, it } from "vitest";
import { setMemoStore } from "../src/memo/index.js";
import { MemoryMemoStore } from "../src/memo/memory.js";
import { createRequestContext, runWithRequestContext } from "../src/runtime/request-context.js";
import { recallMemoTool, storeMemoTool } from "../src/tools/builtins/memo.js";

function parseToolJson(result: any): any {
  const content = result.content?.[0];
  if (!content || content.type !== "text") {
    throw new Error("Expected text tool content");
  }
  return JSON.parse(content.text);
}

describe("memo tool isolation", () => {
  beforeEach(() => {
    setMemoStore(new MemoryMemoStore());
  });

  it("keeps memos isolated per authenticated user context", async () => {
    await runWithRequestContext(
      createRequestContext({
        userId: "user-a",
        sessionKey: "session-a",
        agentName: "assistant",
        auth: { required: false, authenticated: true, isAdmin: false, source: "trusted_header", userId: "user-a" },
      }),
      async () => {
        await storeMemoTool.execute("call-1", { key: "favorite_color", content: "red" });
      }
    );

    const userAResult = await runWithRequestContext(
      createRequestContext({
        userId: "user-a",
        sessionKey: "session-a",
        agentName: "assistant",
        auth: { required: false, authenticated: true, isAdmin: false, source: "trusted_header", userId: "user-a" },
      }),
      async () => recallMemoTool.execute("call-2", { key: "favorite_color" })
    );

    const userBResult = await runWithRequestContext(
      createRequestContext({
        userId: "user-b",
        sessionKey: "session-b",
        agentName: "assistant",
        auth: { required: false, authenticated: true, isAdmin: false, source: "trusted_header", userId: "user-b" },
      }),
      async () => recallMemoTool.execute("call-3", { key: "favorite_color" })
    );

    expect(parseToolJson(userAResult)).toEqual({
      found: true,
      key: "favorite_color",
      content: "red",
    });
    expect(parseToolJson(userBResult)).toEqual({
      found: false,
      key: "favorite_color",
      availableKeys: [],
    });
  });
});
