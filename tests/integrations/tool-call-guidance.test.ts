import { describe, it, expect } from "bun:test";
import { missingRequiredKeys } from "../../src/integrations/opencode-plugin/v2";
import {
  MAX_DESCRIPTION_CHARS,
  MAX_ENRICHMENT_CHARS,
  guidanceForPaths,
  hintForPath,
  parseValidationIssues,
  renderKeyList,
  toolKeyNames,
} from "../../src/integrations/opencode-plugin/tool-call-guidance";

describe("toolKeyNames", () => {
  it("sorts, deduplicates and caps key names at three without returning values", () => {
    expect(toolKeyNames(["zeta", "alpha", "beta", "alpha", "gamma"])).toEqual(["alpha", "beta", "gamma"]);
    expect(toolKeyNames(["b", "a", 42, null, { nested: "do-not-log" }, "a", "c"])).toEqual(["a", "b", "c"]);
    expect(toolKeyNames([])).toEqual([]);
  });

  it("never leaks a value through any of the five name paths", () => {
    const trap = "do-not-log";
    const schema = { type: "object", properties: { fields: { type: "object" }, status: { type: "string" } }, required: ["fields", "status"] };
    const fromParser = parseValidationIssues(`Invalid arguments for tool "x":\n- status: ${trap}\n`).map((issue) => issue.path);
    const paths: Array<{ label: string; values: unknown[] }> = [
      { label: "missingRequiredKeys", values: missingRequiredKeys(schema, { fields: trap, status: trap }) },
      { label: "raw Code Mode extractor", values: ["items", "fields"] },
      { label: "parsed validation issues", values: fromParser },
      { label: "enriched error", values: ["fields", "status"] },
      { label: "hint", values: ["fields", "status"] },
    ];
    for (const { label, values } of paths) {
      const names = toolKeyNames(values);
      expect(names, label).not.toContain(trap);
      expect(names.every((name) => /^[A-Za-z_][A-Za-z0-9_.[\]-]*$/.test(name)), label).toBe(true);
    }
    expect(hintForPath(schema, "fields") ?? "").not.toContain(trap);
  });
});

describe("guidanceForPaths", () => {
  const schema = {
    type: "object",
    properties: {
      cards: {
        type: "array",
        items: {
          type: "object",
          properties: { key: { type: "string", description: "Exact key" } },
        },
      },
      fields: {
        type: "object",
        description: 'Keys to set. Include "task" to update a to-do item.',
        additionalProperties: { type: "string" },
      },
      refOnly: { $ref: "#/$defs/thing", description: "must not be used" },
      union: { anyOf: [{ type: "string" }], description: "must not be used" },
      all: { type: "object", properties: { a: { type: "object", properties: { b: { type: "object", properties: { c: { type: "object", properties: { d: { type: "string" } } } } } } } } },
    },
  };

  it("descends into properties and items, and reports the literal shape of fields", () => {
    expect(guidanceForPaths(schema, ["cards[0].key", "fields"])).toEqual([
      { key: "cards[0].key", type: "string", description: "Exact key" },
      { key: "fields", type: "object", description: 'Keys to set. Include "task" to update a to-do item.' },
    ]);
  });

  it("stops on composition keywords and at the bounded depth without inventing a type", () => {
    expect(guidanceForPaths(schema, ["refOnly", "union", "cards[0].missing", "all.a.b.c.d.e", "cards.list"])).toEqual([
      { key: "refOnly" },
      { key: "union" },
      { key: "cards[0].missing" },
      { key: "all.a.b.c.d.e" },
      { key: "cards.list" },
    ]);
    expect(hintForPath(schema, "refOnly")).toBeUndefined();
    expect(hintForPath(schema, "union")).toBeUndefined();
    expect(hintForPath(schema, "fields.task")).toBeUndefined();
    expect(hintForPath(schema, "cards[0].key")).toBe("string — Exact key");
  });
});

