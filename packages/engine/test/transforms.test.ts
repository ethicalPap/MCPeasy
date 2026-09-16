import { describe, expect, it } from "vitest";
import { applyTransform } from "../src/transforms.js";
import type { TransformNode } from "@mcpeasy/schema";
import type { RenderScope } from "../src/render.js";

function scopeWith(prev: unknown): RenderScope {
  return { input: {}, env: {}, prev };
}

function pickNode(paths: string[]): TransformNode {
  return { kind: "transform", op: "pick", pick: paths, next: null };
}

describe("applyTransform pick", () => {
  it("picks flat and nested paths; last segment names the key", () => {
    const prev = { id: 7, address: { city: "Oslo", zip: "0150" }, noise: "x" };
    expect(applyTransform(pickNode(["id", "address.city"]), scopeWith(prev))).toEqual({
      id: 7,
      city: "Oslo",
    });
  });

  it("maps element-wise over arrays", () => {
    const prev = [
      { id: 1, name: "a", noise: true },
      { id: 2, name: "b", noise: false },
    ];
    expect(applyTransform(pickNode(["id", "name"]), scopeWith(prev))).toEqual([
      { id: 1, name: "a" },
      { id: 2, name: "b" },
    ]);
  });

  it("skips missing paths instead of erroring", () => {
    expect(applyTransform(pickNode(["id", "gone.deeper"]), scopeWith({ id: 1 }))).toEqual({ id: 1 });
  });

  it("empty pick list yields empty object", () => {
    expect(applyTransform(pickNode([]), scopeWith({ a: 1 }))).toEqual({});
  });
});

describe("applyTransform template", () => {
  it("renders string templates against the full scope", () => {
    const node: TransformNode = { kind: "transform", op: "template", template: "hello {{prev.name}}", next: null };
    expect(applyTransform(node, scopeWith({ name: "Maya" }))).toBe("hello Maya");
  });

  it("single-ref template passes the value through typed", () => {
    const node: TransformNode = { kind: "transform", op: "template", template: "{{prev.items}}", next: null };
    expect(applyTransform(node, scopeWith({ items: [1, 2] }))).toEqual([1, 2]);
  });

  it("throws when template op has no template", () => {
    const node: TransformNode = { kind: "transform", op: "template", next: null };
    expect(() => applyTransform(node, scopeWith({}))).toThrow(/requires a template/);
  });
});
