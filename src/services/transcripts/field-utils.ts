import type { FieldSpec, MatchRule, TranscriptSchema, WatchTarget } from './types.js';

interface ResolveContext {
  watch: WatchTarget;
  schema: TranscriptSchema;
  session?: Record<string, unknown>;
}

function parsePath(path: string): Array<string | number> {
  const cleaned = path.trim().replace(/^\$\.?/, '');
  if (!cleaned) return [];

  const tokens: Array<string | number> = [];
  const parts = cleaned.split('.');

  for (const part of parts) {
    const regex = /([^[\]]+)|\[(\d+)\]/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(part)) !== null) {
      if (match[1]) {
        tokens.push(match[1]);
      } else if (match[2]) {
        tokens.push(parseInt(match[2], 10));
      }
    }
  }

  return tokens;
}

export function getValueByPath(input: unknown, path: string): unknown {
  if (!path) return undefined;
  const tokens = parsePath(path);
  let current: any = input;

  for (const token of tokens) {
    if (current === null || current === undefined) return undefined;
    current = current[token as any];
  }

  return current;
}

function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function resolveFromContext(path: string, ctx: ResolveContext): unknown {
  if (path.startsWith('$watch.')) {
    const key = path.slice('$watch.'.length);
    return (ctx.watch as any)[key];
  }
  if (path.startsWith('$schema.')) {
    const key = path.slice('$schema.'.length);
    return (ctx.schema as any)[key];
  }
  if (path.startsWith('$session.')) {
    const key = path.slice('$session.'.length);
    return ctx.session ? (ctx.session as any)[key] : undefined;
  }
  if (path === '$cwd') return ctx.watch.workspace;
  if (path === '$project') return ctx.watch.project;
  return undefined;
}

export function resolveFieldSpec(
  spec: FieldSpec | undefined,
  entry: unknown,
  ctx: ResolveContext
): unknown {
  if (spec === undefined) return undefined;

  if (typeof spec === 'string') {
    const fromContext = resolveFromContext(spec, ctx);
    if (fromContext !== undefined) return fromContext;
    return getValueByPath(entry, spec);
  }

  if (spec.coalesce && Array.isArray(spec.coalesce)) {
    for (const candidate of spec.coalesce) {
      const value = resolveFieldSpec(candidate, entry, ctx);
      if (!isEmptyValue(value)) return value;
    }
  }

  if (spec.path) {
    const fromContext = resolveFromContext(spec.path, ctx);
    if (fromContext !== undefined) return fromContext;
    const value = getValueByPath(entry, spec.path);
    if (!isEmptyValue(value)) return value;
  }

  if (spec.value !== undefined) return spec.value;

  if (spec.default !== undefined) return spec.default;

  return undefined;
}

export function resolveFields(
  fields: Record<string, FieldSpec> | undefined,
  entry: unknown,
  ctx: ResolveContext
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  if (!fields) return resolved;

  for (const [key, spec] of Object.entries(fields)) {
    resolved[key] = resolveFieldSpec(spec, entry, ctx);
  }

  return resolved;
}

export function matchesRule(
  entry: unknown,
  rule: MatchRule | undefined,
  schema: TranscriptSchema
): boolean {
  if (!rule) return true;

  const path = rule.path || schema.eventTypePath || 'type';
  const value = path ? getValueByPath(entry, path) : undefined;

  if (rule.exists) {
    if (value === undefined || value === null || value === '') return false;
  }

  if (rule.equals !== undefined) {
    return value === rule.equals;
  }

  if (rule.in && Array.isArray(rule.in)) {
    return rule.in.includes(value);
  }

  if (rule.contains !== undefined) {
    return typeof value === 'string' && value.includes(rule.contains);
  }

  if (rule.regex) {
    try {
      const regex = new RegExp(rule.regex);
      return regex.test(String(value ?? ''));
    } catch {
      return false;
    }
  }

  return true;
}
