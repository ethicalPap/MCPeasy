import { describe, expect, it } from "vitest";
import type { GraphDoc } from "@mcpeasy/schema";
import { generatePythonProject } from "../src/renderer/src/export/python";
import { generateTypescriptProject } from "../src/renderer/src/export/typescript";
import { exportSlug, unsupportedCodeLanguages } from "../src/renderer/src/export/types";

function doc(overrides?: Partial<GraphDoc["server"]>): GraphDoc {
  return {
    version: 1,
    server: {
      name: "My Server!",
      description: "Test server",
      version: "1.2.3",
      transport: "stdio",
      auth: { type: "none" },
      env: ["API_KEY"],
      ...overrides,
    },
    nodes: {
      t1: {
        kind: "tool",
        name: "echo",
        description: "Echo. Use when testing.",
        inputs: [{ name: "message", type: "string" }],
        annotations: { readOnly: true },
        entry: "r1",
      },
      r1: { kind: "return", format: "json" },
    },
  };
}

const DOC_JSON = JSON.stringify(doc(), null, 2) + "\n";

describe("exportSlug", () => {
  it("lowercases and strips to package-name-safe characters", () => {
    expect(exportSlug("My Server!")).toBe("my-server");
    expect(exportSlug("  --Weird__Name--  ")).toBe("weird-name");
  });
  it("falls back when nothing usable remains", () => {
    expect(exportSlug("!!!")).toBe("mcp-server");
    expect(exportSlug("")).toBe("mcp-server");
  });
});

describe("generateTypescriptProject", () => {
  const { files, slug } = generateTypescriptProject(doc(), DOC_JSON);
  const byPath = new Map(files.map((f) => [f.path, f.content]));

  it("emits a complete project rooted at the slug", () => {
    expect(slug).toBe("my-server");
    expect([...byPath.keys()].sort()).toEqual([
      "my-server/.gitignore",
      "my-server/README.md",
      "my-server/graph.json",
      "my-server/package.json",
      "my-server/src/server.ts",
      "my-server/tsconfig.json",
    ]);
  });

  it("embeds the doc byte-identically so it re-opens in MCPeasy", () => {
    expect(byPath.get("my-server/graph.json")).toBe(DOC_JSON);
  });

  it("writes a valid package.json carrying the server version", () => {
    const pkg = JSON.parse(byPath.get("my-server/package.json")!) as Record<string, unknown>;
    expect(pkg.name).toBe("my-server");
    expect(pkg.version).toBe("1.2.3");
    expect(pkg.dependencies).toHaveProperty("@modelcontextprotocol/sdk");
  });

  it("emits the template-ref regex with correct escaping", () => {
    // The generator's template literal escapes backslashes; a mistake there
    // would emit a regex matching the wrong syntax. Assert the exact source.
    const server = byPath.get("my-server/src/server.ts")!;
    expect(server).toContain(String.raw`/\{\{\s*(input|env|prev)((?:\.[A-Za-z0-9_$-]+)*)\s*\}\}/g`);
    // stdout-protocol invariant documented for the person who edits the file.
    expect(server).toContain("nothing in this process may write to stdout except the transport");
  });

  it("lists required env vars in the README", () => {
    expect(byPath.get("my-server/README.md")).toContain("`API_KEY`");
  });
});

describe("generatePythonProject", () => {
  const { files, slug } = generatePythonProject(doc(), DOC_JSON);
  const byPath = new Map(files.map((f) => [f.path, f.content]));

  it("emits a complete project rooted at the slug", () => {
    expect(slug).toBe("my-server");
    expect([...byPath.keys()].sort()).toEqual([
      "my-server/.gitignore",
      "my-server/README.md",
      "my-server/graph.json",
      "my-server/pyproject.toml",
      "my-server/server.py",
    ]);
  });

  it("embeds the doc byte-identically", () => {
    expect(byPath.get("my-server/graph.json")).toBe(DOC_JSON);
  });

  it("pins the mcp dependency to the v1 line", () => {
    // The generated runtime uses the v1 low-level API; an unpinned resolve
    // would install mcp 2.x and break at import time.
    expect(byPath.get("my-server/pyproject.toml")).toContain('"mcp>=1.30,<2"');
  });

  it("emits the template-ref regex with correct escaping", () => {
    const server = byPath.get("my-server/server.py")!;
    expect(server).toContain(String.raw`re.compile(r"\{\{\s*(input|env|prev)((?:\.[A-Za-z0-9_$-]+)*)\s*\}\}")`);
  });

  it("gates local execution behind MCPEASY_ALLOW_LOCAL in both runtimes", () => {
    expect(byPath.get("my-server/server.py")).toContain("MCPEASY_ALLOW_LOCAL");
    const ts = generateTypescriptProject(doc(), DOC_JSON);
    expect(ts.files.find((f) => f.path.endsWith("server.ts"))!.content).toContain("MCPEASY_ALLOW_LOCAL");
  });
});

