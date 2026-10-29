// The OAuth authorize page: where an MCP client such as claude.ai or ChatGPT sends a
// person to connect it to Willder.
//
// The page checks the client's request (services/access/oauth-authorization.ts),
// makes sure the person is signed in, and asks what the app may reach: a workspace, a
// scope the person administers, and read or read-and-write. It names the app as it
// calls itself and the site it will hand access to, since anyone can register an app.
// The form posts to /api/oauth/authorize, which checks everything again.
//
// The one rule this page enforces: a request that fails a check is answered here,
// never by redirecting the browser. Anyone can register a redirect URI, so sending
// errors to it unattended would make this page an open redirector (RFC 9700 4.11.2).
// Only the person's own Allow or Deny sends them back to the app. The page exists
// only when MCP_OAUTH_ENABLED is `true`; otherwise it is a 404 before it reads the
// session or the query.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { OrganizationSwitcher } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import { requireAccessContext } from "@/lib/access-context";
import { authorizationParamsOf, CONSENT_FIELDS } from "@/lib/oauth-authorize-form";
import { mcpOAuthEnabled, mcpOAuthResources } from "@/mcp/oauth-discovery";
import {
  defaultAgentName,
  issuableScopes,
  liveOAuthConnection,
  narrowestScopePath,
  onlyLoopbackRedirects,
  validateAuthorizationRequest,
} from "@/services/access";
import { AuthShell } from "@/components/auth/auth-shell";

export const metadata: Metadata = {
  title: "Connect an app | Willder",
  robots: { index: false, follow: false },
};

type Query = Record<string, string | string[] | undefined>;

const PERMISSION_LABELS: Record<string, string> = { read: "Read", write: "Read and write" };

const fieldCls =
  "min-h-11 min-w-0 w-full rounded-xl border border-[var(--field-border)] bg-[var(--field-background)] px-4 py-2.5 text-base font-normal text-fg placeholder:text-[var(--field-placeholder)] hover:border-[var(--field-border-hover)] focus-visible:border-[var(--field-border-focus)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info";
const buttonCls =
  "min-h-11 flex-1 rounded-xl px-4 py-2.5 text-base font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info";

function queryEntries(query: Query): [string, string][] {
  return Object.entries(query).flatMap(([name, value]) =>
    value === undefined ? [] : (Array.isArray(value) ? value : [value]).map((v): [string, string] => [name, v]),
  );
}

function Message({ title, description }: { title: string; description: string }) {
  return (
    <AuthShell title={title} description={description}>
      {null}
    </AuthShell>
  );
}

