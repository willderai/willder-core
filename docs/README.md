# Willder documentation

One line per document, grouped by what you are trying to do. Every file under `docs/`
appears here exactly once, except the per-client pages under `connect/`, which the connect index lists. Running Willder yourself lives in
[development.md](development.md): the
[ten-minute path](development.md#ten-minute-path-a-local-mcp-server) for an MCP server alone,
the [full path](development.md#full-path-the-web-app-with-memory) for the web app with memory.

## Start here

- [README](../README.md) — what Willder is, how to run it on your machine, how to check it does not leak, what was measured on the hosted service, and the limits.
- [quickstart.md](quickstart.md) — the long quickstart: one person, three agents, every expected output and every failure.
- [development.md](development.md) — running Willder on your own machine: stack, both setup paths, key scripts, architecture, access control and MCP in brief.
- [CONTRIBUTING.md](../CONTRIBUTING.md) — how to run the checks, the bar a change has to meet, what a pull request needs, and where decisions are recorded.
- [SECURITY.md](../SECURITY.md) — how to report a vulnerability privately, and what is in scope.
- [LICENSE](../LICENSE) — MIT.
- [environment.md](environment.md) — every environment variable the code reads, classified boot / feature / dev, with the file that reads it.

## Concepts

- [architecture.md](architecture.md) — the architecture in one page: components, the single access check, hybrid retrieval, versions and conflicts, deletion and erasure, change notices, audit, self-host topology, measured performance and limits, with diagrams and charts.
- [willder_memory_hybrid.md](willder_memory_hybrid.md) — the hybrid memory store: Graphiti on Neo4j for the graph, pgvector for semantic chunks, one guarded interface.
- [consent-deletion-suite.md](consent-deletion-suite.md) — what the consent and deletion suite proves: data served only while connected, erasable per person, gone after disconnect.
- [export-format.md](export-format.md) — the export file: what a full or scoped export holds, every record type, and how an import into a fresh org checks and loads it.
- [willder_conflict_resolution.md](willder_conflict_resolution.md) — how conflicting context is resolved: the agent-context precedence rule and the fact-dispute flow, both implemented.

## Connect a client

- [mcp/README.md](../mcp/README.md) — hosted MCP over Streamable HTTP with a bearer capability token, and the local stdio server for development.
- [connect/README.md](connect/README.md) — the per-client setup pages, one for each of the 21 clients, with the shared endpoint, the verification status table and a link to every page.
- [development.md, MCP section](development.md#mcp-use-willder-from-your-ai) — the tool names, the change-feed hook for Claude Code, and the key env vars.
- [willder_api.md](willder_api.md) — the API route reference, checked against the handlers on 2026-09-29; names the routes retained from the earlier outbound product.

## Operate

- [deploy-checklist.md](deploy-checklist.md) — taking Willder from local development to a live Vercel deployment, section by section.

## Reference

- [willder_database.md](willder_database.md) — the prose companion to `prisma/schema.prisma`, cited from the schema itself; four stale sections are flagged inline.
- [willder_architecture.html](willder_architecture.html), [willder_api_diagram.html](willder_api_diagram.html), [willder_erd.html](willder_erd.html) — June 2026 diagrams of the architecture, API and data model; the Prisma schema is the current source of truth.