describe("custom-code language support in exported runtimes", () => {
  /** A doc whose single tool runs one custom-code block in `language`. */
  function codeDoc(language: string): GraphDoc {
    const base = doc();
    base.server.execution = { allowLocal: true };
    const nodes = base.nodes as unknown as Record<string, unknown>;
    nodes.t1 = { ...(nodes.t1 as object), entry: "c1" };
    nodes.c1 = { kind: "code", language, source: "return 1;", next: "r1" };
    return base;
  }

  it("lists unsupported languages per exporter, respecting each runtime's abilities", () => {
    const withPython = codeDoc("python");
    // The Python runtime runs Python blocks in-process, so for IT this graph
    // is fully supported while the TypeScript runtime cannot run it. The two
    // exporters must not share one hardcoded answer.
    expect(unsupportedCodeLanguages(withPython)).toEqual(["python"]);
    expect(unsupportedCodeLanguages(withPython, ["javascript", "python"])).toEqual([]);
  });

  it("reports nothing for a graph whose code is javascript", () => {
    expect(unsupportedCodeLanguages(codeDoc("javascript"))).toEqual([]);
  });

  it("deduplicates and sorts so the README text is deterministic", () => {
    // Insertion order here is ruby, go, ruby — DELIBERATELY reverse-alphabetical
    // so the assertion fails if the sort is ever dropped. (Verified by mutation:
    // removing .sort() makes this test fail.) Node ids are also ordered so the
    // object's own key order cannot accidentally supply the sorted result.
    const base = codeDoc("ruby");
    const nodes = base.nodes as unknown as Record<string, unknown>;
    nodes.c2 = { kind: "code", language: "go", source: "1", next: "r1" };
    nodes.c3 = { kind: "code", language: "ruby", source: "1", next: "r1" };
    expect(unsupportedCodeLanguages(base)).toEqual(["go", "ruby"]);
  });

  it("makes both exported runtimes refuse a language they cannot run, by name", () => {
    // The silent-wrong-answer risk this guards: without it, a Go block would
    // be handed to a JavaScript runner, which would either throw an opaque
    // syntax error or, worse, evaluate something unintended.
    const ts = generateTypescriptProject(codeDoc("go"), DOC_JSON);
    const server = ts.files.find((f) => f.path.endsWith("server.ts"))!.content;
    expect(server).toContain("is not supported by the exported runtime");

    const py = generatePythonProject(codeDoc("go"), DOC_JSON);
    const pyServer = py.files.find((f) => f.path.endsWith("server.py"))!.content;
    expect(pyServer).toContain("is not supported by the exported runtime");
    // ...but the Python runtime must still run Python blocks itself.
    expect(pyServer).toContain("_run_python_code");
  });

  it("warns in each README only when the graph actually needs it", () => {
    const quiet = generateTypescriptProject(codeDoc("javascript"), DOC_JSON);
    const quietReadme = quiet.files.find((f) => f.path.endsWith("README.md"))!.content;
    expect(quietReadme).not.toContain("Note on custom-code languages");

    const loud = generateTypescriptProject(codeDoc("python"), DOC_JSON);
    const loudReadme = loud.files.find((f) => f.path.endsWith("README.md"))!.content;
    expect(loudReadme).toContain("Note on custom-code languages");
    expect(loudReadme).toContain("`python`");

    // Python's README must stay silent about python, since it runs it.
    const pyQuiet = generatePythonProject(codeDoc("python"), DOC_JSON);
    const pyQuietReadme = pyQuiet.files.find((f) => f.path.endsWith("README.md"))!.content;
    expect(pyQuietReadme).not.toContain("Note on custom-code languages");
  });
});
