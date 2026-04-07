import { defineTool, Type } from "./interface.js";
import type { TSchema } from "@mariozechner/pi-ai";

interface HttpParam {
  type: "string" | "number" | "boolean";
  description: string;
  required?: boolean;
  default?: string | number | boolean;
}

interface HttpToolConfig {
  /** Tool name the agent will call */
  name: string;
  /** Human label */
  label?: string;
  /** Tell the agent what this API does — be detailed */
  description: string;
  /** HTTP method */
  method?: "GET" | "POST" | "PUT" | "DELETE";
  /** API endpoint URL */
  url: string;
  /** Parameters the agent provides */
  parameters: Record<string, HttpParam>;
  /** Static query params or headers injected from env vars */
  auth?: {
    /** Query param name → env var name */
    queryParams?: Record<string, string>;
    /** Header name → env var name */
    headers?: Record<string, string>;
  };
  /** Where agent params go: "query" (GET) or "body" (POST) */
  paramLocation?: "query" | "body";
}

/**
 * Define a tool from an HTTP API endpoint.
 *
 * Instead of writing execute() logic, just point to an API
 * and describe its parameters. The agent calls it like any other tool.
 *
 * @example
 * ```ts
 * httpTool({
 *   name: "search_items",
 *   description: "Search for items by keyword",
 *   url: "https://api.example.com/search",
 *   parameters: {
 *     query: { type: "string", description: "Search keywords", required: true },
 *     page: { type: "number", description: "Page number", default: 1 },
 *   },
 *   auth: {
 *     queryParams: { api_key: "MY_API_KEY" },
 *   },
 * });
 * ```
 */
export function httpTool(config: HttpToolConfig) {
  const method = config.method ?? "GET";
  const paramLocation = config.paramLocation ?? (method === "GET" ? "query" : "body");

  // Build TypeBox schema from parameter definitions
  const schemaProps: Record<string, TSchema> = {};
  for (const [key, param] of Object.entries(config.parameters)) {
    let base: TSchema;
    switch (param.type) {
      case "number":
        base = Type.Number({ description: param.description });
        break;
      case "boolean":
        base = Type.Boolean({ description: param.description });
        break;
      default:
        base = Type.String({ description: param.description });
    }
    schemaProps[key] = param.required !== false ? base : Type.Optional(base);
  }

  const schema = Type.Object(schemaProps);

  return defineTool({
    name: config.name,
    label: config.label ?? config.name,
    description: config.description,
    parameters: schema,
    execute: async (params: Record<string, any>, signal) => {
      const url = new URL(config.url);

      // Inject auth from env vars
      if (config.auth?.queryParams) {
        for (const [paramName, envVar] of Object.entries(config.auth.queryParams)) {
          const value = process.env[envVar];
          if (!value) throw new Error(`Missing env var: ${envVar}`);
          url.searchParams.set(paramName, value);
        }
      }

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (config.auth?.headers) {
        for (const [headerName, envVar] of Object.entries(config.auth.headers)) {
          const value = process.env[envVar];
          if (!value) throw new Error(`Missing env var: ${envVar}`);
          headers[headerName] = value;
        }
      }

      // Apply defaults
      const resolvedParams: Record<string, any> = {};
      for (const [key, paramDef] of Object.entries(config.parameters)) {
        resolvedParams[key] = params[key] ?? paramDef.default;
      }

      // Build request
      let fetchUrl = url.toString();
      let body: string | undefined;

      if (paramLocation === "query") {
        for (const [key, value] of Object.entries(resolvedParams)) {
          if (value !== undefined) {
            url.searchParams.set(key, String(value));
          }
        }
        fetchUrl = url.toString();
      } else {
        body = JSON.stringify(resolvedParams);
      }

      const response = await fetch(fetchUrl, {
        method,
        headers: body ? headers : undefined,
        body,
        signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      return JSON.stringify(data, null, 2);
    },
  });
}
