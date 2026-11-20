// 動作確認用の stdio MCP サーバー (現在時刻を返すツールを 1 つ公開する)。
// 使い方: node examples/time-mcp/server.mjs  (mcp.json から起動される)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "time", version: "1.0.0" });

server.registerTool(
  "get_current_time",
  {
    description: "指定したタイムゾーンの現在時刻を返す",
    inputSchema: { timezone: z.string().describe("IANA タイムゾーン名 (例: Asia/Tokyo)") },
  },
  async ({ timezone }) => {
    const now = new Date().toLocaleString("ja-JP", { timeZone: timezone });
    return { content: [{ type: "text", text: `${timezone} の現在時刻は ${now} です` }] };
  },
);

await server.connect(new StdioServerTransport());
