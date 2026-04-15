function normalizeMode(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

export function envFlag(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

export function isDevelopmentMode(): boolean {
  const explicit = normalizeMode(process.env.CLAWLESS_MODE);
  if (explicit === "production" || explicit === "prod") return false;
  if (explicit === "development" || explicit === "dev" || explicit === "test") return true;

  const nodeEnv = normalizeMode(process.env.NODE_ENV);
  if (nodeEnv === "production") return false;
  return true;
}

export function isProductionMode(): boolean {
  return !isDevelopmentMode();
}
