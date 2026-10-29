// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The whole OAuth flow a remote MCP client such as claude.ai or ChatGPT runs against
// Willder's own authorization server, through the real route handlers and page:
// register, authorize, consent, exchange the code with PKCE, call /api/mcp, refresh.
// The token runs as the capability the person chose, so check() decides every call and
// writes every audit row; revoking, reconnecting or expiring ends it on the next call.
//
// Two orgs. In org A a team lead administers Sales (not Engineering, not the root) and
// a member only reads Sales; in org B an admin administers the root. Only the Clerk
// session (requireAccessContext) and Next's request plumbing are faked. Not simulated:
// a real browser, Clerk's sign-in page, and claude.ai's or ChatGPT's own client code.
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;

const ORIGIN = "https://willder.test";
const MCP_URL = `${ORIGIN}/api/mcp`;
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const CHATGPT_CALLBACK = "https://chatgpt.com/connector_platform_oauth_redirect";
const CHALLENGE_PREFIX = `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/mcp"`;

const ORG_A = "org-oauth-flow-a";
const ORG_B = "org-oauth-flow-b";
const ROOT_A = "org_oauth_flow_a";
const ROOT_B = "org_oauth_flow_b";
const SALES = `${ROOT_A}.sales`;
const ENG = `${ROOT_A}.eng`;

const LEAD = "u-oauth-flow-lead";
const MEMBER = "u-oauth-flow-member";
const ADMIN_B = "u-oauth-flow-admin-b";

type Person = { id: string; orgId: string; role: "admin" | "member" };
const people: Record<string, Person> = {
  [LEAD]: { id: LEAD, orgId: ORG_A, role: "member" },
  [MEMBER]: { id: MEMBER, orgId: ORG_A, role: "member" },
  [ADMIN_B]: { id: ADMIN_B, orgId: ORG_B, role: "admin" },
};

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "willder.test", "x-forwarded-proto": "https" }),
}));
vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ href, children }: { href: string; children: ReactNode }) => createElement("a", { href }, children),
  };
});
vi.mock("@clerk/nextjs", () => ({ OrganizationSwitcher: () => null }));
const clerkSession = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@clerk/nextjs/server", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  auth: async () => ({ userId: clerkSession.userId }),
}));
vi.mock("@/components/auth/auth-shell", async () => {
  const { createElement } = await import("react");
  return {
    AuthShell: ({ title, description, children }: { title: string; description: string; children: ReactNode }) =>
      createElement("main", null, createElement("h1", null, title), createElement("p", null, description), children),
  };
});

const TOOLS_LIST = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}';
const toolCall = (name: string, args: Record<string, unknown>) =>
  JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
const readChanges = (scopePath: string) => toolCall("memory_changes", { scopePath });
const postNote = (scopePath: string) =>
  toolCall("memory_note", { kind: "status", task: "oauth flow", body: "Working on the Q4 forecast.", scopePath });

