#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";
import { Command } from "commander";
import { buildServer, loadGraphDoc, serveStdio, serveHttp, DEFAULT_HTTP_PORT, BuildError } from "@mcpeasy/engine";
import { lintGraphDoc, migrateGraphDoc, validateGraphDoc, lintErrorCount } from "@mcpeasy/schema";

// INVARIANT (see engine/src/stdio.ts): in `dev`, stdout belongs exclusively
// to the MCP transport. Every human-facing message in this file goes through
// log(), which writes stderr — adding a console.log here breaks Claude
// Desktop in a way that looks like a hang, not an error.
function log(message: string): void {
  process.stderr.write(message + "\n");
}

async function readDoc(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    log(`error: cannot read ${file}`);
    process.exit(1);
  }
  try {
    return JSON.parse(text);
  } catch {
    log(`error: ${file} is not valid JSON`);
    process.exit(1);
  }
}

/** Collect the env values a doc declares from process.env, failing on gaps. */
function envFor(names: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

const program = new Command();
program.name("mcpeasy").description("Run and lint mcpeasy graph docs").version("0.1.0");

program
  .command("dev")
  .description("serve a graph doc as an MCP server over stdio (for Claude Desktop, Inspector)")
  .argument("<graph>", "path to graph doc JSON")
  .option("--allow-local-execution", "allow trusted command, script, and inline-code nodes")
  .option("--port <port>", `port for an http-transport graph (default ${DEFAULT_HTTP_PORT})`)
  .option("--host <host>", "interface to bind for an http-transport graph (default 127.0.0.1)")
  .action(async (graph: string, options: { allowLocalExecution?: boolean; port?: string; host?: string }) => {
    const raw = await readDoc(graph);
    try {
      // Peek at declared env names before full load so the error names the
      // exact missing vars rather than a generic validation failure.
      const migrated = migrateGraphDoc(raw);
      const peek = validateGraphDoc(migrated);
      const names = peek.ok ? peek.doc.server.env : [];
      const doc = loadGraphDoc(raw, envFor(names));
      const server = buildServer(doc, envFor(doc.server.env), {
        localExecutionPolicy: { enabled: options.allowLocalExecution === true },
      });
      if (doc.server.execution?.allowLocal === true && options.allowLocalExecution !== true) {
        log("mcpeasy: local execution is declared but disabled; restart with --allow-local-execution after reviewing the graph");
      }

      // The doc chooses the transport; flags only tune the http case. A graph
      // authored for http served over stdio (or the reverse) would be a silent
      // mismatch between what the user configured and what actually runs.
      if (doc.server.transport === "http") {
        // The token comes from the environment, never a flag: argv is visible
        // to any process that can list processes, and a bearer token in a
        // shell history file is the same class of leak this project refuses
        // elsewhere (requirement N5).
        const bearerToken = process.env.MCPEASY_BEARER_TOKEN;
        if (doc.server.auth.type === "bearer" && bearerToken === undefined) {
          log("error: this graph requires bearer auth; set MCPEASY_BEARER_TOKEN before starting it");
          process.exit(1);
        }
        const port = options.port === undefined ? undefined : Number(options.port);
        if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
          log(`error: --port must be an integer between 0 and 65535`);
          process.exit(1);
        }
        const handle = await serveHttp(server, {
          port,
          host: options.host,
          bearerToken: doc.server.auth.type === "bearer" ? bearerToken : undefined,
        });
        log(`mcpeasy: serving "${doc.server.name}" at ${handle.url} (ctrl-c to stop)`);
        if (handle.host !== "127.0.0.1" && handle.host !== "localhost") {
          // Binding beyond loopback exposes every tool in the graph to the
          // network, so it is stated plainly rather than left to be discovered.
          log(`mcpeasy: WARNING bound to ${handle.host}; this server is reachable from other machines`);
        }
        // serveHttp resolves once listening, so the process would exit here
        // without something to hold it open. Ctrl-C is the documented stop.
        await new Promise<void>(() => {});
        return;
      }

      log(`mcpeasy: serving "${doc.server.name}" over stdio (ctrl-c to stop)`);
      await serveStdio(server);
    } catch (cause) {
      log(cause instanceof BuildError ? `error: ${cause.message}` : `error: failed to start server`);
      process.exit(1);
    }
  });

program
  .command("lint")
  .description("validate and lint a graph doc; exit 1 on errors")
  .argument("<graph>", "path to graph doc JSON")
  .action(async (graph: string) => {
    const raw = await readDoc(graph);
    let migrated: unknown;
    try {
      migrated = migrateGraphDoc(raw);
    } catch (cause) {
      log(`error: ${cause instanceof Error ? cause.message : "migration failed"}`);
      process.exit(1);
    }
    const result = validateGraphDoc(migrated);
    if (!result.ok) {
      log(`invalid graph doc:`);
      for (const issue of result.issues) log(`  ${issue.path}: ${issue.message}`);
      process.exit(1);
    }
    const report = lintGraphDoc(result.doc);
    const entries = Object.entries(report);
    if (entries.length === 0) {
      log("lint: clean");
      return;
    }
    for (const [nodeId, problems] of entries) {
      for (const p of problems) log(`${p.severity === "error" ? "ERROR" : "warn "} ${nodeId} [${p.rule}] ${p.message}`);
    }
    if (lintErrorCount(report) > 0) process.exit(1);
  });

program.parseAsync().catch((cause) => {
  log(`error: ${cause instanceof Error ? cause.message : String(cause)}`);
  process.exit(1);
});
