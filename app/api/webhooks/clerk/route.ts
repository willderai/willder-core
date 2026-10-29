import { NextResponse } from "next/server";
import { Webhook, type WebhookRequiredHeaders } from "svix";
import { db } from "@/lib/db";
import { memory } from "@/services/memory";
import { clerkRoleToUserRole, recordMembership, recordMembershipRemoved } from "@/services/access";
import { emailsOfClerkWebhookUser, storedEmailVerified } from "@/lib/clerk-email";
import { queueFinalExport } from "@/lib/inngest/org-deletion";
import { refreshDeletionRecipients, startOrgDeletion } from "@/services/memory/org-deletion/request";
import { orgDeletionOpen } from "@/services/access/org-deletion-gate";

// POST /api/webhooks/clerk — Clerk organization membership and user events.
// Records who belongs to which org, with what role (services/access/membership.ts),
// when it changes outside a signed-in request in that org: a person added,
// re-roled or removed by an admin while they have another org open, or are not
// signed in at all. Without these events a change reaches the database only on
// the person's next signed-in request in that org, and a removal never does.
// Also keeps memory in step with who is (or was) in the org. Handles
// user.created and user.updated to record whether Clerk verified the email
// Willder stores for that user (`User.emailVerified`, lib/clerk-email.ts), which
// source-connect widening relies on before it matches a person by email. And
// organization.deleted starts the org's deletion, the same 7-day deletion an owner
// starts in the app (services/memory/org-deletion).
//
// Setup: add CLERK_WEBHOOK_SECRET (from Clerk dashboard → Webhooks → svix secret)
// to .env. Register the endpoint with Clerk using the public URL (ngrok in dev /
// Vercel URL in prod). Subscribe to: organizationMembership.created,
// organizationMembership.updated, organizationMembership.deleted, user.created,
// user.updated, organization.deleted. A second Clerk endpoint can deliver to the same URL (during a
// secret rotation, or when two endpoints split the subscriptions); put its
// secret in CLERK_WEBHOOK_SECRET_2.
//
// Not user-authed (the caller is Clerk): every request is verified against a
// configured svix signing secret before anything is read from it. Each secret
// verifies on its own; the request is accepted if any one does. No usable secret
// is a misconfiguration, not a permission to skip verification, so the route
// refuses with 503 and never processes an unverified payload. That includes a
// value set but not usable as a secret (one anyone could sign with, or one svix
// cannot decode): the route then refuses every request, even ones the other
// secret would verify, so a broken configuration is fixed rather than half-run.

type MembershipEventType =
  | "organizationMembership.created"
  | "organizationMembership.updated"
  | "organizationMembership.deleted";

const MEMBERSHIP_EVENTS: readonly string[] = [
  "organizationMembership.created",
  "organizationMembership.updated",
  "organizationMembership.deleted",
];

function isMembershipEvent(
  payload: ClerkMembershipPayload | ClerkUserPayload | ClerkOrganizationDeletedPayload,
): payload is ClerkMembershipPayload {
  return MEMBERSHIP_EVENTS.includes(payload.type);
}

interface ClerkMembershipPayload {
  /** When Clerk emitted the event, in epoch milliseconds. */
  timestamp?: number;
  data: {
    id: string;
    /** The member's Clerk org role, e.g. "org:admin". */
    role?: string;
    updated_at?: number;
    organization: { id: string; name: string };
    public_user_data: {
      user_id: string;
      first_name?: string | null;
      last_name?: string | null;
      identifier?: string | null;
    };
  };
  type: MembershipEventType;
}

/** When Clerk asserted this event's state: its emit time, else the membership's
 * own update time, else now (the receipt time is never earlier than the event). */
function eventAssertedAt(payload: ClerkMembershipPayload): Date {
  return new Date(payload.timestamp ?? payload.data.updated_at ?? Date.now());
}

interface ClerkOrganizationDeletedPayload {
  /** When Clerk emitted the event, in epoch milliseconds. */
  timestamp?: number;
  data: { id: string };
  type: "organization.deleted";
}

interface ClerkUserPayload {
  data: {
    id: string;
    email_addresses?: { email_address: string; verification?: { status?: string } | null }[];
  };
  type: "user.created" | "user.updated";
}

