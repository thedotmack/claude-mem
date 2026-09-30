/**
 * OpenCode plugin-module acceptance rules, copied from the hosts' loaders so
 * contract tests can check the built bundle against every supported OpenCode
 * generation without installing OpenCode (plan-23 step 1).
 *
 * Keep these verbatim in behavior; update the pinned source when adding a host
 * version.
 */

type PluginModule = Record<string, unknown>;

// https://github.com/anomalyco/opencode/blob/51ef4be1d3c122f18fefb510dca8d778571f4f18/packages/tui/src/util/record.ts
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// https://github.com/anomalyco/opencode/blob/51ef4be1d3c122f18fefb510dca8d778571f4f18/packages/opencode/src/plugin/shared.ts (readPluginId, readV1Plugin)
function readPluginId(id: unknown, spec: string): string | undefined {
  if (id === undefined) return;
  if (typeof id !== "string") throw new TypeError(`Plugin ${spec} has invalid id type ${typeof id}`);
  const value = id.trim();
  if (!value) throw new TypeError(`Plugin ${spec} has an empty id`);
  return value;
}

function readV1Plugin(mod: PluginModule, spec: string): Record<string, unknown> | undefined {
  const value = mod.default;
  if (!isRecord(value)) return;
  if (!("id" in value) && !("server" in value) && !("tui" in value)) return;

  const server = "server" in value ? value.server : undefined;
  const tui = "tui" in value ? value.tui : undefined;
  if (server !== undefined && typeof server !== "function") {
    throw new TypeError(`Plugin ${spec} has invalid server export`);
  }
  if (tui !== undefined && typeof tui !== "function") {
    throw new TypeError(`Plugin ${spec} has invalid tui export`);
  }
  if (server !== undefined && tui !== undefined) {
    throw new TypeError(`Plugin ${spec} must default export either server() or tui(), not both`);
  }
  if (server === undefined) {
    throw new TypeError(`Plugin ${spec} must default export an object with server()`);
  }
  return value;
}

// https://github.com/anomalyco/opencode/blob/51ef4be1d3c122f18fefb510dca8d778571f4f18/packages/opencode/src/plugin/index.ts (getServerPlugin, getLegacyPlugins, applyPlugin)
function getServerPlugin(value: unknown): Function | undefined {
  if (typeof value === "function") return value;
  if (!isRecord(value) || !("server" in value)) return;
  if (typeof value.server !== "function") return;
  return value.server;
}

function getLegacyPlugins(mod: PluginModule): Function[] {
  const seen = new Set<unknown>();
  const result: Function[] = [];
  for (const entry of Object.values(mod)) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    const plugin = getServerPlugin(entry);
    if (!plugin) throw new TypeError("Plugin export is not a function");
    result.push(plugin);
  }
  return result;
}

/**
 * OpenCode 1.18 (file plugin): the `{ id, server }` default-export format when
 * present, otherwise the legacy every-export scan. Returns the server factories
 * the host would call, or throws the host's error.
 */
export function loadWithOpenCodeV1_18(mod: PluginModule, spec = "file:///plugin.js"): Function[] {
  const plugin = readV1Plugin(mod, spec);
  if (plugin) {
    // resolvePluginId(source === "file"): a path plugin must export an id.
    if (!readPluginId(plugin.id, spec)) throw new TypeError(`Path plugin ${spec} must export id`);
    return [plugin.server as Function];
  }
  return getLegacyPlugins(mod);
}

/** OpenCode 1.x before the `{ id, server }` format: every export is scanned. */
export function loadWithOpenCodeV1Legacy(mod: PluginModule): Function[] {
  return getLegacyPlugins(mod);
}

/**
 * OpenCode 2.x: `Schema.Struct({ default: Union([{ id: String, effect: fn },
 * { id: String, setup: fn }]) })`, decoded with Effect's default excess-property
 * handling (extra keys and other exports are ignored). An `effect` key selects
 * the Effect plugin path.
 * https://github.com/anomalyco/opencode/blob/84c9be93a56304a108f1a22df0c5d62c26d5b6ca/packages/core/src/plugin/module.ts
 */
export function loadWithOpenCodeV2(mod: PluginModule): { id: string; kind: "effect" | "setup"; entry: Function } {
  const value = mod.default;
  const fail = () =>
    new TypeError("Plugin must export a default definition with an id and an effect or setup function.");
  if (!isRecord(value) || typeof value.id !== "string") throw fail();
  if (typeof value.effect === "function") return { id: value.id, kind: "effect", entry: value.effect };
  if (typeof value.setup === "function") return { id: value.id, kind: "setup", entry: value.setup };
  throw fail();
}
