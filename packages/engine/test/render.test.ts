import { describe, expect, it } from "vitest";
import { TemplateError, renderTemplate, renderValue, type RenderScope } from "../src/render.js";

const scope: RenderScope = {
  input: { query: "maya g", n: 3, flag: true },
  env: { BASE_URL: "https://api.example.com" },
  prev: { user: { name: "Maya" }, tags: ["a", "b"], count: 2 },
};

describe("renderTemplate", () => {
  it("substitutes all three roots", () => {
    expect(renderTemplate("{{env.BASE_URL}}/u/{{input.query}}/{{prev.count}}", scope)).toBe(
      "https://api.example.com/u/maya g/2",
    );
  });

  it("renders numbers and booleans plainly, objects as JSON", () => {
    expect(renderTemplate("{{input.n}}|{{input.flag}}|{{prev.user}}", scope)).toBe('3|true|{"name":"Maya"}');
  });

  it("renders missing leaves as empty string", () => {
    expect(renderTemplate("[{{prev.user.missing}}]", scope)).toBe("[]");
  });

  it("throws when traversing into a primitive", () => {
    expect(() => renderTemplate("{{prev.count.deep}}", scope)).toThrow(TemplateError);
  });

  it("leaves non-template text alone", () => {
    expect(renderTemplate("no refs here", scope)).toBe("no refs here");
  });

  it("percent-encodes only refs the encode callback selects", () => {
    const out = renderTemplate("{{env.BASE_URL}}/q={{input.query}}", scope, {
      encode: (ref) => ref.root !== "env",
    });
    expect(out).toBe("https://api.example.com/q=maya%20g");
  });
});

describe("renderValue", () => {
  it("passes values through with type intact for single refs", () => {
    expect(renderValue("{{prev.tags}}", scope)).toEqual(["a", "b"]);
    expect(renderValue("{{input.n}}", scope)).toBe(3);
    expect(renderValue("{{prev}}", scope)).toBe(scope.prev);
  });

  it("stringifies composite templates", () => {
    expect(renderValue("n={{input.n}}", scope)).toBe("n=3");
  });

  it("padded single ref is a string template, not a passthrough", () => {
    expect(renderValue(" {{input.n}}", scope)).toBe(" 3");
  });
});
