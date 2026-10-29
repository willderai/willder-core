// Capability tokens — live check. Run with: npm run capabilities:check
// Verifies the "raw token returned once, hash stored" invariant at the DB layer.
// Does NOT need the HTTP server — drives the service + DB directly. Covers:
//   • generateCapabilityToken produces a wcap_-prefixed token; hash is different
//   • DB stores tokenHash, never the raw token
//   • The metadata select (mirrors GET /api/access/capabilities) never returns tokenHash
//   • check() allows access with the raw token against a valid capability
//   • check() denies access with an incorrect token
//   • check() denies access after the capability is revoked
// Exits non-zero on any failure.
import { db } from "@/lib/db";
import { generateCapabilityToken, hashCapabilityToken } from "@/services/access/capabilities";
import { check, orgRootPath } from "@/services/access";
import type { AccessContext } from "@/services/access";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error("FAILED: " + msg);
  console.log("  ✓ " + msg);
}

async function main() {
  console.log("Checking capability tokens ...\n");

  const org = await db.org.create({ data: { name: "__capabilities_check__" } });
  const scope = await db.scope.create({
    data: { orgId: org.id, path: orgRootPath(org.id), name: "Organization" },
  });

  try {
    // ── Token generation ────────────────────────────────────────────────────────
    console.log("Token generation...");
    const token = generateCapabilityToken();
    assert(token.startsWith("wcap_"), "token has wcap_ prefix");
    assert(token.length > 10, "token has sufficient length");

    const hash = hashCapabilityToken(token);
    assert(hash !== token, "hash differs from raw token");
    assert(hash.length === 64, "hash is 64-char hex (SHA-256)");
    assert(hashCapabilityToken(token) === hash, "hashing is deterministic");

    const otherToken = generateCapabilityToken();
    assert(otherToken !== token, "each generated token is unique");
    assert(hashCapabilityToken(otherToken) !== hash, "different tokens produce different hashes");

    // ── DB stores hash, not raw token ────────────────────────────────────────────
    console.log("\nDB stores tokenHash, never the raw token...");
    const agentId = "check-agent-1";
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    const created = await db.capability.create({
      data: { orgId: org.id, agentId, tokenHash: hash, scopePath: scope.path, permission: "read", expiresAt },
    });

    // Read back the full row directly to inspect what is stored
    const raw = await db.$queryRaw<{ id: string; tokenHash: string }[]>`
      SELECT id, "tokenHash" FROM capabilities WHERE id = ${created.id}
    `;
    assert(raw.length === 1, "capability row created");
    assert(raw[0].tokenHash === hash, "stored value equals the hash");
    assert(raw[0].tokenHash !== token, "stored value is NOT the raw token");

    // ── Metadata select (mirrors GET /api/access/capabilities) ──────────────────
    console.log("\nGET metadata select never returns tokenHash...");
    const metadataRows = await db.capability.findMany({
      where: { orgId: org.id },
      select: {
        id: true,
        agentId: true,
        scopePath: true,
        permission: true,
        expiresAt: true,
        revokedAt: true,
        createdAt: true,
      },
    });
    assert(metadataRows.length === 1, "one capability returned");
    assert(!("tokenHash" in metadataRows[0]), "tokenHash absent from metadata select");
    assert(!("token" in metadataRows[0]), "raw token absent from metadata select");
    assert(metadataRows[0].agentId === agentId, "agentId present in metadata");
    assert(metadataRows[0].permission === "read", "permission present in metadata");

    // ── check() allows access with the raw token ─────────────────────────────────
    console.log("\ncheck() allows valid capability...");
    const agentCtx: AccessContext = {
      orgId: org.id,
      actor: { type: "agent", id: agentId, capabilityToken: token },
      origin: "script",
    };
    const allow = await check(agentCtx, { action: "memory.read", scope: scope.path });
    assert(allow.allowed, "valid token + scope + permission → allowed");

    // ── check() denies a wrong token ─────────────────────────────────────────────
    console.log("\ncheck() denies wrong token...");
    const wrongCtx: AccessContext = {
      orgId: org.id,
      actor: { type: "agent", id: agentId, capabilityToken: "wcap_wrongtoken" },
      origin: "script",
    };
    const deny = await check(wrongCtx, { action: "memory.read", scope: scope.path });
    assert(!deny.allowed, "wrong token → denied");

    // ── check() denies after revocation ──────────────────────────────────────────
    console.log("\ncheck() denies revoked capability...");
    await db.capability.update({ where: { id: created.id }, data: { revokedAt: new Date() } });
    const revokedDeny = await check(agentCtx, { action: "memory.read", scope: scope.path });
    assert(!revokedDeny.allowed, "revoked capability → denied");

    // ── check() denies expired capability ────────────────────────────────────────
    console.log("\ncheck() denies expired capability...");
    const expiredToken = generateCapabilityToken();
    const expiredCap = await db.capability.create({
      data: {
        orgId: org.id,
        agentId: "check-agent-expired",
        tokenHash: hashCapabilityToken(expiredToken),
        scopePath: scope.path,
        permission: "read",
        // expired 1 minute ago
        expiresAt: new Date(Date.now() - 60 * 1000),
      },
    });
    const expiredCtx: AccessContext = {
      orgId: org.id,
      actor: { type: "agent", id: expiredCap.agentId, capabilityToken: expiredToken },
      origin: "script",
    };
    const expiredDeny = await check(expiredCtx, { action: "memory.read", scope: scope.path });
    assert(!expiredDeny.allowed, "expired capability → denied");

    // Confirm a non-expired token for the same agent still passes
    const freshToken = generateCapabilityToken();
    await db.capability.create({
      data: {
        orgId: org.id,
        agentId: "check-agent-expired",
        tokenHash: hashCapabilityToken(freshToken),
        scopePath: scope.path,
        permission: "read",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const freshCtx: AccessContext = {
      orgId: org.id,
      actor: { type: "agent", id: "check-agent-expired", capabilityToken: freshToken },
      origin: "script",
    };
    const freshAllow = await check(freshCtx, { action: "memory.read", scope: scope.path });
    assert(freshAllow.allowed, "fresh token for same agent → allowed");

    console.log("\nAll capability token assertions passed ✓");
  } finally {
    await db.org.delete({ where: { id: org.id } });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
