import { defineTool, Type } from "../interface.js";

export const webSearchTool = defineTool({
  name: "web_search",
  label: "Web Search",
  description:
    "Search the web and return results. " +
    "Supports multiple search providers via environment variables. " +
    "Returns titles, URLs, and snippets. " +
    "Use this when you need to find current information, research topics, or locate resources.",
  parameters: Type.Object({
    query: Type.String({ description: "Search query" }),
    numResults: Type.Optional(
      Type.Number({ description: "Number of results to return. Defaults to 5" })
    ),
  }),
  execute: async (params, signal) => {
    const numResults = params.numResults ?? 5;

    // Try providers in order of preference
    if (process.env.BRAVE_SEARCH_API_KEY) {
      return braveSearch(params.query, numResults, signal);
    }
    if (process.env.SERP_API_KEY) {
      return serpApiSearch(params.query, numResults, signal);
    }
    if (process.env.GOOGLE_SEARCH_API_KEY && process.env.GOOGLE_SEARCH_CX) {
      return googleSearch(params.query, numResults, signal);
    }

    throw new Error(
      "No search provider configured. Set one of: BRAVE_SEARCH_API_KEY, SERP_API_KEY, or GOOGLE_SEARCH_API_KEY + GOOGLE_SEARCH_CX"
    );
  },
});

async function braveSearch(query: string, num: number, signal?: AbortSignal): Promise<string> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(num));

  const response = await fetch(url.toString(), {
    signal,
    headers: {
      "Accept": "application/json",
      "X-Subscription-Token": process.env.BRAVE_SEARCH_API_KEY!,
    },
  });

  if (!response.ok) throw new Error(`Brave Search error: ${response.status}`);
  const data = await response.json() as any;

  const results = (data.web?.results ?? []).map((r: any) => ({
    title: r.title,
    url: r.url,
    snippet: r.description,
  }));

  return JSON.stringify(results, null, 2);
}

async function serpApiSearch(query: string, num: number, signal?: AbortSignal): Promise<string> {
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("q", query);
  url.searchParams.set("num", String(num));
  url.searchParams.set("api_key", process.env.SERP_API_KEY!);

  const response = await fetch(url.toString(), { signal });
  if (!response.ok) throw new Error(`SerpAPI error: ${response.status}`);
  const data = await response.json() as any;

  const results = (data.organic_results ?? []).slice(0, num).map((r: any) => ({
    title: r.title,
    url: r.link,
    snippet: r.snippet,
  }));

  return JSON.stringify(results, null, 2);
}

async function googleSearch(query: string, num: number, signal?: AbortSignal): Promise<string> {
  const url = new URL("https://www.googleapis.com/customsearch/v1");
  url.searchParams.set("q", query);
  url.searchParams.set("num", String(Math.min(num, 10)));
  url.searchParams.set("key", process.env.GOOGLE_SEARCH_API_KEY!);
  url.searchParams.set("cx", process.env.GOOGLE_SEARCH_CX!);

  const response = await fetch(url.toString(), { signal });
  if (!response.ok) throw new Error(`Google Search error: ${response.status}`);
  const data = await response.json() as any;

  const results = (data.items ?? []).map((r: any) => ({
    title: r.title,
    url: r.link,
    snippet: r.snippet,
  }));

  return JSON.stringify(results, null, 2);
}