export default async function OAuthAuthorizePage({ searchParams }: { searchParams: Promise<Query> }) {
  if (!mcpOAuthEnabled()) notFound();

  const entries = queryEntries(await searchParams);
  const params = authorizationParamsOf(entries);
  // Only whether the last submit was refused is read from the URL, never its wording,
  // so a crafted link cannot put its own text on this page.
  const refusedBefore = entries.some(([name]) => name === CONSENT_FIELDS.error);
  const here = `/oauth/authorize?${params}`;

  const validation = await validateAuthorizationRequest(params, mcpOAuthResources());
  if (!validation.ok) {
    return <Message title="This connection cannot start" description={validation.show} />;
  }
  const request = validation.request;
  const appName = request.client.name ?? "An app";
  const answerHost = new URL(request.redirectUri).host;

  const rc = await requireAccessContext();
  if (!rc && (await auth()).userId) {
    // Signed in, but with no workspace open yet: a new account has none until it makes one.
    return (
      <AuthShell
        title={`Connect ${appName} to Willder`}
        description="Choose the workspace the app will connect to, or create one. You will come back here."
      >
        <OrganizationSwitcher
          hidePersonal
          afterSelectOrganizationUrl={here}
          afterCreateOrganizationUrl={here}
          appearance={{
            elements: { rootBox: "w-full", organizationSwitcherTrigger: "w-full justify-between rounded-md px-3 py-2" },
          }}
        />
      </AuthShell>
    );
  }
  if (!rc) {
    const back = encodeURIComponent(here);
    return (
      <AuthShell
        title={`Connect ${appName} to Willder`}
        description="Sign in to Willder first. You will come back here to choose what the app can reach."
      >
        <div className="flex flex-col gap-3 text-base">
          <Link
            href={`/sign-in?redirect_url=${back}`}
            className="font-medium text-accent underline-offset-4 hover:underline"
          >
            Sign in
          </Link>
          <Link
            href={`/sign-up?redirect_url=${back}`}
            className="font-medium text-accent underline-offset-4 hover:underline"
          >
            Create an account
          </Link>
        </div>
      </AuthShell>
    );
  }

  const [scopes, current] = await Promise.all([
    issuableScopes(rc.ctx),
    liveOAuthConnection(rc.org.id, rc.user.id, request.client.id),
  ]);
  const scopeName = (path: string) => scopes.find((s) => s.path === path)?.name ?? path;

  return (
    <AuthShell
      title={`Connect ${appName}`}
      description={`It will reach only the part of ${rc.org.name} you choose, until you disconnect it on Integrations.`}
    >
      <div className="flex flex-col gap-2 text-sm text-fg-muted">
        <p>
          The app calls itself <span className="font-medium text-fg">{appName}</span>. Willder will send its access to{" "}
          <span className="font-medium text-fg">{answerHost}</span>. Continue only if you started this from that app.
        </p>
        {onlyLoopbackRedirects(request.client) ? (
          <p role="note" className="text-warning">
            This app answers on your own computer ({answerHost}). Any program running there could claim to be it.
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium text-fg">Workspace</span>
        <OrganizationSwitcher
          hidePersonal
          afterSelectOrganizationUrl={here}
          afterCreateOrganizationUrl={here}
          appearance={{
            elements: { rootBox: "w-full", organizationSwitcherTrigger: "w-full justify-between rounded-md px-3 py-2" },
          }}
        />
      </div>

      {current ? (
        <p className="text-sm text-fg-muted">
          Connected now: {PERMISSION_LABELS[current.permission]?.toLowerCase() ?? current.permission} on{" "}
          {scopeName(current.scopePath)}. Allowing again replaces it.
        </p>
      ) : null}

      {refusedBefore ? (
        <p role="alert" className="text-base text-danger">
          That choice was not saved. You can share only a scope you administer, with read, or read and write when the
          app asked for it.
        </p>
      ) : null}

      <form method="POST" action="/api/oauth/authorize" className="flex flex-col gap-4">
        {[...params].map(([name, value], index) => (
          <input key={`${name}:${index}`} type="hidden" name={name} value={value} />
        ))}
        {scopes.length === 0 ? (
          <p className="text-base text-fg">
            You do not administer any part of {rc.org.name}, so there is nothing you can share. Ask an admin for admin
            on a scope, or choose another workspace.
          </p>
        ) : (
          <>
            <label className="flex flex-col gap-2 text-sm font-medium text-fg">
              What it can reach
              <select name={CONSENT_FIELDS.scopePath} defaultValue={narrowestScopePath(scopes)} className={fieldCls}>
                {scopes.map((s) => (
                  <option key={s.path} value={s.path}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-2 text-sm font-medium text-fg">
              What it can do
              <select name={CONSENT_FIELDS.permission} defaultValue="read" className={fieldCls}>
                {request.permissions.map((permission) => (
                  <option key={permission} value={permission}>
                    {PERMISSION_LABELS[permission]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-2 text-sm font-medium text-fg">
              Name in the audit log
              <input
                name={CONSENT_FIELDS.agentName}
                placeholder={defaultAgentName(request.client)}
                maxLength={100}
                className={fieldCls}
              />
            </label>
          </>
        )}
        <div className="flex gap-3">
          <button
            type="submit"
            name={CONSENT_FIELDS.decision}
            value="deny"
            className={`${buttonCls} border border-divider text-fg`}
          >
            Deny
          </button>
          {scopes.length > 0 ? (
            <button
              type="submit"
              name={CONSENT_FIELDS.decision}
              value="allow"
              className={`${buttonCls} bg-accent text-accent-foreground`}
            >
              Allow
            </button>
          ) : null}
        </div>
      </form>
    </AuthShell>
  );
}
