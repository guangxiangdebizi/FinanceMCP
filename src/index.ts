#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { SERVER_VERSION } from "./version.js";

async function main() {
  // STDIO reserves stdout for JSON-RPC frames; application logs belong on stderr.
  console.log = (...args: unknown[]) => console.error(...args);
  const { getAvailableToolList, dispatchTool } = await import("./dispatch.js");

  const buildServer = () => {
    const server = new Server(
      { name: "FinanceMCP", version: SERVER_VERSION },
      { capabilities: { tools: {} } }
    );

    server.setRequestHandler("tools/list", async () => {
      return { tools: getAvailableToolList() };
    });

    server.setRequestHandler("tools/call", async (request) => {
      return await dispatchTool(
        request.params.name,
        (request.params.arguments as Record<string, any>) || {}
      );
    });

    return server;
  };

  serveStdio(buildServer);
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
