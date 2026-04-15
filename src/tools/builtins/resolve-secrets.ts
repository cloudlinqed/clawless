import { getSecretValue, listSecretKeys } from "../../config/knowledge.js";

/**
 * Resolve secret references in a string value.
 *
 * If the agent writes a secret key name (e.g. "SCRAPINGDOG_API_KEY") as a
 * literal value, this replaces it with the actual secret from process.env.
 *
 * Works on: URL query params, header values, body string values.
 * Matches against all registered secret key names.
 */
export function resolveSecretValue(value: string): string {
  // Check if the entire value is a known secret key name
  const resolved = getSecretValue(value);
  if (resolved && isSecretKey(value)) {
    return resolved;
  }
  return value;
}

/**
 * Resolve secrets in all query parameters of a URL.
 */
export function resolveSecretsInUrl(url: URL): void {
  for (const [key, value] of url.searchParams.entries()) {
    const resolved = resolveSecretValue(value);
    if (resolved !== value) {
      url.searchParams.set(key, resolved);
    }
  }
}

/**
 * Resolve secrets in header values.
 */
export function resolveSecretsInHeaders(headers: Record<string, string>): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    // Handle "Bearer SECRET_KEY_NAME" pattern
    if (value.startsWith("Bearer ")) {
      const token = value.slice(7).trim();
      const resolvedToken = resolveSecretValue(token);
      resolved[key] = resolvedToken !== token ? `Bearer ${resolvedToken}` : value;
    } else {
      resolved[key] = resolveSecretValue(value);
    }
  }
  return resolved;
}

/**
 * Resolve secrets in a JSON body (string values only, shallow + nested).
 */
export function resolveSecretsInBody(body: unknown): unknown {
  if (typeof body === "string") {
    return resolveSecretValue(body);
  }
  if (Array.isArray(body)) {
    return body.map(resolveSecretsInBody);
  }
  if (typeof body === "object" && body !== null) {
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      resolved[key] = resolveSecretsInBody(value);
    }
    return resolved;
  }
  return body;
}

/**
 * Check if a string looks like a secret key name
 * (UPPER_SNAKE_CASE and exists in env or registered secrets).
 */
function isSecretKey(value: string): boolean {
  if (!/^[A-Z][A-Z0-9_]{2,}$/.test(value)) return false;
  // Check registered secrets
  const keys = listSecretKeys();
  if (keys.some((k) => k.key === value)) return true;
  return false;
}
