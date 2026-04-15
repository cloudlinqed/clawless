import { defineTool, Type } from "../interface.js";
import {
  resolveSecretsInUrl,
  resolveSecretsInHeaders,
  resolveSecretsInBody,
} from "./resolve-secrets.js";
import { assertBuiltinOutboundAllowed } from "../../security/outbound.js";

export const jsonRequestTool = defineTool({
  name: "json_request",
  label: "JSON Request",
  description:
    "Make an HTTP request to any URL and return the JSON response. " +
    "Use this to call REST APIs when you know the endpoint, method, headers, " +
    "and body from your knowledge. Supports GET, POST, PUT, PATCH, DELETE. " +
    "For authentication, use the secret key name as the value (e.g. MY_API_KEY) " +
    "and it will be resolved to the actual credential automatically.",
  parameters: Type.Object({
    url: Type.String({ description: "Full URL to call" }),
    method: Type.Optional(
      Type.String({ description: "HTTP method: GET, POST, PUT, PATCH, DELETE. Defaults to GET" })
    ),
    headers: Type.Optional(
      Type.Record(Type.String(), Type.String(), {
        description: "HTTP headers as key-value pairs. Use secret key names for auth values.",
      })
    ),
    body: Type.Optional(
      Type.Unknown({ description: "Request body — will be JSON-serialized. Secret key names in values are resolved." })
    ),
    queryParams: Type.Optional(
      Type.Record(Type.String(), Type.String(), {
        description: "Query parameters. Use secret key names as values for credentials.",
      })
    ),
  }),
  execute: async (params, signal) => {
    const method = (params.method ?? "GET").toUpperCase();
    const url = new URL(params.url);

    // Resolve secrets in URL query params (from the URL itself)
    resolveSecretsInUrl(url);

    // Resolve secrets in explicit query params
    if (params.queryParams) {
      for (const [key, value] of Object.entries(params.queryParams)) {
        url.searchParams.set(key, value);
      }
      // Resolve again after adding params
      resolveSecretsInUrl(url);
    }

    // Resolve secrets in headers
    const headers: Record<string, string> = params.headers
      ? resolveSecretsInHeaders(params.headers)
      : {};

    let body: string | undefined;

    if (params.body !== undefined && method !== "GET" && method !== "HEAD") {
      body = JSON.stringify(resolveSecretsInBody(params.body));
      if (!headers["Content-Type"] && !headers["content-type"]) {
        headers["Content-Type"] = "application/json";
      }
    }

    await assertBuiltinOutboundAllowed(url.toString());
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
