import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { AgentDef } from "../config/agent-def.js";
import { getAgent } from "../config/agent-def.js";
import { listKnowledge } from "../config/knowledge.js";
import { listTools } from "../config/tool-store.js";
import { requireRequestContext } from "../runtime/request-context.js";
import { isDevelopmentMode } from "../runtime/mode.js";
import { getHttpToolConfig } from "../tools/http-tool.js";

const LOCAL_HOSTNAMES = new Set([
  "localhost",
  "0.0.0.0",
  "127.0.0.1",
  "::1",
  "host.docker.internal",
  "metadata.google.internal",
]);

function normalizeHostPattern(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    try {
      return new URL(trimmed).hostname.toLowerCase();
    } catch {
      return null;
    }
  }

  return trimmed.replace(/:\d+$/, "");
}

function parseHostPatterns(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map(normalizeHostPattern)
    .filter((value): value is string => Boolean(value));
}

export function extractUrlsFromText(text: string): URL[] {
  const matches = text.match(/https?:\/\/[^\s"'<>`]+/g) ?? [];
  const urls: URL[] = [];

  for (const match of matches) {
    try {
      urls.push(new URL(match));
    } catch {
      // Ignore malformed URLs in knowledge text.
    }
  }

  return urls;
}

function collectStaticHttpToolHosts(agentDef: AgentDef): string[] {
  const hosts: string[] = [];

  for (const tool of agentDef.tools) {
    const config = getHttpToolConfig(tool);
    if (!config) continue;

    try {
      hosts.push(new URL(config.url).hostname.toLowerCase());
    } catch {
      // Ignore invalid URLs from user config here; tool execution will fail later.
    }
  }

  return hosts;
}

export function collectContextualAllowedHosts(agentDef: AgentDef): string[] {
  const discovered = new Set<string>();
  const explicit = [
    ...parseHostPatterns(process.env.OUTBOUND_ALLOWED_HOSTS),
    ...(agentDef.networkPolicy?.allowHosts ?? [])
      .map(normalizeHostPattern)
      .filter((value): value is string => Boolean(value)),
  ];

  for (const host of explicit) {
    discovered.add(host);
  }

  for (const host of collectStaticHttpToolHosts(agentDef)) {
    discovered.add(host);
  }

  for (const tool of listTools(agentDef.name)) {
    try {
      discovered.add(new URL(tool.url).hostname.toLowerCase());
    } catch {
      // Ignore malformed persisted tool URLs.
    }
  }

  for (const item of listKnowledge(agentDef.name)) {
    for (const url of extractUrlsFromText(item.content)) {
      discovered.add(url.hostname.toLowerCase());
    }
  }

  return Array.from(discovered.values());
}

export function matchesHostPattern(hostname: string, pattern: string): boolean {
  const normalizedHost = hostname.trim().toLowerCase();
  const normalizedPattern = normalizeHostPattern(pattern);
  if (!normalizedPattern) return false;

  if (normalizedPattern.startsWith("*.")) {
    const suffix = normalizedPattern.slice(2);
    return normalizedHost === suffix || normalizedHost.endsWith(`.${suffix}`);
  }

  return normalizedHost === normalizedPattern;
}

function ipv4ToNumber(address: string): number {
  return address.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0);
}

function isPrivateIpv4(address: string): boolean {
  const value = ipv4ToNumber(address);
  const ranges: Array<[number, number]> = [
    [ipv4ToNumber("0.0.0.0"), ipv4ToNumber("0.255.255.255")],
    [ipv4ToNumber("10.0.0.0"), ipv4ToNumber("10.255.255.255")],
    [ipv4ToNumber("100.64.0.0"), ipv4ToNumber("100.127.255.255")],
    [ipv4ToNumber("127.0.0.0"), ipv4ToNumber("127.255.255.255")],
    [ipv4ToNumber("169.254.0.0"), ipv4ToNumber("169.254.255.255")],
    [ipv4ToNumber("172.16.0.0"), ipv4ToNumber("172.31.255.255")],
    [ipv4ToNumber("192.0.0.0"), ipv4ToNumber("192.0.0.255")],
    [ipv4ToNumber("192.168.0.0"), ipv4ToNumber("192.168.255.255")],
    [ipv4ToNumber("198.18.0.0"), ipv4ToNumber("198.19.255.255")],
    [ipv4ToNumber("224.0.0.0"), ipv4ToNumber("255.255.255.255")],
  ];

  return ranges.some(([start, end]) => value >= start && value <= end);
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  return (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:10.") ||
    normalized.startsWith("::ffff:192.168.") ||
    normalized.startsWith("::ffff:172.")
  );
}

function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPrivateIpv4(address);
  if (version === 6) return isPrivateIpv6(address);
  return false;
}

async function assertNoPrivateResolution(hostname: string): Promise<void> {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized) {
    throw new Error("Outbound URL must include a hostname");
  }

  if (
    LOCAL_HOSTNAMES.has(normalized) ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local")
  ) {
    throw new Error(`Outbound requests to local or metadata hosts are blocked: ${hostname}`);
  }

  if (isPrivateAddress(normalized)) {
    throw new Error(`Outbound requests to private IP addresses are blocked: ${hostname}`);
  }

  try {
    const results = await lookup(normalized, { all: true, verbatim: true });
    if (results.some((entry) => isPrivateAddress(entry.address))) {
      throw new Error(`Outbound requests to private network targets are blocked: ${hostname}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("blocked")) {
      throw err;
    }
    // Let normal fetch error handling deal with DNS failures.
  }
}

function getAgentNetworkPolicy(agentName: string) {
  const agentDef = getAgent(agentName);
  if (!agentDef) {
    throw new Error(`Unknown agent: ${agentName}`);
  }

  return {
    agentDef,
    mode: agentDef.networkPolicy?.mode ?? "contextual",
    allowHttp: agentDef.networkPolicy?.allowHttp ?? isDevelopmentMode(),
    allowedHosts: collectContextualAllowedHosts(agentDef),
  };
}

export async function assertBuiltinOutboundAllowed(rawUrl: string): Promise<void> {
  const context = requireRequestContext();
  const { agentDef, mode, allowHttp, allowedHosts } = getAgentNetworkPolicy(context.agentName);
  const url = new URL(rawUrl);

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`Unsupported outbound protocol: ${url.protocol}`);
  }

  if (url.protocol === "http:" && !allowHttp) {
    throw new Error("Plain HTTP is blocked for builtin outbound requests. Use HTTPS or enable allowHttp explicitly.");
  }

  await assertNoPrivateResolution(url.hostname);

  if (mode === "disabled") {
    throw new Error(`Builtin outbound HTTP is disabled for agent "${agentDef.name}"`);
  }

  if (mode === "open") {
    return;
  }

  if (allowedHosts.length === 0) {
    throw new Error(
      `No outbound hosts are allowed for agent "${agentDef.name}". Add a configured tool URL, a knowledge URL, or networkPolicy.allowHosts.`
    );
  }

  const allowed = allowedHosts.some((pattern) => matchesHostPattern(url.hostname, pattern));
  if (!allowed) {
    throw new Error(
      `Outbound host "${url.hostname}" is not allowed for agent "${agentDef.name}". Allowed hosts: ${allowedHosts.join(", ")}`
    );
  }
}