/**
 * Record whether Clerk verified the email Willder stores for this user. The
 * stored address is not changed here: verification is recorded for the exact
 * address widening matches on, so a primary address Clerk has since replaced
 * reads as unverified until the user's next sign-in re-syncs it.
 */
async function recordEmailVerification(data: ClerkUserPayload["data"]): Promise<void> {
  const user = await db.user.findUnique({ where: { clerkId: data.id }, select: { email: true } });
  if (!user) return; // Not synced by ensureTenant yet; it records verification when it creates the row.
  const emailVerified = storedEmailVerified(user.email, emailsOfClerkWebhookUser(data));
  await db.user.update({ where: { clerkId: data.id }, data: { emailVerified } });
}

/** A svix signing secret as Clerk issues it: "whsec_" followed by a base64 key. */
const SIGNING_SECRET_FORMAT = /^whsec_[A-Za-z0-9+/]{32,}={0,2}$/;

/**
 * The least key material a secret must carry, in bytes. HMAC zero-pads a short
 * key, so trailing zero bytes add nothing: a key byte followed by 23 zeros signs
 * exactly like that one byte. Clerk issues 24 random bytes.
 */
const MIN_KEY_MATERIAL_BYTES = 16;

/**
 * Whether `value` is a signing secret only its holder can sign with. svix strips
 * "whsec_" and base64-decodes the rest without checking it, so it would accept
 * "whsec_" alone (an empty HMAC key), a key of zero bytes, or a key that is one
 * byte followed by zeros: anyone could sign a request that verifies against
 * those. The value must be "whsec_" plus valid base64 whose key, without its
 * trailing zero bytes, is at least 16 bytes and not one byte repeated.
 */
function isUsableSigningSecret(value: string): boolean {
  if (!SIGNING_SECRET_FORMAT.test(value)) return false;
  const encoded = value.slice("whsec_".length);
  if (encoded.length % 4 !== 0) return false;
  const key = Buffer.from(encoded, "base64");
  let end = key.length;
  while (end > 0 && key[end - 1] === 0) end--;
  const material = key.subarray(0, end);
  return material.length >= MIN_KEY_MATERIAL_BYTES && material.some((byte) => byte !== material[0]);
}

/**
 * The signing secret of each Clerk endpoint that may deliver here: the usable
 * ones that are set, and the names of variables set to a value that is not one.
 */
function readSigningSecrets(): { secrets: string[]; unusable: string[] } {
  const configured = {
    CLERK_WEBHOOK_SECRET: process.env.CLERK_WEBHOOK_SECRET,
    CLERK_WEBHOOK_SECRET_2: process.env.CLERK_WEBHOOK_SECRET_2,
  };
  const secrets: string[] = [];
  const unusable: string[] = [];
  for (const [name, value] of Object.entries(configured)) {
    if (!value) continue;
    if (isUsableSigningSecret(value)) secrets.push(value);
    else unusable.push(name);
  }
  return { secrets, unusable };
}

/**
 * Whether `body` carries a valid svix signature from one of `endpoints`, one per
 * secret. Each secret verifies on its own; the request is accepted if any one does.
 */
function verifiesWithAny(endpoints: Webhook[], body: string, headers: WebhookRequiredHeaders): boolean {
  return endpoints.some((endpoint) => {
    try {
      endpoint.verify(body, headers);
      return true;
    } catch {
      return false;
    }
  });
}

