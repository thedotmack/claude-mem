/**
 * Shared, read-only schema guidance for rejected OpenCode tool calls.
 *
 * Every primitive here describes shape from literal schema fields only: no
 * argument value is logged or injected, no type is invented, and composition
 * keywords stop the descent instead of being resolved. Consumers format key
 * names through `renderKeyList` and bound the final emission with
 * `MAX_ENRICHMENT_CHARS`; nothing in this module stores or retries a call.
 */

export const MAX_DESCRIPTION_CHARS = 120;
export const MAX_ENRICHMENT_CHARS = 400;

export interface GuidanceEntry {
  key: string;
  type?: string;
  description?: string;
  example?: string | number | boolean;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

type SchemaNode = Record<string, unknown>;

function isNode(value: unknown): value is SchemaNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOpaque(node: SchemaNode): boolean {
  return "$ref" in node || "anyOf" in node || "oneOf" in node || "allOf" in node;
}

function literalType(node: SchemaNode): string | undefined {
  const type = node.type;
  if (typeof type === "string" && type.trim()) return type;
  if (!Array.isArray(type)) return undefined;
  const types = type.filter((value): value is string => typeof value === "string" && value.trim() !== "");
  return types.length > 0 ? types.join("|") : undefined;
}

function literalValues(value: unknown): Array<string | number | boolean> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string | number | boolean =>
      typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean",
  );
}

function oneLineDescription(node: SchemaNode): string | undefined {
  if (typeof node.description !== "string") return undefined;
  const flattened = node.description.replace(/[\r\n\t`]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return flattened ? flattened.slice(0, MAX_DESCRIPTION_CHARS) : undefined;
}

function literalExample(node: SchemaNode): string | number | boolean | undefined {
  if (!Array.isArray(node.examples)) return undefined;
  for (const example of node.examples) {
    if (typeof example === "string" && example) return example.slice(0, MAX_DESCRIPTION_CHARS);
    if (typeof example === "number" && Number.isFinite(example)) return example;
    if (typeof example === "boolean") return example;
  }
  return undefined;
}

/**
 * One bounded descent for both presentations. Only literal `properties` and
 * `items` are followed, at most four segments deep; a composition keyword at
 * any level ends the walk without producing a guessed type.
 */
function descend(schema: unknown, path: string): SchemaNode | undefined {
  if (!isNode(schema) || isOpaque(schema)) return undefined;
  const segments = path.split(/[.[\]]+/).filter(Boolean);
  let node: SchemaNode | undefined = schema;
  for (let index = 0; index < segments.length; index += 1) {
    if (index >= 4 || !node || isOpaque(node)) return undefined;
    const segment = segments[index];
    if (/^\d+$/.test(segment)) {
      node = isNode(node.items) ? node.items : undefined;
      continue;
    }
    const properties = node.properties;
    const child = isNode(properties) ? properties[segment] : undefined;
    node = isNode(child) ? child : undefined;
  }
  return node && !isOpaque(node) ? node : undefined;
}

function constraints(node: SchemaNode): string[] {
  const parts: string[] = [];
  const values = literalValues(node.enum);
  if (values.length > 0) parts.push(`one of: ${values.join(", ")}`);
  if (typeof node.format === "string" && node.format.trim()) parts.push(`format: ${node.format}`);
  if (typeof node.minimum === "number" && Number.isFinite(node.minimum)) parts.push(`min: ${node.minimum}`);
  if (typeof node.maximum === "number" && Number.isFinite(node.maximum)) parts.push(`max: ${node.maximum}`);
  if (typeof node.minItems === "number" && Number.isFinite(node.minItems)) parts.push(`minItems: ${node.minItems}`);
  if (typeof node.maxItems === "number" && Number.isFinite(node.maxItems)) parts.push(`maxItems: ${node.maxItems}`);
  if (isNode(node.items)) {
    const itemType = literalType(node.items);
    if (itemType) parts.push(`items: ${itemType}`);
    const itemValues = literalValues(node.items.enum);
    if (itemValues.length > 0) parts.push(`items one of: ${itemValues.join(", ")}`);
  }
  if (isNode(node.additionalProperties)) {
    const valueType = literalType(node.additionalProperties);
    if (valueType) parts.push(`values: ${valueType}`);
  }
  return parts;
}

/** Shape guidance for each requested path; opaque or unknown paths yield the key alone. */
export function guidanceForPaths(schema: unknown, paths: Iterable<string>): GuidanceEntry[] {
  return Array.from(paths, (path): GuidanceEntry => {
    const entry: GuidanceEntry = { key: path };
    const node = descend(schema, path);
    if (!node) return entry;
    const type = literalType(node);
    if (type) entry.type = type;
    const description = oneLineDescription(node);
    if (description) entry.description = description;
    const example = literalExample(node);
    if (example !== undefined) entry.example = example;
    return entry;
  });
}

/**
 * The common hint for missing `required` keys and parsed validation issues.
 * Reads the same bounded descent as `guidanceForPaths`, plus literal schema
 * constraints; returns nothing rather than guessing a shape.
 */
export function hintForPath(schema: unknown, path: string): string | undefined {
  const node = descend(schema, path);
  if (!node) return undefined;
  const parts: string[] = [];
  const type = literalType(node);
  if (type) parts.push(type);
  const description = oneLineDescription(node);
  if (description) parts.push(description);
  parts.push(...constraints(node));
  const example = literalExample(node);
  if (example !== undefined) parts.push(`example: ${example}`);
  return parts.length > 0 ? parts.join(" — ") : undefined;
}

/** Key names only: strings, deduplicated, sorted and capped at three. */
export function toolKeyNames(values: Iterable<unknown>): string[] {
  if (!values || typeof values[Symbol.iterator] !== "function") return [];
  const names = new Set<string>();
  for (const value of values) {
    if (typeof value === "string") names.add(value);
  }
  return [...names].sort().slice(0, 3);
}

/** The only formatter for lists of key names; idempotent and value-free. */
export function renderKeyList(keys: Iterable<string>): string {
  return toolKeyNames(keys).join(", ");
}

/**
 * Reads the host's pinned detail lines (`packages/core/src/tool/runtime.ts`),
 * stopping before the `Arguments provided` block so argument values can never
 * enter the result. Keeps at most five issues plus the host's count trailer,
 * whose empty path marks it as a counter rather than a key.
 */
export function parseValidationIssues(message: unknown): ValidationIssue[] {
  if (typeof message !== "string" || !message) return [];
  const issues: ValidationIssue[] = [];
  let trailer: ValidationIssue | undefined;
  let inDetails = false;
  for (const line of message.split(/\r?\n/)) {
    if (/^Invalid arguments for tool\b/.test(line)) {
      inDetails = true;
      continue;
    }
    if (/^(Arguments provided:|Update the arguments and call the tool again\.)\s*$/.test(line)) break;
    if (!inDetails) continue;
    const trailerLine = /^- (\.\.\.and \d+ more issues?)$/.exec(line);
    if (trailerLine) {
      trailer = { path: "", message: trailerLine[1] };
      continue;
    }
    const detail = /^- ([^\s:]+): (.+)$/.exec(line);
    if (!detail) continue;
    const [, path, rawMessage] = detail;
    const text = rawMessage.trim();
    if (issues.length < 5) issues.push({ path, message: text });
  }
  return trailer ? [...issues, trailer] : issues;
}
