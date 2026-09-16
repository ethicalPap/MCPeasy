import { describe, expect, it } from "vitest";
import { envRefsIn, isSingleRef, parseTemplateRefs } from "../src/template.js";

describe("parseTemplateRefs", () => {
  it("parses input, env and prev refs with paths", () => {
    const refs = parseTemplateRefs("{{env.BASE_URL}}/contacts?q={{input.query}}&p={{prev.page.next}}");
    expect(refs.map((r) => [r.root, r.path])).toEqual([
      ["env", ["BASE_URL"]],
      ["input", ["query"]],
      ["prev", ["page", "next"]],
    ]);
  });

  it("parses bare {{prev}} with empty path", () => {
    const refs = parseTemplateRefs("{{prev}}");
    expect(refs).toHaveLength(1);
    expect(refs[0]!.path).toEqual([]);
  });

  it("tolerates whitespace inside braces", () => {
    expect(parseTemplateRefs("{{ input.q }}")).toHaveLength(1);
  });

  it("ignores unknown roots — closed set", () => {
    expect(parseTemplateRefs("{{secrets.KEY}} {{fn(x)}} {{}}")).toHaveLength(0);
  });

  it("allows dashes and $ in path segments (real API keys)", () => {
    const refs = parseTemplateRefs("{{prev.data-items.$meta}}");
    expect(refs[0]!.path).toEqual(["data-items", "$meta"]);
  });
});

describe("isSingleRef", () => {
  it("true for exactly one ref spanning the whole string", () => {
    expect(isSingleRef("{{prev}}")).toBe(true);
    expect(isSingleRef("{{input.body}}")).toBe(true);
  });

  it("false for padded or composite templates", () => {
    expect(isSingleRef(" {{prev}}")).toBe(false);
    expect(isSingleRef("{{prev}}!")).toBe(false);
    expect(isSingleRef("{{prev}}{{prev}}")).toBe(false);
  });
});

describe("envRefsIn", () => {
  it("collects only env roots", () => {
    expect(envRefsIn("{{env.A}} {{input.b}} {{env.C_D}}")).toEqual(["A", "C_D"]);
  });

  it("empty for bare env with no path", () => {
    expect(envRefsIn("{{env}}")).toEqual([]);
  });
});
