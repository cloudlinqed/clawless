import { defineTool, Type } from "../interface.js";
import { resolveSecretsInUrl } from "./resolve-secrets.js";

export const fetchPageTool = defineTool({
  name: "fetch_page",
  label: "Fetch Page",
  description:
    "Fetch a web page and return its content as readable text. " +
    "HTML is stripped and converted to clean text. " +
    "Use this to read articles, documentation, or any web content.",
  parameters: Type.Object({
    url: Type.String({ description: "The URL to fetch" }),
    maxChars: Type.Optional(
      Type.Number({ description: "Max characters to return. Defaults to 50000" })
    ),
  }),
  execute: async (params, signal) => {
    const maxChars = params.maxChars ?? 50_000;

    // Resolve any secret key names in URL query params
    const url = new URL(params.url);
    resolveSecretsInUrl(url);

    const response = await fetch(url.toString(), {
      signal,
      headers: {
        "User-Agent": "Clawless/1.0 (serverless agent)",
        "Accept": "text/html,application/xhtml+xml,text/plain,application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    const raw = await response.text();

    // JSON — return as-is
    if (contentType.includes("application/json")) {
      return raw.slice(0, maxChars);
    }

    // HTML — strip to readable text
    if (contentType.includes("text/html")) {
      const text = stripHtml(raw);
      return text.slice(0, maxChars);
    }

    // Plain text or other
    return raw.slice(0, maxChars);
  },
});

function stripHtml(html: string): string {
  return html
    // Remove script/style blocks
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    // Remove HTML comments
    .replace(/<!--[\s\S]*?-->/g, "")
    // Convert block elements to newlines
    .replace(/<\/(p|div|h[1-6]|li|tr|br|hr)[^>]*>/gi, "\n")
    .replace(/<br[^>]*\/?>/gi, "\n")
    // Remove remaining tags
    .replace(/<[^>]+>/g, "")
    // Decode common entities
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    // Clean up whitespace
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
