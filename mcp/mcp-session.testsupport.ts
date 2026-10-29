// Drive the real hosted MCP endpoint the way one agent works through a task: one MCP
// session per call list, each call's reply flattened to its text. Imported dynamically by
// real-database tests, after they point DATABASE_URL at the test database.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface ToolAnswer {
  isError: boolean;
  answer: string;
}

/** Several tool calls in one MCP session, as `token`. */
export async function mcpSession(
  mcpUrl: string,
  token: string,
  calls: [string, Record<string, unknown>][],
): Promise<ToolAnswer[]> {
  const client = new Client({ name: "willder-test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  try {
    const answers: ToolAnswer[] = [];
    for (const [name, args] of calls) {
      const result = await client.callTool({ name, arguments: args });
      const texts = (result.content as { type: string; text?: string }[]).map((part) => part.text ?? "");
      answers.push({ isError: Boolean(result.isError), answer: texts.join("\n") });
    }
    return answers;
  } finally {
    await client.close();
  }
}
