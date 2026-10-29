# Connect Vercel AI SDK to Willder

A TypeScript toolkit for model and tool calling.

**Transport:** Streamable HTTP · **Auth:** `Authorization: Bearer <capability token>` ·
**Endpoint:** `https://willder.ai/api/mcp`

**Steps to connect: two, not one.** One `npm install`, then the code under [Config file](#config-file). An SDK has no settings screen to paste into: the connection is code in your own program.

**Verified end to end on 2026-10-05**, against `https://willder.ai/api/mcp`. Both of the client matrix's claims hold for this row: the server answered the transport and authentication shape this page configures, and the Vercel AI SDK itself connected, listed all ten Willder tools and answered one scoped `memory_query`. Re-run both halves yourself:

```sh
WILLDER_MCP_URL=https://willder.ai/api/mcp WILLDER_TOKEN='<token>' \
  WILLDER_DEPLOYED_COMMIT=<deployed commit> \
  npx tsx scripts/mcp-client-probe.ts --client=vercel-ai-sdk
```

The probe is `scripts/mcp-client-probe.ts`; see [the index](README.md) for what every other row says.

## Get a token

Open **Access → Tokens** in your Willder workspace and issue a capability token for the
narrowest scope that answers your questions. The value is shown once; only its hash is stored.
Keep it in the client's secret storage or an environment variable — never in a committed file,
a prompt or a screenshot.

```sh
export WILLDER_TOKEN='<your capability token>'
```

## Config file

Your own code — no config file.

```ts
import { experimental_createMCPClient as createMCPClient } from "ai";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = await createMCPClient({
  transport: new StreamableHTTPClientTransport(new URL("https://willder.ai/api/mcp"), {
    requestInit: { headers: { Authorization: `Bearer ${process.env.WILLDER_TOKEN}` } },
  }),
});
const tools = await client.tools();
```

The SDK's own `transport: { type: ... }` shorthand only builds the deprecated SSE transport —
`type: "http"` throws `Unsupported or invalid transport configuration`. Streamable HTTP needs
the MCP SDK's transport object, as above. Install it alongside `ai`:

```sh
npm install ai @modelcontextprotocol/sdk
```

## Verify the connection

`Object.keys(tools)` includes `memory_query`. Pass `tools` to `generateText` and ask a scoped question.

See [the index](README.md) for the other clients and [`mcp/README.md`](../../mcp/README.md) for the tool surface and the token rules.
