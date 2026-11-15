import { afterAll, expect, test } from "bun:test";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { handleTools, openTools, setToolBase } from "./mcp-http";

const server = Bun.serve({
  port: 0,
  routes: { "/mcp/:token": (req) => handleTools(req, req.params.token) },
});
setToolBase(`http://127.0.0.1:${server.port}`);
afterAll(() => server.stop(true));

const echo = tool("echo", "Says it back.", { text: z.string() }, async ({ text }) => ({
  content: [{ type: "text" as const, text: `you said ${text}` }],
}));

const connect = async (url: string, token: string) => {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  );
  return client;
};

test("a run's tools are listed and callable over MCP, with its token", async () => {
  const run = openTools([echo]);
  const client = await connect(run.url, run.token);
  expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["echo"]);
  const r = await client.callTool({ name: "echo", arguments: { text: "hi" } });
  expect(r.content).toEqual([{ type: "text", text: "you said hi" }]);
  await client.close();
  run.close();
});

test("a wrong token, or a closed run, gets nothing", async () => {
  const run = openTools([echo]);
  await expect(connect(run.url, "not-the-token")).rejects.toThrow();
  run.close();
  await expect(connect(run.url, run.token)).rejects.toThrow();
});
