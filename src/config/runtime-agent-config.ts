import { z } from "zod";
import type {
  AgentBuiltinPolicy,
  AgentDef,
  AgentGuardrails,
  AgentNetworkPolicy,
  AgentOutputSchema,
} from "./agent-def.js";

export const AgentBuiltinPolicySchema = z.object({
  allow: z.array(z.string().min(1)).optional(),
  deny: z.array(z.string().min(1)).optional(),
}).strict();

export const AgentGuardrailsSchema = z.object({
  domain: z.string().min(1).optional(),
  refuseOutOfScope: z.boolean().optional(),
  outOfScopeMessage: z.string().min(1).optional(),
  hideInternalDetails: z.boolean().optional(),
}).strict();

export const AgentNetworkPolicySchema = z.object({
  mode: z.enum(["contextual", "open", "disabled"]).optional(),
  allowHosts: z.array(z.string().min(1)).optional(),
  allowHttp: z.boolean().optional(),
}).strict();

export const AgentOutputBlockTypeSchema = z
  .string()
  .min(1)
  .regex(/^[a-z][a-z0-9_-]*$/i, "Block type must start with a letter and contain only letters, digits, '_' or '-'");

export const AgentOutputSchemaSchema = z.object({
  mode: z.enum(["auto", "required", "off"]).optional(),
  allowedBlocks: z.array(AgentOutputBlockTypeSchema).optional(),
  preferredBlocks: z.array(AgentOutputBlockTypeSchema).optional(),
  requiredBlocks: z.array(AgentOutputBlockTypeSchema).optional(),
  requireCitations: z.boolean().optional(),
  instructions: z.string().min(1).optional(),
  onInvalid: z.enum(["repair", "reject"]).optional(),
}).strict();

const AgentRetrievalSourceKnowledgeSchema = z.object({
  type: z.literal("knowledge"),
  topK: z.number().int().min(1).max(50).optional(),
  maxChars: z.number().int().min(100).max(100_000).optional(),
  minScore: z.number().min(0).max(100).optional(),
  chunkSize: z.number().int().min(200).max(10_000).optional(),
  chunkOverlap: z.number().int().min(0).max(2_000).optional(),
}).strict();

const AgentRetrievalSourceRetrieverSchema = z.object({
  type: z.literal("retriever"),
  name: z.string().min(1),
  topK: z.number().int().min(1).max(50).optional(),
  maxChars: z.number().int().min(100).max(100_000).optional(),
  minScore: z.number().min(0).max(100).optional(),
}).strict();

export const AgentRetrievalConfigSchema = z.object({
  mode: z.enum(["off", "indexed", "hybrid"]).optional(),
  topK: z.number().int().min(1).max(50).optional(),
  maxChars: z.number().int().min(100).max(100_000).optional(),
  sources: z.array(z.union([AgentRetrievalSourceKnowledgeSchema, AgentRetrievalSourceRetrieverSchema])).optional(),
  instructions: z.string().min(1).optional(),
}).strict();

export const RuntimeAgentConfigSchema = z.object({
  name: z.string().min(1),
  instructions: z.string().min(1),
  builtinPolicy: AgentBuiltinPolicySchema.optional(),
  guardrails: AgentGuardrailsSchema.optional(),
  networkPolicy: AgentNetworkPolicySchema.optional(),
  outputSchema: AgentOutputSchemaSchema.optional(),
  retrieval: AgentRetrievalConfigSchema.optional(),
  model: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  fallbackModels: z.array(z.string().min(1)).optional(),
  maxTurns: z.number().int().min(1).max(100).optional(),
  createdAt: z.number().int().optional(),
  updatedAt: z.number().int().optional(),
});

export type RuntimeAgentConfig = z.infer<typeof RuntimeAgentConfigSchema>;

export function runtimeAgentConfigFromAgent(def: AgentDef): RuntimeAgentConfig {
  const now = Date.now();
  return {
    name: def.name,
    instructions: def.instructions,
    builtinPolicy: def.builtinPolicy ? clone(def.builtinPolicy) : undefined,
    guardrails: def.guardrails ? clone(def.guardrails) : undefined,
    networkPolicy: def.networkPolicy ? clone(def.networkPolicy) : undefined,
    outputSchema: def.outputSchema ? clone(def.outputSchema) : undefined,
    retrieval: def.retrieval ? clone(def.retrieval) : undefined,
    model: def.model,
    provider: def.provider,
    fallbackModels: def.fallbackModels ? [...def.fallbackModels] : undefined,
    maxTurns: def.maxTurns,
    createdAt: now,
    updatedAt: now,
  };
}

