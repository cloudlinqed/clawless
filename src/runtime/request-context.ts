import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestAuthContext {
  required: boolean;
  authenticated: boolean;
  isAdmin: boolean;
  source: "none" | "admin_key" | "trusted_header" | "jwt";
  userId?: string;
  claims?: Record<string, unknown>;
}

export interface RequestContext {
  userId: string;
  sessionKey: string;
  agentName: string;
  auth: RequestAuthContext;
  slots: Map<string, unknown>;
}

const requestContextStorage = new AsyncLocalStorage<RequestContext>();

export function createRequestContext(input: {
  userId: string;
  sessionKey: string;
  agentName: string;
  auth: RequestAuthContext;
}): RequestContext {
  return {
    userId: input.userId,
    sessionKey: input.sessionKey,
    agentName: input.agentName,
    auth: input.auth,
    slots: new Map(),
  };
}

export function runWithRequestContext<T>(
  context: RequestContext,
  fn: () => Promise<T> | T
): Promise<T> | T {
  return requestContextStorage.run(context, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return requestContextStorage.getStore();
}

export function requireRequestContext(): RequestContext {
  const context = getRequestContext();
  if (!context) {
    throw new Error("Request context is not available");
  }
  return context;
}

export function getRequestSlot<T>(key: string, init: () => T): T {
  const context = requireRequestContext();
  if (!context.slots.has(key)) {
    context.slots.set(key, init());
  }
  return context.slots.get(key) as T;
}

export function deriveRequestContext(
  overrides: Partial<Pick<RequestContext, "userId" | "sessionKey" | "agentName" | "auth">>,
  options?: { freshSlots?: boolean }
): RequestContext {
  const current = requireRequestContext();
  return {
    userId: overrides.userId ?? current.userId,
    sessionKey: overrides.sessionKey ?? current.sessionKey,
    agentName: overrides.agentName ?? current.agentName,
    auth: overrides.auth ?? current.auth,
    slots: options?.freshSlots ? new Map() : current.slots,
  };
}
