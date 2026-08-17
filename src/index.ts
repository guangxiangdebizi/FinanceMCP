#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { getAvailableToolList, dispatchTool } from "./dispatch.js";

const server = new Server(
  { name: "FinanceMCP", version: "4.10.0" },
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
