import { describe, it, expect } from "bun:test";
import { missingRequiredKeys } from "../../src/integrations/opencode-plugin/v2";

describe("missingRequiredKeys", () => {
  it("reads required keys from the host-provided JSON schema", () => {
    const schema = { type: "object", properties: { list: { type: "string" }, fields: { type: "object" } }, required: ["list", "fields"], additionalProperties: false };
    expect(missingRequiredKeys(schema, { list: "plans" })).toEqual(["fields"]);
    expect(missingRequiredKeys(schema, { list: "plans", fields: {} })).toEqual([]);
  });

  it("treats an own key whose value is undefined as missing", () => {
    const schema = { type: "object", required: ["list", "fields"] };
    expect(missingRequiredKeys(schema, { list: "plans", fields: undefined })).toEqual(["fields"]);
    // An inherited value is still not an own, supplied key.
    const inherited = Object.create({ fields: {} }) as Record<string, unknown>;
    inherited.list = "plans";
    expect(missingRequiredKeys(schema, inherited)).toEqual(["fields"]);
  });

  it("returns nothing when the schema is absent or malformed", () => {
    expect(missingRequiredKeys(undefined, {})).toEqual([]);
    expect(missingRequiredKeys({ required: "fields" }, {})).toEqual([]);
  });

  it("does not resolve a nested required it cannot prove", () => {
    const schema = { type: "object", properties: { fields: { type: "object", required: ["task"] } } };
    expect(missingRequiredKeys(schema, { list: "plans" })).toEqual([]);
  });
});
