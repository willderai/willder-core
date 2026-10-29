// Episode cap — live check. Run with: bash scripts/run-check.sh scripts/check-episode-cap.ts
// Exercises checkEpisodeCap/recordEpisode on a throwaway org, then cleans up.
import { db } from "@/lib/db";
import { checkEpisodeCap, recordEpisode, GuardrailError } from "@/services/guardrails";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error("FAILED: " + msg);
  console.log("  ✓ " + msg);
}

async function main() {
  const org = await db.org.create({
    data: { name: "episode-cap-test-org", plan: "free", episodeCapIncluded: 2 },
  });

  try {
    await checkEpisodeCap(org.id);
    assert(true, "free org under cap (0/2) passes");

    await recordEpisode(org.id);
    await recordEpisode(org.id);

    let threw = false;
    try {
      await checkEpisodeCap(org.id);
    } catch (e) {
      threw = e instanceof GuardrailError && e.code === "episode_cap_exceeded";
    }
    assert(threw, "free org at cap (2/2) throws episode_cap_exceeded");

    await db.org.update({ where: { id: org.id }, data: { plan: "founder" } });
    await checkEpisodeCap(org.id);
    assert(true, "founder org past the free cap number is not gated");

    console.log("\nAll episode cap checks passed.");
  } finally {
    await db.org.delete({ where: { id: org.id } });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
