import { defineTool, Type } from "../interface.js";

export const jsonRequestTool = defineTool({
  name: "json_request",
  label: "JSON Request",
  description:
    "Make an HTTP request to any URL and return the JSON response. " +
    "Use this to call REST APIs when you know the endpoint, method, headers, " +
    "and body from your knowledge. Supports GET, POST, PUT, PATCH, DELETE. " +
    "Authentication headers and API keys should be provided in the headers parameter.",
  parameters: Type.Object({
    url: Type.String({ description: "Full URL to call" }),
    method: Type.Optional(
      Type.String({ description: "HTTP method: GET, POST, PUT, PATCH, DELETE. Defaults to GET" })
    ),
    headers: Type.Optional(
      Type.Record(Type.String(), Type.String(), {
        description: "HTTP headers as key-value pairs (e.g. Authorization, Content-Type)",
      })
    ),
    body: Type.Optional(
      Type.Unknown({ description: "Request body — will be JSON-serialized" })
    ),
    queryParams: Type.Optional(
      Type.Record(Type.String(), Type.String(), {
        description: "Query parameters as key-value pairs",
      })
    ),
  }),
  execute: async (params, signal) => {
    const method = (params.method ?? "GET").toUpperCase();
    const url = new URL(params.url);

    if (params.queryParams) {
      for (const [key, value] of Object.entries(params.queryParams)) {
        url.searchParams.set(key, value);
      }
    }

    const headers: Record<string, string> = { ...params.headers };
    let body: string | undefined;

    if (params.body !== undefined && method !== "GET" && method !== "HEAD") {
      body = JSON.stringify(params.body);
      if (!headers["Content-Type"] && !headers["content-type"]) {
        headers["Content-Type"] = "application/json";
      }
    }

    const response = await fetch(url.toString(), { method, headers, body, signal });

    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();

    const result: Record<string, unknown> = {
      status: response.status,
      statusText: response.statusText,
    };

    if (contentType.includes("application/json")) {
      try {
        result.data = JSON.parse(text);
      } catch {
        result.data = text;
      }
    } else {
      result.data = text.slice(0, 50_000);
    }

    if (!response.ok) {
      result.error = true;
    }

    return JSON.stringify(result, null, 2);
  },
});
