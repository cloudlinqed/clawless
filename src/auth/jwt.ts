import { createHmac, createPublicKey, verify as verifySignature } from "node:crypto";

interface JwtHeader {
  alg?: string;
  typ?: string;
  kid?: string;
}

interface JwkKey {
  kid?: string;
  kty?: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
}

interface JwksResponse {
  keys?: JwkKey[];
}

export interface VerifyJwtOptions {
  secret?: string;
  jwksUrl?: string;
  issuer?: string;
  audience?: string;
}

const jwksCache = new Map<string, { expiresAt: number; keys: JwkKey[] }>();
const JWKS_TTL_MS = 5 * 60 * 1000;

export async function verifyJwt(
  token: string,
  options: VerifyJwtOptions
): Promise<{ header: JwtHeader; claims: Record<string, unknown> }> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("JWT must have exactly three parts");
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJson<JwtHeader>(encodedHeader);
  const claims = decodeJson<Record<string, unknown>>(encodedPayload);
  const alg = header.alg ?? "";

  if (alg === "HS256") {
    if (!options.secret) {
      throw new Error("AUTH_JWT_SECRET is required for HS256 tokens");
    }
    verifyHs256(`${encodedHeader}.${encodedPayload}`, encodedSignature, options.secret);
  } else if (alg === "RS256") {
    if (!options.jwksUrl) {
      throw new Error("AUTH_JWKS_URL is required for RS256 tokens");
    }
    await verifyRs256(`${encodedHeader}.${encodedPayload}`, encodedSignature, header.kid, options.jwksUrl);
  } else {
    throw new Error(`Unsupported JWT algorithm: ${alg || "unknown"}`);
  }

  validateClaims(claims, options);

  return { header, claims };
}

function decodeJson<T>(value: string): T {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf-8")) as T;
}

function verifyHs256(unsignedToken: string, encodedSignature: string, secret: string): void {
  const expected = createHmac("sha256", secret).update(unsignedToken).digest("base64url");
  if (expected !== encodedSignature) {
    throw new Error("JWT signature verification failed");
  }
}

async function verifyRs256(
  unsignedToken: string,
  encodedSignature: string,
  kid: string | undefined,
  jwksUrl: string
): Promise<void> {
  const jwk = await getJwk(jwksUrl, kid);
  if (!jwk) {
    throw new Error(`No matching JWK found for kid: ${kid ?? "missing"}`);
  }

  const publicKey = createPublicKey({ key: jwk as any, format: "jwk" });
  const verified = verifySignature(
    "RSA-SHA256",
    Buffer.from(unsignedToken, "utf-8"),
    publicKey,
    Buffer.from(encodedSignature, "base64url")
  );

  if (!verified) {
    throw new Error("JWT signature verification failed");
  }
}

async function getJwk(jwksUrl: string, kid?: string): Promise<JwkKey | null> {
  const cached = jwksCache.get(jwksUrl);
  if (cached && cached.expiresAt > Date.now()) {
    return selectKey(cached.keys, kid);
  }

  const response = await fetch(jwksUrl, {
    headers: { "Accept": "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch JWKS: ${response.status}`);
  }

  const data = await response.json() as JwksResponse;
  const keys = data.keys ?? [];
  jwksCache.set(jwksUrl, { expiresAt: Date.now() + JWKS_TTL_MS, keys });
  return selectKey(keys, kid);
}

function selectKey(keys: JwkKey[], kid?: string): JwkKey | null {
  if (kid) {
    return keys.find((key) => key.kid === kid) ?? null;
  }
  return keys[0] ?? null;
}

function validateClaims(claims: Record<string, unknown>, options: VerifyJwtOptions): void {
  const now = Math.floor(Date.now() / 1000);

  const exp = Number(claims.exp);
  if (Number.isFinite(exp) && exp < now) {
    throw new Error("JWT has expired");
  }

  const nbf = Number(claims.nbf);
  if (Number.isFinite(nbf) && nbf > now) {
    throw new Error("JWT is not yet valid");
  }

  if (options.issuer) {
    const issuer = typeof claims.iss === "string" ? claims.iss : undefined;
    if (issuer !== options.issuer) {
      throw new Error("JWT issuer mismatch");
    }
  }

  if (options.audience) {
    const claim = claims.aud;
    const valid = Array.isArray(claim)
      ? claim.includes(options.audience)
      : claim === options.audience;
    if (!valid) {
      throw new Error("JWT audience mismatch");
    }
  }
}