export function mergeAgentConfig(
  base: AgentDef | undefined,
  runtimeConfig: RuntimeAgentConfig
): AgentDef {
  return {
    name: runtimeConfig.name,
    instructions: runtimeConfig.instructions,
    tools: base?.tools ? [...base.tools] : [],
    builtinPolicy: mergeBuiltinPolicy(base?.builtinPolicy, runtimeConfig.builtinPolicy),
    guardrails: mergeGuardrails(base?.guardrails, runtimeConfig.guardrails),
    networkPolicy: mergeNetworkPolicy(base?.networkPolicy, runtimeConfig.networkPolicy),
    outputSchema: mergeOutputSchema(base?.outputSchema, runtimeConfig.outputSchema),
    retrieval: mergeRetrieval(base?.retrieval, runtimeConfig.retrieval),
    model: runtimeConfig.model ?? base?.model,
    provider: runtimeConfig.provider ?? base?.provider,
    fallbackModels: runtimeConfig.fallbackModels ? [...runtimeConfig.fallbackModels] : base?.fallbackModels ? [...base.fallbackModels] : undefined,
    maxTurns: runtimeConfig.maxTurns ?? base?.maxTurns,
  };
}

function mergeBuiltinPolicy(
  base: AgentBuiltinPolicy | undefined,
  override: RuntimeAgentConfig["builtinPolicy"]
): AgentBuiltinPolicy | undefined {
  if (!base && !override) return undefined;
  return {
    allow: override?.allow ? [...override.allow] : base?.allow ? [...base.allow] : undefined,
    deny: override?.deny ? [...override.deny] : base?.deny ? [...base.deny] : undefined,
  };
}

function mergeGuardrails(
  base: AgentGuardrails | undefined,
  override: RuntimeAgentConfig["guardrails"]
): AgentGuardrails | undefined {
  if (!base && !override) return undefined;
  return {
    domain: override?.domain ?? base?.domain,
    refuseOutOfScope: override?.refuseOutOfScope ?? base?.refuseOutOfScope,
    outOfScopeMessage: override?.outOfScopeMessage ?? base?.outOfScopeMessage,
    hideInternalDetails: override?.hideInternalDetails ?? base?.hideInternalDetails,
  };
}

function mergeNetworkPolicy(
  base: AgentNetworkPolicy | undefined,
  override: RuntimeAgentConfig["networkPolicy"]
): AgentNetworkPolicy | undefined {
  if (!base && !override) return undefined;
  return {
    mode: override?.mode ?? base?.mode,
    allowHosts: override?.allowHosts ? [...override.allowHosts] : base?.allowHosts ? [...base.allowHosts] : undefined,
    allowHttp: override?.allowHttp ?? base?.allowHttp,
  };
}

function mergeOutputSchema(
  base: AgentOutputSchema | undefined,
  override: RuntimeAgentConfig["outputSchema"]
): AgentOutputSchema | undefined {
  if (!base && !override) return undefined;
  return {
    mode: override?.mode ?? base?.mode,
    allowedBlocks: override?.allowedBlocks ? [...override.allowedBlocks] : base?.allowedBlocks ? [...base.allowedBlocks] : undefined,
    preferredBlocks: override?.preferredBlocks ? [...override.preferredBlocks] : base?.preferredBlocks ? [...base.preferredBlocks] : undefined,
    requiredBlocks: override?.requiredBlocks ? [...override.requiredBlocks] : base?.requiredBlocks ? [...base.requiredBlocks] : undefined,
    requireCitations: override?.requireCitations ?? base?.requireCitations,
    instructions: override?.instructions ?? base?.instructions,
    onInvalid: override?.onInvalid ?? base?.onInvalid,
  };
}

function mergeRetrieval(
  base: RuntimeAgentConfig["retrieval"] | undefined,
  override: RuntimeAgentConfig["retrieval"] | undefined
) {
  if (!base && !override) return undefined;
  return {
    mode: override?.mode ?? base?.mode,
    topK: override?.topK ?? base?.topK,
    maxChars: override?.maxChars ?? base?.maxChars,
    sources: override?.sources ? clone(override.sources) : base?.sources ? clone(base.sources) : undefined,
    instructions: override?.instructions ?? base?.instructions,
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
