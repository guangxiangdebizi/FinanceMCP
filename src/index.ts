#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { SERVER_VERSION } from "./version.js";

async function main() {
  // STDIO reserves stdout for JSON-RPC frames; application logs belong on stderr.
  console.log = (...args: unknown[]) => console.error(...args);
  const { getAvailableToolList, dispatchTool } = await import("./dispatch.js");

  const server = new Server(
    { name: "FinanceMCP", version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: getAvailableToolList() };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return await dispatchTool(
      request.params.name,
      (request.params.arguments as Record<string, any>) || {}
    );
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
