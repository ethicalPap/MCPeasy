import { envRefsIn } from "./template.js";
import type { GraphDoc, GraphNode, LintProblem, LintReport, ToolNode } from "./types.js";

// Rule ids are part of the public surface (editor badges key off them), so
// active rules keep stable names even as noisy authoring checks are retired.

// MCP 2025-11-25 permits ASCII letters, digits, underscore, hyphen and dot;
// validation already enforces the protocol's 1–128 character recommendation.
const TOOL_NAME_RE = /^[A-Za-z0-9_.-]+$/;
// Prefix lists are intentionally short and obvious; a fancier NLP heuristic
// would produce warnings users can't predict, and unpredictable lint teaches
// users to ignore lint (review note #5 on the design doc).
const READ_PREFIXES = ["get_", "list_", "search_", "read_", "fetch_"];
const WRITE_PREFIXES = ["create_", "delete_", "update_", "set_", "add_", "remove_"];

function add(report: LintReport, nodeId: string, problem: LintProblem): void {
  (report[nodeId] ??= []).push(problem);
}

/** Every template carried by an exec node, for env-reference scanning. */
function templatesOf(node: GraphNode): string[] {
  switch (node.kind) {
    case "action":
      return [
        node.http.url,
        ...(node.http.body !== undefined ? [node.http.body] : []),
        ...Object.values(node.http.headers ?? {}),
      ];
    case "command":
      return [...node.command.args, ...(node.command.stdin !== undefined ? [node.command.stdin] : [])];
    case "script":
      return [...node.script.args, ...(node.script.stdin !== undefined ? [node.script.stdin] : [])];
    case "transform":
      return node.template !== undefined ? [node.template] : [];
    case "return":
      return node.template !== undefined ? [node.template] : [];
    default:
      return [];
  }
}

function lintTool(toolId: string, tool: ToolNode, report: LintReport): void {
  // Rule 1: keep names inside the protocol's portable character set so the
  // visual form and tools/list response accept exactly the same identifiers.
  if (!TOOL_NAME_RE.test(tool.name)) {
    add(report, toolId, {
      rule: "tool-name-pattern",
      severity: "error",
      message: `tool name "${tool.name}" may use only letters, digits, underscore, hyphen, and dot`,
    });
  }

  // Rule 3: input field without type (error). Zod validation already forces
  // this for docs that came through validateGraphDoc, but lint also runs on
  // editor drafts built programmatically — check defensively.
  for (const input of tool.inputs) {
    if (!input.type) {
      add(report, toolId, {
        rule: "input-missing-type",
        severity: "error",
        message: `input "${input.name}" has no type`,
      });
    }
  }

  const description = tool.description.trim();
  if (description.length >= 20 && !/\b(use|when)\b/i.test(description)) {
    // Short descriptions are valid while a tool is being sketched. Once the
    // author supplies detail, this predictable heuristic can offer useful
    // guidance without imposing an arbitrary minimum length.
    add(report, toolId, {
      rule: "description-no-usage-hint",
      severity: "warning",
      message: `description should say when to use this tool (mention "use ... when ...")`,
    });
  }

  // Rules 7 & 8: name/annotation mismatches (warnings).
  if (READ_PREFIXES.some((p) => tool.name.startsWith(p)) && !tool.annotations.readOnly) {
    add(report, toolId, {
      rule: "read-name-not-readonly",
      severity: "warning",
      message: `name suggests a read but readOnly is false`,
    });
  }
  if (WRITE_PREFIXES.some((p) => tool.name.startsWith(p)) && tool.annotations.destructive === undefined) {
    add(report, toolId, {
      rule: "write-name-destructive-unset",
      severity: "warning",
      message: `name suggests a write but destructive is not set either way`,
    });
  }

  // Rule 9: too many required inputs (warning) — models fumble wide forms.
  const requiredCount = tool.inputs.filter((i) => i.required !== false).length;
  if (requiredCount > 8) {
    add(report, toolId, {
      rule: "too-many-required-inputs",
      severity: "warning",
      message: `${requiredCount} required inputs; models handle 8 or fewer far better`,
    });
  }
}

export function lintGraphDoc(doc: GraphDoc): LintReport {
  const report: LintReport = {};

  // Rule 2: duplicate tool names (error) — flagged on EVERY holder so each
  // offending node gets a badge, not just the second one.
  const byName = new Map<string, string[]>();
  for (const [id, node] of Object.entries(doc.nodes)) {
    if (node.kind !== "tool") continue;
    const holders = byName.get(node.name);
    if (holders) holders.push(id);
    else byName.set(node.name, [id]);
  }
  for (const [name, ids] of byName) {
    if (ids.length > 1) {
      for (const id of ids) {
        add(report, id, {
          rule: "duplicate-tool-name",
          severity: "error",
          message: `tool name "${name}" is used by ${ids.length} tools`,
        });
      }
    }
  }

  for (const [id, node] of Object.entries(doc.nodes)) {
    if (node.kind === "tool") lintTool(id, node, report);
  }

  // Rule 10: template references an undeclared env var (error), attached to
  // the node holding the template so the badge lands where the fix goes.
  const declared = new Set(doc.server.env);
  for (const [id, node] of Object.entries(doc.nodes)) {
    for (const template of templatesOf(node)) {
      for (const name of envRefsIn(template)) {
        if (!declared.has(name)) {
          add(report, id, {
            rule: "undeclared-env-var",
            severity: "error",
            message: `template references {{env.${name}}} but "${name}" is not declared in server.env`,
          });
        }
      }
    }
  }

  return report;
}

export function lintErrorCount(report: LintReport): number {
  return Object.values(report).flat().filter((p) => p.severity === "error").length;
}