describe("literal schema guidance", () => {
  const longDescription = "x".repeat(500) + "\n`backtick` more";
  const schema = {
    type: "object",
    properties: {
      note: { type: "string", description: longDescription, format: "date-time", enum: ["draft", "done"], examples: ["2026-01-01"] },
      count: { type: "integer", minimum: 1, maximum: 10 },
      cards: { type: "array", minItems: 1, maxItems: 5, items: { type: "object" } },
      tags: { type: "array", items: { type: "string", enum: ["x", "y"] } },
      extra: { type: "object", additionalProperties: { type: "string" } },
      opaqueExample: { type: "string", examples: [{ nested: "do-not-log" }] },
    },
  };

  it("flattens a long description to one bounded line and keeps only literal examples", () => {
    const note = guidanceForPaths(schema, ["note"])[0];
    expect(MAX_DESCRIPTION_CHARS).toBe(120);
    expect(MAX_ENRICHMENT_CHARS).toBe(400);
    expect(note.description).toBe("x".repeat(MAX_DESCRIPTION_CHARS));
    expect(note.description).not.toMatch(/[\n`]/);
    expect(note.example).toBe("2026-01-01");
    const opaqueExample = guidanceForPaths(schema, ["opaqueExample"])[0];
    expect("example" in opaqueExample).toBe(false);
  });

  it("uses only literal constraint fields and never fabricates one", () => {
    const note = hintForPath(schema, "note") ?? "";
    expect(note).toContain("one of: draft, done");
    expect(note).toContain("format: date-time");
    expect(note).toContain("example: 2026-01-01");
    expect(note).not.toContain("\n");

    const count = hintForPath(schema, "count") ?? "";
    expect(count).toContain("min: 1");
    expect(count).toContain("max: 10");
    expect(count).not.toContain("example:");

    const cards = hintForPath(schema, "cards") ?? "";
    expect(cards).toContain("minItems: 1");
    expect(cards).toContain("maxItems: 5");
    expect(cards).toContain("items: object");

    const tags = hintForPath(schema, "tags") ?? "";
    expect(tags).toContain("items: string");
    expect(tags).toContain("items one of: x, y");

    expect(hintForPath(schema, "extra")).toContain("values: string");
    expect(JSON.stringify(guidanceForPaths(schema, ["note", "count", "cards", "tags", "extra", "opaqueExample"]))).not.toContain("do-not-log");
  });
});

describe("parseValidationIssues", () => {
  const hostMessage = [
    'Invalid arguments for tool "claude_mem_get_observations":',
    "- ids: Expected array, received string",
    "- fields: Missing key",
    '- cards[0].key: Invalid option: expected one of "title"|"id"',
    '- status: Invalid option: expected one of "todo"|"done"',
    "- list: Missing key",
    "- ...and 2 more issues",
    "",
    "Arguments provided:",
    JSON.stringify({ fields: { secret: "do-not-log" } }, null, 2),
    "",
    "Update the arguments and call the tool again.",
  ].join("\n");

  it("reads the pinned host format up to five issues plus the count trailer", () => {
    const issues = parseValidationIssues(hostMessage);
    expect(issues).toEqual([
      { path: "ids", message: "Expected array, received string" },
      { path: "fields", message: "Missing key" },
      { path: "cards[0].key", message: 'Invalid option: expected one of "title"|"id"' },
      { path: "status", message: 'Invalid option: expected one of "todo"|"done"' },
      { path: "list", message: "Missing key" },
      { path: "", message: "...and 2 more issues" },
    ]);
    expect(JSON.stringify(issues)).not.toContain("do-not-log");
  });

  it("keeps the host singular form and caps issues without a trailer", () => {
    expect(parseValidationIssues('Invalid arguments for tool "x":\n- ...and 1 more issue\n')).toEqual([
      { path: "", message: "...and 1 more issue" },
    ]);
    const many = ["Invalid arguments for tool \"x\":", ...Array.from({ length: 7 }, (_, i) => `- key${i}: bad`), ""].join("\n");
    expect(parseValidationIssues(many)).toHaveLength(5);
    expect(parseValidationIssues("permission denied")).toEqual([]);
    expect(parseValidationIssues(undefined)).toEqual([]);
  });
});

describe("renderKeyList", () => {
  it("is the single, idempotent name-list formatter", () => {
    const values = ["zeta", "alpha", "alpha", "beta"];
    expect(renderKeyList(values)).toBe("alpha, beta, zeta");
    expect(renderKeyList(values)).toBe(toolKeyNames(values).join(", "));
    expect(renderKeyList(toolKeyNames(values))).toBe(renderKeyList(values));
    expect(renderKeyList(["do-not-log", "fields", "items", "list", "status"])).toBe("do-not-log, fields, items");
    expect(renderKeyList(["a", 42 as unknown as string])).toBe("a");
  });
});
