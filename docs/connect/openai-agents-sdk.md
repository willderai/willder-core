# Connect OpenAI Agents SDK to Willder

OpenAI's Python agent framework.

**Transport:** Streamable HTTP · **Auth:** `Authorization: Bearer <capability token>` ·
**Endpoint:** `https://willder.ai/api/mcp`

**Verified end to end on 2026-10-05**, against `https://willder.ai/api/mcp`. Both of the client matrix's claims hold for this row: the server answered the transport and authentication shape this page configures, and the OpenAI Agents SDK itself connected, listed all ten Willder tools and answered one scoped `memory_query`. Re-run both halves yourself:

```sh
WILLDER_MCP_URL=https://willder.ai/api/mcp WILLDER_TOKEN='<token>' WILLDER_PYTHON=.venv/bin/python \
  WILLDER_DEPLOYED_COMMIT=<deployed commit> \
  npx tsx scripts/mcp-client-probe.ts --client=openai-agents-sdk
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

```python
import os
from agents.mcp import MCPServerStreamableHttp

server = MCPServerStreamableHttp(params={
    "url": "https://willder.ai/api/mcp",
    "headers": {"Authorization": f"Bearer {os.environ['WILLDER_TOKEN']}"},
})
async with server:
    tools = await server.list_tools()
```

## Verify the connection

`list_tools()` returns the Willder tools; then run one `memory_query` through an agent.

See [the index](README.md) for the other clients and [`mcp/README.md`](../../mcp/README.md) for the tool surface and the token rules.