function pkce() {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

describe.skipIf(!QA_URL)("OAuth for remote MCP clients, end to end against a real database", () => {
  let db: PrismaClient;
  let registerPOST: (typeof import("./register/route"))["POST"];
  let tokenPOST: (typeof import("./token/route"))["POST"];
  let decidePOST: (typeof import("./authorize/route"))["POST"];
  let mcpPOST: (typeof import("../mcp/route"))["POST"];
  let disconnectDELETE: (typeof import("../access/oauth-connections/[id]/route"))["DELETE"];
  let AuthorizePage: (typeof import("@/app/(auth)/oauth/authorize/page"))["default"];
  let requireAccessContext: ReturnType<typeof vi.fn>;
  const clientIds: string[] = [];

  function signInAs(userId: string | null) {
    clerkSession.userId = userId && `clerk_${userId}`;
    if (!userId) return requireAccessContext.mockResolvedValue(null);
    const person = people[userId];
    requireAccessContext.mockResolvedValue({
      org: { id: person.orgId, name: person.orgId, clerkOrgId: `clerk_${person.orgId}` },
      user: { id: person.id },
      ctx: { orgId: person.orgId, actor: { type: "human", id: person.id, role: person.role }, origin: "app" },
    });
  }

  async function register(body: unknown) {
    const res = await registerPOST(
      new Request(`${ORIGIN}/api/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (res.status === 201) clientIds.push(json.client_id);
    return { status: res.status, body: json };
  }

  async function registerClient(redirectUris = [CLAUDE_CALLBACK], name = "Claude") {
    const { body } = await register({
      client_name: name,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
    });
    return body.client_id as string;
  }

  function authorizeParams(clientId: string, challenge: string, extra: Record<string, string> = {}) {
    return {
      response_type: "code",
      client_id: clientId,
      redirect_uri: CLAUDE_CALLBACK,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "st_7f3a",
      resource: MCP_URL,
      scope: "memory:read memory:write",
      ...extra,
    };
  }

  /** The authorize page as HTML, or the URL it redirected to. */
  async function openPage(query: Record<string, string>): Promise<{ html?: string; redirectedTo?: string }> {
    try {
      return { html: renderToStaticMarkup(await AuthorizePage({ searchParams: Promise.resolve(query) })) };
    } catch (error) {
      const match = /^NEXT_REDIRECT (.+)$/.exec((error as Error).message);
      if (match) return { redirectedTo: match[1] };
      throw error;
    }
  }

  function decide(fields: Record<string, string>, origin: string | null = ORIGIN) {
    return decidePOST(
      new Request(`${ORIGIN}/api/oauth/authorize`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", ...(origin ? { origin } : {}) },
        body: new URLSearchParams(fields).toString(),
      }),
    );
  }

  async function token(fields: Record<string, string>) {
    const res = await tokenPOST(
      new Request(`${ORIGIN}/api/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields).toString(),
      }),
    );
    return { status: res.status, headers: res.headers, body: await res.json() };
  }

  function mcp(bearer: string, body = TOOLS_LIST) {
    return mcpPOST(
      new Request(MCP_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${bearer}`,
        },
        body,
      }),
    );
  }

  async function toolResult(res: Response): Promise<{ text: string; isError: boolean }> {
    expect(res.status).toBe(200);
    const { result } = await res.json();
    return { text: result.content.map((c: { text: string }) => c.text).join("\n"), isError: result.isError === true };
  }

  /** Consent as `userId` and return the code from the redirect, with the redirect itself. */
  async function consent(
    userId: string,
    clientId: string,
    challenge: string,
    choice: { scopePath: string; permission: string },
    extra: Record<string, string> = {},
  ) {
    signInAs(userId);
    const res = await decide({
      ...authorizeParams(clientId, challenge, extra),
      willder_decision: "allow",
      willder_scope_path: choice.scopePath,
      willder_permission: choice.permission,
    });
    const location = new URL(res.headers.get("location") ?? "", ORIGIN);
    return { res, location, code: location.searchParams.get("code") };
  }

  /** The full flow: register, consent, exchange. */
  async function connect(
    userId: string,
    choice: { scopePath: string; permission: string },
    extra: Record<string, string> = {},
  ) {
    const clientId = await registerClient();
    const { verifier, challenge } = pkce();
    const { code } = await consent(userId, clientId, challenge, choice, extra);
    const exchanged = await token({
      grant_type: "authorization_code",
      code: code ?? "",
      client_id: clientId,
      redirect_uri: CLAUDE_CALLBACK,
      code_verifier: verifier,
      resource: extra.resource ?? MCP_URL,
    });
    expect(exchanged.status, JSON.stringify(exchanged.body)).toBe(200);
    return {
      clientId,
      access: exchanged.body.access_token as string,
      refresh: exchanged.body.refresh_token as string,
      body: exchanged.body,
    };
  }

  const audit = (orgId: string, action: string) => db.auditLog.findMany({ where: { orgId, action } });

  async function wipe() {
    for (const orgId of [ORG_A, ORG_B]) {
      await db.oAuthConnection.deleteMany({ where: { orgId } });
      await db.auditLog.deleteMany({ where: { orgId } });
      await db.changeEvent.deleteMany({ where: { orgId } });
      await db.agentCursor.deleteMany({ where: { orgId } });
      await db.taskStartDelivery.deleteMany({ where: { orgId } });
      await db.workingNote.deleteMany({ where: { orgId } });
      await db.sessionScopeRead.deleteMany({ where: { orgId } });
      await db.agent.deleteMany({ where: { orgId } });
      await db.capability.deleteMany({ where: { orgId } });
      await db.grant.deleteMany({ where: { orgId } });
      await db.scope.deleteMany({ where: { orgId } });
      await db.user.deleteMany({ where: { orgId } });
      await db.org.deleteMany({ where: { id: orgId } });
    }
    await db.oAuthClient.deleteMany({ where: { id: { in: clientIds.splice(0) } } });
  }

  async function seed() {
    for (const [orgId, root] of [
      [ORG_A, ROOT_A],
      [ORG_B, ROOT_B],
    ]) {
      await db.org.create({ data: { id: orgId, name: orgId, clerkOrgId: `clerk_${orgId}` } });
      const scope = await db.scope.create({ data: { orgId, path: root, name: "Organization" } });
      await db.grant.create({
        data: { orgId, scopeId: scope.id, granteeType: "role", granteeId: "admin", permission: "admin" },
      });
    }
    const sales = await db.scope.create({ data: { orgId: ORG_A, path: SALES, name: "Sales" } });
    await db.scope.create({ data: { orgId: ORG_A, path: ENG, name: "Engineering" } });
    for (const person of Object.values(people)) {
      await db.user.create({
        data: {
          id: person.id,
          orgId: person.orgId,
          role: person.role,
          email: `${person.id}@oauth-flow.test`,
          clerkId: `clerk_${person.id}`,
        },
      });
    }
    await db.grant.createMany({
      data: [
        { orgId: ORG_A, scopeId: sales.id, granteeType: "user", granteeId: LEAD, permission: "admin" },
        { orgId: ORG_A, scopeId: sales.id, granteeType: "user", granteeId: MEMBER, permission: "read" },
      ],
    });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ POST: registerPOST } = await import("./register/route"));
    ({ POST: tokenPOST } = await import("./token/route"));
    ({ POST: decidePOST } = await import("./authorize/route"));
    ({ POST: mcpPOST } = await import("../mcp/route"));
    ({ DELETE: disconnectDELETE } = await import("../access/oauth-connections/[id]/route"));
    ({ default: AuthorizePage } = await import("@/app/(auth)/oauth/authorize/page"));
    ({ requireAccessContext } = (await import("@/lib/access-context")) as never as {
      requireAccessContext: ReturnType<typeof vi.fn>;
    });
  }, 60_000);

  beforeEach(async () => {
    vi.stubEnv("MCP_OAUTH_ENABLED", "true");
    vi.stubEnv("MCP_OAUTH_RESOURCES", MCP_URL);
    requireAccessContext.mockReset();
    await wipe();
    await seed();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (!db) return;
    await wipe();
    await db.$disconnect();
  });

  describe("registration (RFC 7591)", () => {
    it("registers claude.ai's and ChatGPT's callbacks and Claude Code's loopback as a public client", async () => {
      const { status, body } = await register({
        client_name: "Claude",
        redirect_uris: [CLAUDE_CALLBACK, CHATGPT_CALLBACK, "http://localhost/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        token_endpoint_auth_method: "client_secret_post",
      });
      expect(status).toBe(201);
      expect(body).toMatchObject({
        client_id: expect.stringMatching(/^wcl_[A-Za-z0-9_-]{43}$/),
        client_name: "Claude",
        redirect_uris: [CLAUDE_CALLBACK, CHATGPT_CALLBACK, "http://localhost/callback"],
        token_endpoint_auth_method: "none",
      });
      expect(body).not.toHaveProperty("client_secret");
    });

    it.each([
      ["no redirect URI", { redirect_uris: [] }, "invalid_redirect_uri"],
      ["plain http to a public host", { redirect_uris: ["http://evil.example/cb"] }, "invalid_redirect_uri"],
      ["a fragment", { redirect_uris: ["https://claude.ai/cb#x"] }, "invalid_redirect_uri"],
      ["a javascript: URL", { redirect_uris: ["javascript:alert(1)"] }, "invalid_redirect_uri"],
      ["userinfo in the URL", { redirect_uris: ["https://user:pw@claude.ai/cb"] }, "invalid_redirect_uri"],
      ["a non-string URI", { redirect_uris: [42] }, "invalid_redirect_uri"],
      [
        "eleven URIs",
        { redirect_uris: Array.from({ length: 11 }, (_, i) => `https://claude.ai/cb${i}`) },
        "invalid_redirect_uri",
      ],
      [
        "an unsupported grant",
        { redirect_uris: [CLAUDE_CALLBACK], grant_types: ["client_credentials"] },
        "invalid_client_metadata",
      ],
      [
        "an implicit response type",
        { redirect_uris: [CLAUDE_CALLBACK], response_types: ["token"] },
        "invalid_client_metadata",
      ],
      ["a body that is not an object", [CLAUDE_CALLBACK], "invalid_client_metadata"],
      ["a body that is not JSON", "{not json", "invalid_client_metadata"],
    ])("refuses %s with 400 and writes no client", async (_name, body, error) => {
      const before = await db.oAuthClient.count();
      const res = await register(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(error);
      expect(await db.oAuthClient.count()).toBe(before);
    });
  });

  describe("the authorize page", () => {
    it("shows, and never redirects, a request whose app or redirect URI cannot be trusted", async () => {
      signInAs(LEAD);
      const clientId = await registerClient();
      const { challenge } = pkce();
      for (const query of [
        authorizeParams("wcl_never_registered", challenge),
        authorizeParams("", challenge),
        authorizeParams(clientId, challenge, { redirect_uri: "https://evil.example/cb" }),
        authorizeParams(clientId, challenge, { redirect_uri: `${CLAUDE_CALLBACK}/extra` }),
      ]) {
        const { html, redirectedTo } = await openPage(query);
        expect(redirectedTo, JSON.stringify(query)).toBeUndefined();
        expect(html).toContain("This connection cannot start");
      }
    });

    it.each([
      ["no PKCE challenge", { code_challenge: "" }, "PKCE is required"],
      ["the plain PKCE method", { code_challenge_method: "plain" }, "PKCE is required"],
      ["a token response type", { response_type: "token" }, "response_type must be code"],
      [
        "a resource this server does not serve",
        { resource: "https://other.example/mcp" },
        "resource is not an MCP endpoint",
      ],
    ])(
      "shows %s on the page and never redirects, even to a registered URI, so the page is no open redirector",
      async (_name, extra, reason) => {
        for (const userId of [LEAD, null]) {
          signInAs(userId);
          const clientId = await registerClient(["https://evil.example/landing"], "x");
          const { html, redirectedTo } = await openPage(
            authorizeParams(clientId, pkce().challenge, { ...extra, redirect_uri: "https://evil.example/landing" }),
          );
          expect(redirectedTo).toBeUndefined();
          expect(html).toContain(reason);
        }
      },
    );

    it("asks a signed-in person with no workspace yet to choose or create one, and never to sign in again", async () => {
      signInAs(LEAD);
      requireAccessContext.mockResolvedValue(null);
      const clientId = await registerClient();
      const { html } = await openPage(authorizeParams(clientId, pkce().challenge));
      expect(html).toContain("Choose the workspace the app will connect to, or create one");
      expect(html).not.toContain("/sign-in");
    });

    it("shows its own refusal text after a refused choice, never text from the URL", async () => {
      signInAs(LEAD);
      const clientId = await registerClient();
      const { html } = await openPage({
        ...authorizeParams(clientId, pkce().challenge),
        willder_error: "Re-enter your password at evil.example",
      });
      expect(html).toContain("That choice was not saved");
      expect(html).not.toContain("evil.example");
    });

    it("sends a signed-out person to sign in or sign up and back to this exact request", async () => {
      signInAs(null);
      const clientId = await registerClient();
      const query = authorizeParams(clientId, pkce().challenge);
      const { html } = await openPage(query);
      const back = encodeURIComponent(`/oauth/authorize?${new URLSearchParams(query)}`);
      expect(html).toContain(`href="/sign-in?redirect_url=${back.replaceAll("&", "&amp;")}"`);
      expect(html).toContain(`href="/sign-up?redirect_url=${back.replaceAll("&", "&amp;")}"`);
      expect(html).not.toContain("<form");
    });

    it("offers only the scopes the person administers, names the app and where its access goes, and carries the request", async () => {
      signInAs(LEAD);
      const clientId = await registerClient([CLAUDE_CALLBACK], "Claude");
      const { html } = await openPage(authorizeParams(clientId, pkce().challenge));
      expect(html).toMatch(/<option value="org_oauth_flow_a\.sales"[^>]*>Sales<\/option>/);
      expect(html).not.toContain("Engineering");
      expect(html).not.toContain(`value="${ROOT_A}"`);
      expect(html).toContain("calls itself <span");
      expect(html).toContain("claude.ai</span>");
      expect(html).toContain(`name="client_id" value="${clientId}"`);
      expect(html).toMatch(/<option value="write"[^>]*>Read and write<\/option>/);
    });

    it("caps the choice at read when the app asks only for memory:read, and offers a read-only member nothing", async () => {
      signInAs(LEAD);
      const clientId = await registerClient();
      const readOnly = await openPage(authorizeParams(clientId, pkce().challenge, { scope: "memory:read" }));
      expect(readOnly.html).toMatch(/<option value="read"[^>]*>Read<\/option>/);
      expect(readOnly.html).not.toContain('value="write"');

      signInAs(MEMBER);
      const member = await openPage(authorizeParams(clientId, pkce().challenge));
      expect(member.html).toContain("You do not administer any part of");
      expect(member.html).not.toContain('value="allow"');
    });

    it("warns when the app's only redirect is a loopback address, and matches it on any port", async () => {
      signInAs(LEAD);
      const clientId = await registerClient(["http://127.0.0.1/callback"], "Claude Code");
      const { html } = await openPage(
        authorizeParams(clientId, pkce().challenge, { redirect_uri: "http://127.0.0.1:53114/callback" }),
      );
      expect(html).toContain("Any program running there could claim to be it");
    });
  });

  describe("the person's decision", () => {
    it("refuses a decision posted from another site, or with no Origin, before reading the session", async () => {
      const clientId = await registerClient();
      const fields = {
        ...authorizeParams(clientId, pkce().challenge),
        willder_decision: "allow",
        willder_scope_path: SALES,
        willder_permission: "read",
      };
      signInAs(LEAD);
      requireAccessContext.mockClear();
      for (const origin of ["https://evil.example", "null", null]) {
        const res = await decide(fields, origin);
        expect(res.status).toBe(403);
      }
      expect(requireAccessContext).not.toHaveBeenCalled();
      expect(await db.oAuthConnection.count({ where: { orgId: ORG_A } })).toBe(0);
    });

    it("sends a decision with no workspace or session back to the authorize page, connecting nothing", async () => {
      signInAs(null);
      const clientId = await registerClient();
      const res = await decide({
        ...authorizeParams(clientId, pkce().challenge),
        willder_decision: "allow",
        willder_scope_path: SALES,
        willder_permission: "read",
      });
      expect(res.status).toBe(303);
      expect(new URL(res.headers.get("location") ?? "", ORIGIN).pathname).toBe("/oauth/authorize");
      expect(await db.oAuthConnection.count({ where: { orgId: ORG_A } })).toBe(0);
    });

    it("answers Deny with access_denied, the state and iss, and connects nothing", async () => {
      signInAs(LEAD);
      const clientId = await registerClient();
      const res = await decide({ ...authorizeParams(clientId, pkce().challenge), willder_decision: "deny" });
      expect(res.status).toBe(303);
      const url = new URL(res.headers.get("location") ?? "");
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        error: "access_denied",
        state: "st_7f3a",
        iss: ORIGIN,
      });
      expect(await db.oAuthConnection.count({ where: { orgId: ORG_A } })).toBe(0);
    });

    it("answers Allow with a code, the state and iss at the registered redirect URI, and records the issue", async () => {
      const clientId = await registerClient();
      const { res, location, code } = await consent(LEAD, clientId, pkce().challenge, {
        scopePath: SALES,
        permission: "read",
      });
      expect(res.status).toBe(303);
      expect(`${location.origin}${location.pathname}`).toBe(CLAUDE_CALLBACK);
      expect(code).toMatch(/^wac_/);
      expect(location.searchParams.get("state")).toBe("st_7f3a");
      expect(location.searchParams.get("iss")).toBe(ORIGIN);
      expect(await audit(ORG_A, "access.manage")).toContainEqual(
        expect.objectContaining({ actorType: "human", actorId: LEAD, decision: "allow" }),
      );
    });

    it.each([
      ["a scope the person can read but not administer", MEMBER, SALES, "read", {}],
      ["a scope beside the one the person administers", LEAD, ENG, "read", {}],
      ["the org root", LEAD, ROOT_A, "read", {}],
      ["another org's scope", LEAD, ROOT_B, "read", {}],
      ["write, when the app asked only for memory:read", LEAD, SALES, "write", { scope: "memory:read" }],
      ["admin, which the page never offers", LEAD, SALES, "admin", {}],
    ])(
      "refuses %s, returns the person to the page with the reason, and issues no code",
      async (_name, userId, scopePath, permission, extra) => {
        const clientId = await registerClient();
        const { res, location, code } = await consent(
          userId,
          clientId,
          pkce().challenge,
          { scopePath, permission },
          extra,
        );
        expect(res.status).toBe(303);
        expect(location.pathname).toBe("/oauth/authorize");
        expect(location.searchParams.get("willder_error")).toBeTruthy();
        expect(code).toBeNull();
        expect(await db.oAuthAuthorizationCode.count({ where: { clientId } })).toBe(0);
        expect(await db.capability.count({ where: { orgId: { in: [ORG_A, ORG_B] }, revokedAt: null } })).toBe(0);
      },
    );

    it("shows a decision whose posted redirect URI was edited, and sends nothing to it", async () => {
      signInAs(LEAD);
      const clientId = await registerClient();
      const res = await decide({
        ...authorizeParams(clientId, pkce().challenge, { redirect_uri: "https://evil.example/cb" }),
        willder_decision: "allow",
        willder_scope_path: SALES,
        willder_permission: "read",
      });
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
      expect(await db.oAuthConnection.count({ where: { orgId: ORG_A } })).toBe(0);
    });
  });

  describe("the code exchange", () => {
    async function codeFor(clientId: string, challenge: string) {
      return (await consent(LEAD, clientId, challenge, { scopePath: SALES, permission: "read" })).code ?? "";
    }

    it("returns a bearer access token, a refresh token and the granted scope, never cached", async () => {
      const { body } = await connect(LEAD, { scopePath: SALES, permission: "read" });
      expect(body).toMatchObject({
        token_type: "Bearer",
        scope: "memory:read",
        access_token: expect.stringMatching(/^wat_/),
        refresh_token: expect.stringMatching(/^wrt_/),
      });
      expect(body.expires_in).toBeGreaterThan(3500);
      expect(body.expires_in).toBeLessThanOrEqual(3600);
      const stored = await db.oAuthToken.findMany({
        where: { connection: { orgId: ORG_A } },
        select: { tokenHash: true },
      });
      expect(stored.map((row) => row.tokenHash)).not.toContain(body.access_token);
    });

    it("refuses a wrong PKCE verifier, and the code is then spent for the right one too", async () => {
      const clientId = await registerClient();
      const { verifier, challenge } = pkce();
      const code = await codeFor(clientId, challenge);
      const exchange = (codeVerifier: string) =>
        token({
          grant_type: "authorization_code",
          code,
          client_id: clientId,
          redirect_uri: CLAUDE_CALLBACK,
          code_verifier: codeVerifier,
        });

      const wrong = await exchange(pkce().verifier);
      expect(wrong).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
      expect(wrong.headers.get("cache-control")).toBe("no-store");
      expect((await exchange(verifier)).body.error).toBe("invalid_grant");
    });

    it.each([
      ["another client's id", (f: Record<string, string>) => ({ ...f, client_id: "wcl_other" }), "invalid_grant"],
      [
        "another redirect URI",
        (f: Record<string, string>) => ({ ...f, redirect_uri: CHATGPT_CALLBACK }),
        "invalid_grant",
      ],
      [
        "another resource",
        (f: Record<string, string>) => ({ ...f, resource: "https://other.example/mcp" }),
        "invalid_target",
      ],
      ["a code that never existed", (f: Record<string, string>) => ({ ...f, code: "wac_never" }), "invalid_grant"],
      ["no verifier", (f: Record<string, string>) => ({ ...f, code_verifier: "" }), "invalid_request"],
      [
        "an unknown grant type",
        (f: Record<string, string>) => ({ ...f, grant_type: "password" }),
        "unsupported_grant_type",
      ],
    ])("refuses %s", async (_name, change, error) => {
      const clientId = await registerClient();
      const { verifier, challenge } = pkce();
      const fields = {
        grant_type: "authorization_code",
        code: await codeFor(clientId, challenge),
        client_id: clientId,
        redirect_uri: CLAUDE_CALLBACK,
        code_verifier: verifier,
      };
      const res = await token(change(fields));
      expect(res).toMatchObject({ status: 400, body: { error } });
      expect(await db.oAuthToken.count({ where: { clientId } })).toBe(0);
    });

    it("refuses an expired code", async () => {
      const clientId = await registerClient();
      const { verifier, challenge } = pkce();
      const code = await codeFor(clientId, challenge);
      await db.oAuthAuthorizationCode.updateMany({
        where: { clientId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const res = await token({ grant_type: "authorization_code", code, client_id: clientId, code_verifier: verifier });
      expect(res.body.error).toBe("invalid_grant");
    });

    it("revokes every token issued from a code presented a second time", async () => {
      const clientId = await registerClient();
      const { verifier, challenge } = pkce();
      const fields = {
        grant_type: "authorization_code",
        code: await codeFor(clientId, challenge),
        client_id: clientId,
        code_verifier: verifier,
      };
      const first = await token(fields);
      expect((await mcp(first.body.access_token)).status).toBe(200);

      expect((await token(fields)).body.error).toBe("invalid_grant");
      expect((await mcp(first.body.access_token)).status).toBe(401);
      expect(
        (await token({ grant_type: "refresh_token", refresh_token: first.body.refresh_token, client_id: clientId }))
          .body.error,
      ).toBe("invalid_grant");
    });

    it("lets no other client end a connection by replaying a spent code", async () => {
      const clientId = await registerClient();
      const { verifier, challenge } = pkce();
      const fields = {
        grant_type: "authorization_code",
        code: await codeFor(clientId, challenge),
        client_id: clientId,
        code_verifier: verifier,
      };
      const first = await token(fields);
      expect(
        (await token({ ...fields, client_id: "wcl_someone_else", code_verifier: pkce().verifier })).body.error,
      ).toBe("invalid_grant");
      expect((await mcp(first.body.access_token)).status).toBe(200);
    });

    it("refuses a JSON body: the token endpoint reads form encoding only", async () => {
      const res = await tokenPOST(
        new Request(`${ORIGIN}/api/oauth/token`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid_request");
    });
  });

  describe("an OAuth token on /api/mcp", () => {
    it("runs a read connection as its capability: its scope is read, the scope beside it and any write are refused, all audited as the agent", async () => {
      const { access } = await connect(LEAD, { scopePath: SALES, permission: "read" });

      expect((await mcp(access)).status).toBe(200);
      expect((await toolResult(await mcp(access, readChanges(SALES)))).isError).toBe(false);
      expect(await toolResult(await mcp(access, readChanges(ENG)))).toEqual({
        isError: true,
        text: expect.stringContaining("Access denied"),
      });
      expect((await toolResult(await mcp(access, postNote(SALES)))).isError).toBe(true);

      const asAgent = {
        actorType: "agent",
        actorId: expect.stringMatching(/^Claude \(.{8}\)$/),
        metadata: expect.objectContaining({ triggeredBy: LEAD }),
      };
      const reads = await audit(ORG_A, "memory.read");
      expect(reads).toContainEqual(
        expect.objectContaining({ ...asAgent, decision: "allow", target: expect.stringMatching(`^${SALES}`) }),
      );
      expect(reads).toContainEqual(
        expect.objectContaining({ ...asAgent, decision: "deny", target: expect.stringMatching(`^${ENG}`) }),
      );
      expect(await audit(ORG_A, "memory.write")).toContainEqual(
        expect.objectContaining({ ...asAgent, decision: "deny" }),
      );
      expect(await db.workingNote.count({ where: { orgId: ORG_A } })).toBe(0);
    });

    it("lets a read-and-write connection write in its scope, and nowhere else", async () => {
      const { access } = await connect(LEAD, { scopePath: SALES, permission: "write" });
      expect((await toolResult(await mcp(access, postNote(SALES)))).isError).toBe(false);
      expect((await toolResult(await mcp(access, postNote(ENG)))).isError).toBe(true);
      expect(await db.workingNote.count({ where: { orgId: ORG_A, scopePath: SALES } })).toBe(1);
      expect(await db.workingNote.count({ where: { orgId: ORG_A, scopePath: ENG } })).toBe(0);
    });

    it("never runs as an org agent that shares the app's self-chosen name", async () => {
      await db.agent.create({ data: { orgId: ORG_A, agentKey: "custom-claude-ops", name: "Claude", role: "custom" } });
      const { access, clientId } = await connect(LEAD, { scopePath: SALES, permission: "read" });
      const connection = await db.oAuthConnection.findFirstOrThrow({
        where: { orgId: ORG_A, clientId },
        include: { capability: true },
      });
      expect(connection.capability.agentId).toBe(`Claude (${clientId.slice(4, 12)})`);
      await db.agent.updateMany({ where: { orgId: ORG_A, agentKey: "custom-claude-ops" }, data: { active: false } });
      expect((await mcp(access)).status).toBe(200);
    });

    it("keeps another org's connection out of this org, whatever scope its calls name", async () => {
      const { access } = await connect(ADMIN_B, { scopePath: ROOT_B, permission: "write" });
      for (const body of [readChanges(SALES), readChanges(ROOT_A), postNote(SALES)]) {
        expect((await toolResult(await mcp(access, body))).isError).toBe(true);
      }
      expect((await audit(ORG_A, "memory.read")).filter((row) => row.decision === "allow")).toEqual([]);
      expect(await db.workingNote.count({ where: { orgId: ORG_A } })).toBe(0);
    });

    async function expectRefused(access: string) {
      const res = await mcp(access);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe(
        `${CHALLENGE_PREFIX}, scope="memory:read memory:write", error="invalid_token"`,
      );
    }

    it("refuses every token at once when the person disconnects the app, and records the refusal", async () => {
      const { access, refresh, clientId } = await connect(LEAD, { scopePath: SALES, permission: "read" });
      const connection = await db.oAuthConnection.findFirstOrThrow({ where: { orgId: ORG_A, clientId } });
      signInAs(LEAD);
      expect(
        (
          await disconnectDELETE(new Request(ORIGIN, { method: "DELETE" }), {
            params: Promise.resolve({ id: connection.id }),
          })
        ).status,
      ).toBe(200);

      await expectRefused(access);
      expect(await audit(ORG_A, "capability.refused")).toHaveLength(1);
      expect(
        (await token({ grant_type: "refresh_token", refresh_token: refresh, client_id: clientId })).body.error,
      ).toBe("invalid_grant");
    });

    it("refuses the token when an admin revokes its capability on the Access page", async () => {
      const { access, clientId } = await connect(LEAD, { scopePath: SALES, permission: "read" });
      const connection = await db.oAuthConnection.findFirstOrThrow({ where: { orgId: ORG_A, clientId } });
      await db.capability.update({ where: { id: connection.capabilityId }, data: { revokedAt: new Date() } });
      await expectRefused(access);
      expect(await audit(ORG_A, "capability.refused")).toHaveLength(1);
    });

    it("refuses the token when only its connection row is revoked, though its capability still resolves", async () => {
      const { access, clientId } = await connect(LEAD, { scopePath: SALES, permission: "read" });
      await db.oAuthConnection.updateMany({ where: { orgId: ORG_A, clientId }, data: { revokedAt: new Date() } });
      await expectRefused(access);
    });

    it("ends the earlier tokens when the person connects the same app again", async () => {
      const first = await connect(LEAD, { scopePath: SALES, permission: "write" });
      const { verifier, challenge } = pkce();
      const { code } = await consent(LEAD, first.clientId, challenge, { scopePath: SALES, permission: "read" });
      const second = await token({
        grant_type: "authorization_code",
        code: code ?? "",
        client_id: first.clientId,
        code_verifier: verifier,
      });

      await expectRefused(first.access);
      expect((await mcp(second.body.access_token)).status).toBe(200);
      expect((await toolResult(await mcp(second.body.access_token, postNote(SALES)))).isError).toBe(true);
    });

    it("refuses an expired access token with invalid_token, and a refresh brings a working one", async () => {
      const { access, refresh, clientId } = await connect(LEAD, { scopePath: SALES, permission: "read" });
      await db.oAuthToken.updateMany({
        where: { clientId, kind: "access" },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await expectRefused(access);

      const refreshed = await token({
        grant_type: "refresh_token",
        refresh_token: refresh,
        client_id: clientId,
        resource: MCP_URL,
      });
      expect(refreshed.status).toBe(200);
      expect(refreshed.body.refresh_token).not.toBe(refresh);
      expect((await mcp(refreshed.body.access_token)).status).toBe(200);
    });

    it("refuses a token issued for another listed resource than the one it is presented to", async () => {
      vi.stubEnv("MCP_OAUTH_RESOURCES", `${MCP_URL},https://other.test/api/mcp`);
      const { access } = await connect(
        LEAD,
        { scopePath: SALES, permission: "read" },
        { resource: "https://other.test/api/mcp" },
      );
      await expectRefused(access);
    });

    it("refuses a token issued for a resource this server no longer lists", async () => {
      const { access } = await connect(LEAD, { scopePath: SALES, permission: "read" });
      vi.stubEnv("MCP_OAUTH_RESOURCES", "https://willder.example/api/mcp");
      await expectRefused(access);
    });
  });

  describe("refresh token rotation", () => {
    it("refuses a spent refresh token within the leeway without ending the connection", async () => {
      const { refresh, clientId } = await connect(LEAD, { scopePath: SALES, permission: "read" });
      const next = await token({ grant_type: "refresh_token", refresh_token: refresh, client_id: clientId });
      expect(
        (await token({ grant_type: "refresh_token", refresh_token: refresh, client_id: clientId })).body.error,
      ).toBe("invalid_grant");
      expect((await mcp(next.body.access_token)).status).toBe(200);
    });

    it("revokes the whole family when a spent refresh token comes back after the leeway", async () => {
      const { refresh, clientId } = await connect(LEAD, { scopePath: SALES, permission: "read" });
      const next = await token({ grant_type: "refresh_token", refresh_token: refresh, client_id: clientId });
      await db.oAuthToken.updateMany({
        where: { clientId, usedAt: { not: null } },
        data: { usedAt: new Date(Date.now() - 2 * 60 * 1000) },
      });

      expect(
        (await token({ grant_type: "refresh_token", refresh_token: refresh, client_id: clientId })).body.error,
      ).toBe("invalid_grant");
      expect((await mcp(next.body.access_token)).status).toBe(401);
      expect(
        (await token({ grant_type: "refresh_token", refresh_token: next.body.refresh_token, client_id: clientId })).body
          .error,
      ).toBe("invalid_grant");
    });

    it("refuses a refresh token presented by another client, or as an access token", async () => {
      const { refresh, clientId } = await connect(LEAD, { scopePath: SALES, permission: "read" });
      expect(
        (await token({ grant_type: "refresh_token", refresh_token: refresh, client_id: "wcl_other" })).body.error,
      ).toBe("invalid_grant");
      expect((await mcp(refresh)).status).toBe(401);
      expect((await token({ grant_type: "refresh_token", refresh_token: refresh, client_id: clientId })).status).toBe(
        200,
      );
    });
  });

  it("serves no OAuth endpoint while MCP_OAUTH_ENABLED is off, and a live token stops working", async () => {
    const { access, clientId } = await connect(LEAD, { scopePath: SALES, permission: "read" });
    vi.stubEnv("MCP_OAUTH_ENABLED", "");
    signInAs(LEAD);
    requireAccessContext.mockClear();

    expect((await register({ redirect_uris: [CLAUDE_CALLBACK] })).status).toBe(404);
    const tokenRes = await tokenPOST(new Request(`${ORIGIN}/api/oauth/token`, { method: "POST", body: "" }));
    expect(tokenRes.status).toBe(404);
    expect((await decide({ client_id: clientId, willder_decision: "allow" })).status).toBe(404);
    await expect(openPage(authorizeParams(clientId, pkce().challenge))).rejects.toThrow("NEXT_NOT_FOUND");
    const mcpRes = await mcp(access);
    expect(mcpRes.status).toBe(401);
    expect((await mcpRes.json()).error.message).toBe("Invalid or unknown capability token.");
    expect(requireAccessContext).not.toHaveBeenCalled();
  });
});
