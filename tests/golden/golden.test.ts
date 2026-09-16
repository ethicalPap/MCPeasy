import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer, loadGraphDoc } from "@mcpeasy/engine";
import { goldenCases, type GoldenCase } from "./cases.js";
import { normalizeResult } from "./normalize.js";

const examplesDir = fileURLToPath(new URL("../../examples/", import.meta.url));

function stubFetch(routes: NonNullable<GoldenCase["stub"]>): typeof fetch {
  return async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const route = routes[url.pathname];
    if (!route) {
      // A miss is a broken TEST, not a broken engine — fail loudly instead
      // of letting the engine's network-error mapping swallow it.
      throw new Error(`golden stub has no route for ${url.pathname}`);
    }
    return new Response(route.body, {
      status: route.status,
      headers: { "content-type": route.contentType },
    });
  };
}

describe("golden cases: engine over InMemoryTransport", () => {
  for (const gc of goldenCases) {
    it(gc.name, async () => {
      const raw = JSON.parse(await readFile(examplesDir + gc.graphFile, "utf8"));
      const doc = loadGraphDoc(raw, gc.env);
      const server = buildServer(doc, gc.env, {
        httpPolicy: gc.stub ? { fetchImpl: stubFetch(gc.stub) } : {},
      });

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "golden-runner", version: "0.0.1" });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        const result = await client.callTool({ name: gc.tool, arguments: gc.args });
        expect(normalizeResult(result as Parameters<typeof normalizeResult>[0])).toEqual(gc.expected);
      } finally {
        await client.close();
      }
    });
  }

  it("every example file has at least one golden case", async () => {
    // Guards the N3 promise as examples grow: adding an example without a
    // golden breaks CI here, not silently in phase 4.
    const { readdir } = await import("node:fs/promises");
    const files = (await readdir(examplesDir)).filter((f) => f.endsWith(".json"));
    const covered = new Set(goldenCases.map((gc) => gc.graphFile));
    for (const file of files) {
      expect(covered, `examples/${file} has no golden case`).toContain(file);
    }
  });
});
