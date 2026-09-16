// One golden case = one example graph + one recorded tool call + the expected
// NORMALIZED result. Phase 4 replays these same cases against exported
// FastMCP/TS servers; the expectations below are the contract both must hit.
//
// HTTP-dependent cases carry a `stub` so goldens run hermetically — the
// upstream is faked at the fetch boundary, never at the engine boundary,
// so the full action pipeline (templating, caps, error mapping) is on trial.

import type { GoldenResult } from "./normalize.js";

export interface GoldenCase {
  name: string;
  graphFile: string;
  env: Record<string, string>;
  tool: string;
  args: Record<string, unknown>;
  /** Routes matched by URL suffix; a miss means the test setup is wrong. */
  stub?: Record<string, { status: number; contentType: string; body: string }>;
  expected: GoldenResult;
}

export const goldenCases: GoldenCase[] = [
  {
    name: "echo round trip",
    graphFile: "echo.json",
    env: {},
    tool: "echo_message",
    args: { message: "hello golden" },
    expected: {
      isError: false,
      content: [{ type: "text", text: "echo: hello golden" }],
    },
  },
  {
    name: "http get with pick",
    graphFile: "http-get.json",
    env: { BASE_URL: "https://stub.example" },
    tool: "get_todo",
    args: { id: "1" },
    stub: {
      "/todos/1": {
        status: 200,
        contentType: "application/json",
        // Extra field "userId" proves pick actually drops it.
        body: '{"userId":9,"id":1,"title":"buy milk","completed":false}',
      },
    },
    expected: {
      isError: false,
      content: [{ type: "text", text: '{"completed":false,"id":1,"title":"buy milk"}' }],
      structuredContent: { completed: false, id: 1, title: "buy milk" },
    },
  },
  {
    name: "upstream 404 becomes status-only tool error",
    graphFile: "error-path.json",
    env: { BASE_URL: "https://stub.example" },
    tool: "get_missing_resource",
    args: {},
    stub: {
      "/definitely-not-a-real-path-404": {
        status: 404,
        contentType: "text/html",
        body: "<html>secret internal error page</html>",
      },
    },
    expected: {
      isError: true,
      content: [{ type: "text", text: "upstream returned HTTP 404" }],
    },
  },
];
