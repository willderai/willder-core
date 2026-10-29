# Connect Goose to Willder

Block's open-source agent CLI and desktop app.

**Transport:** Streamable HTTP · **Auth:** `Authorization: Bearer <capability token>` ·
**Endpoint:** `https://willder.ai/api/mcp`

**Verified end to end on 2026-10-05**, against `https://willder.ai/api/mcp`. Both of the client matrix's claims hold for this row: the server answered the transport and authentication shape this page configures, and Goose itself connected, listed all ten Willder tools and answered one scoped `memory_query`. Re-run both halves yourself:

```sh
WILLDER_MCP_URL=https://willder.ai/api/mcp WILLDER_TOKEN='<token>' \
  WILLDER_DEPLOYED_COMMIT=<deployed commit> \
  GOOSE_PROVIDER=anthropic GOOSE_MODEL=<a model you can use> \
  npx tsx scripts/mcp-client-probe.ts --client=goose
```

## Get a token

Open **Access → Tokens** in your Willder workspace and issue a capability token for the
narrowest scope that answers your questions. The value is shown once; only its hash is stored.
Keep it in the client's secret storage or an environment variable — never in a committed file,
a prompt or a screenshot.

```sh
export WILLDER_TOKEN='<your capability token>'
```

## Config file

`~/.config/goose/config.yaml`

```yaml
extensions:
  willder:
    name: willder
    type: streamable_http
    uri: https://willder.ai/api/mcp
    headers:
      Authorization: "Bearer <your capability token>"
    enabled: true
    timeout: 300
```

## Verify the connection

```sh
goose session --with-streamable-http-extension "https://willder.ai/api/mcp"
```

then ask for `memory_query`. The flag has no documented header option, so the config file above
is the path that carries the token.

## Notes

Goose's config does not document environment interpolation in `headers`, so the token may have to sit in the file. Protect it with `chmod 600` and prefer a short expiry.

See [the index](README.md) for the other clients and [`mcp/README.md`](../../mcp/README.md) for the tool surface and the token rules.
