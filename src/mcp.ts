/**
 * commitcheck MCP server. Tool: check_commits.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runCheck, VERSION } from "./core.js";

const server = new McpServer({ name: "commitcheck", version: VERSION });

server.tool(
  "check_commits",
  "Check the commits in a git repo (most recent 50 by default): subject lines over 72 chars, missing DCO Signed-off-by trailers, messages that break the repo's dominant convention (detected from the history itself), and placeholder subjects. Returns per-commit findings and a CLEAN or FINDINGS verdict.",
  {
    path: z.string().describe("Target path to check"),
  },
  async ({ path }) => {
    const report = runCheck(path);
    return { content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }] };
  },
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

void main();
