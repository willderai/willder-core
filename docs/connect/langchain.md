# Connect LangChain / LangGraph to Willder

A Python agent framework; `langchain-mcp-adapters` turns MCP tools into LangChain tools.

**Transport:** Streamable HTTP · **Auth:** `Authorization: Bearer <capability token>` ·
**Endpoint:** `https://willder.ai/api/mcp`

**Verified end to end on 2026-10-05**, against `https://willder.ai/api/mcp`. Both of the client matrix's claims hold for this row: the server answered the transport and authentication shape this page configures, and LangChain itself connected, listed all ten Willder tools and answered one scoped `memory_query`. Re-run both halves yourself:

```sh
WILLDER_MCP_URL=https://willder.ai/api/mcp WILLDER_TOKEN='<token>' WILLDER_PYTHON=.venv/bin/python \
  WILLDER_DEPLOYED_COMMIT=<deployed commit> \
  npx tsx scripts/mcp-client-probe.ts --client=langchain
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
from langchain_mcp_adapters.client import MultiServerMCPClient

client = MultiServerMCPClient({
    "willder": {
        "transport": "http",
        "url": "https://willder.ai/api/mcp",
        "headers": {"Authorization": f"Bearer {os.environ['WILLDER_TOKEN']}"},
    }
})
tools = await client.get_tools()
```

## Verify the connection

`[t.name for t in tools]` includes `memory_query`, `memory_entity` and `memory_ingest`.

See [the index](README.md) for the other clients and [`mcp/README.md`](../../mcp/README.md) for the tool surface and the token rules.