export async function POST(req: Request) {
  const { secrets, unusable } = readSigningSecrets();
  if (unusable.length > 0) {
    console.error(
      `[clerk webhook] refusing every request: set to a value that is not a usable svix signing secret: ${unusable.join(", ")}. Copy it again from Clerk dashboard \u2192 Webhooks \u2192 Signing Secret ("whsec_" followed by the key, no spaces or newline), or unset it.`,
    );
    return NextResponse.json({ error: "webhook signing secret not configured" }, { status: 503 });
  }
  if (secrets.length === 0) {
    console.error(
      "[clerk webhook] refusing request: neither CLERK_WEBHOOK_SECRET nor CLERK_WEBHOOK_SECRET_2 is set, so the signature cannot be verified. Set CLERK_WEBHOOK_SECRET from Clerk dashboard \u2192 Webhooks \u2192 Signing Secret.",
    );
    return NextResponse.json({ error: "webhook signing secret not configured" }, { status: 503 });
  }

  const endpoints = secrets.map((secret) => new Webhook(secret));
  const body = await req.text();
  const signed = verifiesWithAny(endpoints, body, {
    "svix-id": req.headers.get("svix-id") ?? "",
    "svix-timestamp": req.headers.get("svix-timestamp") ?? "",
    "svix-signature": req.headers.get("svix-signature") ?? "",
  });
  if (!signed) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let payload: ClerkMembershipPayload | ClerkUserPayload | ClerkOrganizationDeletedPayload;
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (payload.type === "user.created" || payload.type === "user.updated") {
    await recordEmailVerification(payload.data);
    return NextResponse.json({ ok: true });
  }

  if (payload.type === "organization.deleted") {
    return startDeletionForClerk(payload, req.headers.get("svix-id") ?? "");
  }

  if (!isMembershipEvent(payload)) {
    return NextResponse.json({ ok: true });
  }
  const { type, data } = payload;

  const clerkOrgId = data.organization.id;
  const org = await db.org.findUnique({ where: { clerkOrgId } });
  if (!org) {
    // Org not yet synced via ensureTenant — nothing to update.
    return NextResponse.json({ ok: true });
  }

  const ud = data.public_user_data;
  const assertedAt = eventAssertedAt(payload);
  // A person who has never signed in has no row yet; their first signed-in
  // request records the membership from the session token.
  const user = await db.user.findUnique({ where: { clerkId: ud.user_id }, select: { id: true } });

  if (user && type === "organizationMembership.deleted") {
    await recordMembershipRemoved({ orgId: org.id, userId: user.id, removedAt: assertedAt });
  } else if (user) {
    await recordMembership({ orgId: org.id, userId: user.id, role: clerkRoleToUserRole(data.role), assertedAt });
  }
  // A change Clerk asserted before it deleted the org can take a person off the
  // deletion's recipients, whichever event arrives first.
  if (user) await refreshDeletionRecipients(org.id);
  // An org being deleted takes no new memory, this departure episode included.
  if (await orgDeletionOpen(org.id)) return NextResponse.json({ ok: true });

  const memberName = [ud.first_name, ud.last_name].filter(Boolean).join(" ") || ud.identifier || ud.user_id;

  if (type === "organizationMembership.created") {
    void memory
      .ingest({
        groupId: org.id,
        content: `${memberName} joined the ${org.name} workspace as a team member.`,
        source: "text",
        name: memberName,
        actorType: "extraction",
        origin: "webhook",
        actorId: org.id,
        actorName: "system",
      })
      .catch(() => {});
  }

  if (type === "organizationMembership.deleted") {
    // Seed a departure episode so the graph reflects reality.
    void memory
      .ingest({
        groupId: org.id,
        content: `${memberName} is no longer a team member of the ${org.name} workspace.`,
        source: "text",
        name: memberName,
        actorType: "extraction",
        origin: "webhook",
        actorId: org.id,
        actorName: "system",
      })
      .catch(() => {});
  }

  return NextResponse.json({ ok: true });
}

/**
 * Start the 7-day deletion of the org Clerk deleted. The svix message id keys it, so a
 * redelivery is answered with the deletion it already started and never restarts one an
 * owner cancelled. An org this database never synced has nothing to delete.
 */
async function startDeletionForClerk(payload: ClerkOrganizationDeletedPayload, svixId: string) {
  const org = await db.org.findUnique({ where: { clerkOrgId: payload.data.id }, select: { id: true } });
  if (!org) return NextResponse.json({ ok: true });
  const result = await startOrgDeletion({
    trigger: "clerk",
    orgId: org.id,
    clerkEventId: svixId,
    deletedAt: new Date(payload.timestamp ?? Date.now()),
  });
  if (result?.started) {
    await queueFinalExport(result.deletion.id).catch((error: unknown) => {
      console.error("[clerk webhook] could not queue the final export; the sweep will make it", error);
    });
  }
  return NextResponse.json({ ok: true });
}
