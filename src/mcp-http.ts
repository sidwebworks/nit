import type { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { VERSION } from "./embedded";

/**
 * nit's own tools (guidelines, a file's diff, fff search) over MCP's streamable HTTP, on nit's
 * local server, for reviewers that run in their own process (Codex). Each run gets a random
 * token: the path names it and the Authorization header repeats it, so only that run can call
 * its tools, and they stop answering when the run ends.
 */
export type NitTools = NonNullable<Parameters<typeof createSdkMcpServer>[0]["tools"]>;

const runs = new Map<string, NitTools>();
let base = "";

/** Where nit serves, once it's listening. */
export const setToolBase = (url: string) => {
  base = url;
};

/** Serves `tools` for one run; `close` takes them down. */
export function openTools(tools: NitTools) {
  const token = crypto.randomUUID().replaceAll("-", "");
  runs.set(token, tools);
  return { url: `${base}/mcp/${token}`, token, close: () => runs.delete(token) };
}

/** One MCP request. Stateless: a fresh server per request, so nothing outlives the run. */
export async function handleTools(req: Request, token: string): Promise<Response> {
  const tools = runs.get(token);
  if (!tools || req.headers.get("authorization") !== `Bearer ${token}`)
    return new Response("not found", { status: 404 });
  const server = new McpServer({ name: "nit", version: VERSION });
  // The Agent SDK's tool() and the MCP server take the same zod shape and handler; only their
  // generics differ.
  const register = server.registerTool.bind(server) as unknown as (
    name: string,
    config: { description?: string; inputSchema?: unknown },
    cb: (args: never, extra: never) => unknown,
  ) => void;
  for (const t of tools) register(t.name, { description: t.description, inputSchema: t.inputSchema }, t.handler);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(req);
}
