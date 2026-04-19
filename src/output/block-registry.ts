import type { z } from "zod";

/**
 * Built-in UI block types shipped with Clawless.
 * Custom block types registered at runtime cannot collide with these names.
 */
export const BUILTIN_OUTPUT_BLOCK_TYPES = [
  "markdown",
  "cards",
  "table",
  "timeline",
  "form",
  "filters",
  "actions",
  "citations",
] as const;

export type BuiltinOutputBlockType = (typeof BUILTIN_OUTPUT_BLOCK_TYPES)[number];

const BUILTIN_SET: ReadonlySet<string> = new Set(BUILTIN_OUTPUT_BLOCK_TYPES);

/**
 * A zod schema for a custom block. It must be a ZodObject whose `type` field
 * is a literal matching the registered block name, so it can participate in a
 * discriminated union alongside the built-in block schemas.
 */
export type CustomBlockSchema<T extends string = string> =
  z.ZodObject<{ type: z.ZodLiteral<T> } & Record<string, z.ZodTypeAny>>;

export interface CustomBlockAdapterContext {
  /** Title hint derived from the tool name or label */
  title: string;
  /** Optional prefix describing the envelope status (e.g. "HTTP 200 OK") */
  summaryPrefix?: string;
}

export interface CustomBlockDefinition<T extends string = string> {
  /** Unique block type name — cannot collide with built-ins or other registered blocks */
  type: T;

  /**
   * zod schema that validates an instance of this block. Must be a ZodObject
   * with `type: z.literal("<name>")` as its discriminator.
   */
  schema: CustomBlockSchema<T>;

  /**
   * Short natural-language description of the block shape. Shown to the LLM
   * via the `present_output` tool description so it knows when/how to produce
   * this block type.
   */
  toolDescription: string;

  /**
   * Optional adapter that converts a tool's JSON result into an instance of
   * this block type, for the auto-generated tool_end `ui` payload and the
   * post-processing salvage path.
   *
   * Return `null` if this adapter does not recognize the value.
   */
  adaptFromTool?: (value: unknown, context: CustomBlockAdapterContext) => unknown | null;

  /**
   * Whether an instance of this block satisfies `requireCitations`.
   * Defaults to `false`. Set to `true` if your block embeds citations
   * in its own shape.
   */
  providesCitations?: boolean;
}

const registry = new Map<string, CustomBlockDefinition>();

function assertValidCustomBlockType(type: string): void {
  if (!type || typeof type !== "string") {
    throw new Error("Custom block type must be a non-empty string");
  }
  if (BUILTIN_SET.has(type)) {
    throw new Error(`Cannot register block type "${type}": it is a built-in block type`);
  }
  if (registry.has(type)) {
    throw new Error(`Block type "${type}" is already registered`);
  }
  if (!/^[a-z][a-z0-9_-]*$/i.test(type)) {
    throw new Error(
      `Invalid block type "${type}": must start with a letter and contain only letters, digits, "_" or "-"`
    );
  }
}

/**
 * Register a custom UI block type. Call this once at startup — typically at the
 * top of your clawless.config.ts — before any agent runs.
 *
 * @throws if the block type collides with a built-in or previously registered block.
 */
export function registerBlock<T extends string>(definition: CustomBlockDefinition<T>): void {
  assertValidCustomBlockType(definition.type);
  registry.set(definition.type, definition as CustomBlockDefinition);
}

export function getRegisteredBlock(type: string): CustomBlockDefinition | undefined {
  return registry.get(type);
}

export function getRegisteredBlocks(): CustomBlockDefinition[] {
  return Array.from(registry.values());
}

export function getRegisteredBlockTypes(): string[] {
  return Array.from(registry.keys());
}

export function getBuiltinBlockTypes(): readonly string[] {
  return BUILTIN_OUTPUT_BLOCK_TYPES;
}

export function getAllBlockTypes(): string[] {
  return [...BUILTIN_OUTPUT_BLOCK_TYPES, ...registry.keys()];
}

export function isCustomBlockType(type: string): boolean {
  return registry.has(type);
}

/**
 * Remove all registered custom blocks. Useful for tests; not intended for
 * production use.
 */
export function clearRegisteredBlocks(): void {
  registry.clear();
}
