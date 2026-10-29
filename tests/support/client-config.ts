// The client configuration a test or a study run connects with, taken from the agent CLI's
// committed connect page (docs/connect/<client>.md) rather than written by the harness, so the
// run exercises exactly what a user following that page would paste.
//
// The page's JSON block configures the memory server with `${WILLDER_TOKEN}`; its task
// paragraph gives the `X-Willder-Task` header as `${WILLDER_TASK:-}`. The harness fills both
// as the user's shell would, and points the URL's path at the deployment under test.
//
// The one rule this file enforces: the page decides the configuration. A page with no JSON
// block for the memory server is refused, and a page that does not name the task header is
// recorded as not naming it, so the run's report never says the committed page carried it.

/** The name the connect pages give the memory server in a client's MCP configuration. */
export const MEMORY_SERVER = "willder";

export const TASK_HEADER = "X-Willder-Task";

/** The memory server's entry as the page configures it, and the page's task header value. */
export interface ClientConfigPage {
  path: string;
  server: { type: string; url: string; headers: Record<string, string> };
  /** The value the page gives the task header, e.g. `${WILLDER_TASK:-}`; null when the page never names the header. */
  taskHeader: string | null;
}

/** Read the page's JSON block for the memory server. Throws naming the page when it has none. */
export function readClientConfigPage(path: string, markdown: string): ClientConfigPage {
  for (const block of markdown.matchAll(/```json\n([\s\S]*?)```/g)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block[1]!);
    } catch {
      continue;
    }
    const entry = (parsed as { mcpServers?: Record<string, { type?: unknown; url?: unknown; headers?: unknown }> })
      .mcpServers?.[MEMORY_SERVER];
    if (!entry || typeof entry.type !== "string" || typeof entry.url !== "string") continue;
    const headers = Object.fromEntries(
      Object.entries((entry.headers ?? {}) as Record<string, unknown>).filter(
        (h): h is [string, string] => typeof h[1] === "string",
      ),
    );
    const taskHeader =
      headers[TASK_HEADER] ?? markdown.match(new RegExp(`"${TASK_HEADER}":\\s*"([^"]*)"`))?.[1] ?? null;
    return { path, server: { type: entry.type, url: entry.url, headers }, taskHeader };
  }
  throw new Error(
    `${path} has no JSON block configuring the "${MEMORY_SERVER}" server; set CLIENT_CONFIG_PAGE to the agent CLI's page under docs/connect/`,
  );
}

/** Replace each `${NAME}` or `${NAME:-default}` with its value, as a shell would; an unknown name is an error. */
function expand(value: string, vars: Readonly<Record<string, string>>): string {
  return value.replace(/\$\{(\w+)(?::-[^}]*)?\}/g, (_, name: string) => {
    const v = vars[name];
    if (v === undefined)
      throw new Error(
        `the client configuration uses \${${name}}, which this harness does not set; it sets ${Object.keys(vars).join(" and ")}`,
      );
    return v;
  });
}

/**
 * The memory server's entry for one run: the page's own entry with the token and task filled
 * in, the task header added as the page says (or as `${WILLDER_TASK}` when the page does not
 * name it), and the URL's path served from `baseUrl`.
 */
export function fillClientConfig(
  page: ClientConfigPage,
  input: { baseUrl: string; token: string; taskKey: string },
): { type: string; url: string; headers: Record<string, string> } {
  const vars = { WILLDER_TOKEN: input.token, WILLDER_TASK: input.taskKey };
  const headers = Object.fromEntries(
    Object.entries({ ...page.server.headers, [TASK_HEADER]: page.taskHeader ?? "${WILLDER_TASK}" }).map(([k, v]) => [
      k,
      expand(v, vars),
    ]),
  );
  return { type: page.server.type, url: `${input.baseUrl}${new URL(page.server.url).pathname}`, headers };
}
