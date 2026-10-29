-- Working notes: short-lived lines agents post about what they are doing right now
-- (services/memory/working-notes.ts). A new type and a new table; no existing table
-- or column changes.

CREATE TYPE "WorkingNoteKind" AS ENUM ('claim', 'intent', 'status', 'question');

CREATE TABLE "working_notes" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "scopePath" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "task" TEXT NOT NULL,
    "kind" "WorkingNoteKind" NOT NULL,
    "body" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "working_notes_pkey" PRIMARY KEY ("id")
);

-- Every read asks for the notes still live in one org: expiry is the selective column.
CREATE INDEX "working_notes_orgId_expiresAt_idx" ON "working_notes"("orgId", "expiresAt");

-- Readers spell scope containment in `mode: "ltree"`, served by a GiST expression
-- index, as for conventions and change_events.
CREATE INDEX "working_notes_scopePath_gist_idx" ON "working_notes" USING gist (("scopePath"::ltree));

ALTER TABLE "working_notes" ADD CONSTRAINT "working_notes_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
