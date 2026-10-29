# Consent and deletion suite

What this suite proves: Willder ingests a
person's or a team's data only after someone with the right scope connects it,
stops serving it once they disconnect, can erase one person on request, and
never shows personal data across a scope. Pass bars are numbers. A bar that cannot be measured yet
says so, along with what has to exist first.

State on 2026-10-01: two bars are measured and pass on the vector store (bar 4,
and bar 3 with one named limit). Two had partial coverage with named holes (bars 1
and 2); a later change targets those holes, but the rows below have not been
re-measured against it yet.

## Bars

| # | Bar | Pass bar | Status 2026-10-01 |
|---|---|---|---|
| 1 | No ingest without a connection | 0 facts, chunks or episodes written for a source that is missing or disconnected at write time, on every connector write path | Partial. Text connectors and Drive re-check the source row per item. `lib/inngest.disconnect-mid-sync.realdb.test.ts` measures 0 retrievable after a mid-sync disconnect. Holes listed below. |
| 2 | Disconnect retires everything derived | After `DELETE /api/sources/:id`, 0 facts, chunks, episodes, verbatim fact nodes and derived records traceable to the source are retrievable, within one sync | Partial. Facts (edges) and chunks are retired by source id in every scope the source wrote to. Episodes, entity summaries, verbatim fact/passage/decision nodes, MENTIONS edges and derived briefs survive. |
| 3 | Right to delete one person | One request leaves 0 contact rows, chunks, graph nodes, edges, episodes and snapshots naming the person, and they stay deleted after the next sync | **Pass on the vector store, one named limit.** The erasure path (`services/memory/person-erasure.ts`, PRs #316 and #317) exists. After one request and one Drive re-sync, 0 of 16 probes by email or name returned the person, across a sales, support, denied and org-root reader, each with a positive control (`services/memory/consent-erasure-probe.realdb.qa.test.ts`). Limit: a passage naming the person only by phone number is still served. Graph store read path not covered here. |
| 4 | Personal data stays in its scope | Cross-scope personal-data probes leak 0 of N, with a positive control per caller | **Pass on the vector store**: 0 of 30 probes leaked (`services/memory/consent-pii-scope.realdb.qa.test.ts`). Graph store not covered. |

## Bar 1 holes: connector writes without a write-time source check

- `fileIngest` (`lib/inngest.ts`, the legacy event) checks the source once in
  `verify-source-scope`, then writes the vector store and the graph in later steps
  with no re-check. Nothing purges after a late write.
- `processDriveFile` checks once per file, before both writes. There is no re-check
  between the graph write and the vector write.
- Closed for `memoryIngest`, `runMemoryIngest` and `ingestMemory`: an ingest naming a
  source id writes nothing unless that source has a connect row in the ingest's org,
  not disconnected, at the scope the ingest writes into
  (`ingestSourceIsConnected` in `lib/inngest/source-state.ts`, which the file job
  shares). Proven per job, with a control, in
  `lib/inngest.ingest-without-connection.realdb.test.ts`. The two jobs also check
  again after their last write and remove what the source wrote into the scope when
  it is gone, and a refused job removes the row the request path stored before
  queueing, so a disconnect that lands between the first check and a write leaves
  nothing (same file, "a disconnect that lands while a memory write job is
  writing"). Still open: the memory service's `/ingest` accepts any `source_id`; it
  is reached only by the app with the service's API key, after these checks.
- The window between the check and the write stays open on `processDriveFile`, and
  the source route documents one more on every path: a write the memory service
  applies after a timed-out request.

## Bar 2 holes: what a disconnect leaves behind

- Episodic nodes, which hold the raw ingested body.
- Fact, Passage and Decision nodes, which store the source text verbatim as their
  summary. Only their edge is removed.
- Entity summaries and MENTIONS edges. Entities are kept on purpose because two
  sources can mention the same person, but their summaries can quote the removed
  source.
- Content ingested before the source-id marker existed, and edges pruned under the
  old rule. These are known limits.
- Briefs, contacts and accounts built from the source's content.
- `DELETE /api/integrations/:id` revokes the token and retires nothing. Deleting an
  org cascades its Source rows without running retirement.

## Bar 3: what an erasure path has to do

The tests are written against this contract:

1. Input: an org, a person identifier (contact id, email or entity id), and a caller
   with `access.manage` on the org root. Anything less is refused and audited.
2. Removes the contact row and scrubs the idempotency ledger's frozen
   `resultSnapshot` for that contact.
3. Removes every vector chunk whose content, or the entity name it is stored under,
   names the person, in every scope. The contact-edit path ingests these untagged at
   the org root; memory_ingest stores a fact under its entity's name, so its text may
   only say "She ...".
4. Removes the person's entity node in every partition, their edges, and every
   episode (by its body or its name) and verbatim fact node that names them. Then it
   re-summarises the entities that quoted them, or drops those summaries. An entity
   or verbatim fact node whose only links were those episodes and edges goes too,
   whatever its name, so its id no longer resolves; one a bystander's record still
   links stays. That includes a new role holder whose only facts were copies naming
   the person (an org role handed over by `transfer_entity_edges`). The scope's shared
   fallback anchor is never removed.
   "Names the person" means, in text, an email or a name of two words or more as a
   whole identifier, never inside a longer one: erasing "Al Li" leaves "Sal Lin" and
   "Al Liú", erasing dan@acme.com leaves jordan@acme.com, erasing "Dana Whitfield"
   leaves "Dana Whitfield-Barnes" and "Mary-Dana Whitfield". A hyphen or en dash joins a
   name to another only between two words (an em dash is punctuation, so "Dana
   Whitfield—she signed" names her), and never before a modifier word on a short list
   (`NAME_MODIFIER_WORDS` in `services/memory/person-name-characters.ts`), so "the Dana
   Whitfield-approved budget" and a "-Dana Whitfield" bullet are erased. A modifier not on
   the list ("Dana Whitfield-friendly") is still read as a longer surname and kept (an
   under-erasure). A name's words may be separated by any whitespace.
   Text is never read surname first: read that way, "Attendees: Wei Li, Ann Chen" and
   "Li Ann Tan" would name "Ann Li", so "Whitfield, Dana owns the renewal." is missed
   instead (an under-erasure, chosen over that over-erasure). A name is also found
   written without spaces, its words joined by `_`, `.`, hyphens or a camel-case step
   ("Dana_Whitfield_offer.pdf", "DanaWhitfield offer.pdf", "anne-marie_dupont.pdf" for
   Anne-Marie Dupont), under the same rule: never inside a longer word, never joined by a
   hyphen to another word ("Dana_Whitfield-Barnes_CV.pdf", "anne-marie_laval_cv.pdf" for
   Marie Laval), and never by hyphens alone where her own name has whitespace, as another
   person's double surname or compound given name is written ("(Dana-Whitfield, 2019)",
   "jean-pierre dupont" for Jean Pierre Dupont). Where her own name has a hyphen, only a
   space within a line stands for it: a tab or a line break ("Anne", tab, "Marie Dupont")
   parts two entries. Where a spelling of hers is also how
   another person is written, it is missed ("dana-whitfield.pdf", a login "dana-whitfield"):
   an under-erasure, chosen over that over-erasure
   (`services/memory/person-name-characters.ts`, `joinedNamePattern`). One spelling is
   the other way round: her whole name run together with nothing between its words
   ("danawhitfield", "DANAWHITFIELD", "RoryMcDonald2026", "siobhanobrien" with her
   apostrophe left out), when that is at least 8 characters, is read as hers anywhere; a run
   of 6 or 7 characters is read only right beside an "@" ("tomlee@corp.example", "@kitchen"
   for Kit Chen) or as a record's whole name (`SHORT_RUN_MARK`), never in prose ("Coffee is in
   the kitchen.") or code ("window.location", "window_start"), because 102 of 200,000 real
   first-name and surname pairs run together into a common 6- or 7-letter word: read beside
   "_", a digit or a ".", erasing Win Dow still deleted 113 of 14,657 third-party code records.
   The cost: her short name in a file name or a login is missed ("tomlee_cv.pdf",
   "2026tomlee"). Each is read with the same edges (never inside a longer word, never hyphen-joined to another),
   and so is her name run together up to a hyphen of her own ("marialopez-garcia" and
   "maria_lopezgarcia" for María López-García, "kimji-woo" for Kim Ji-woo; `joinedNames`),
   never with whitespace between its words ("Albert Smith" in prose is not Al Bert-Smith; a
   name with two hyphens is not run together across one of them).
   A word spelled the same, another person's one-word name ("Annmarie" for Ann Marie,
   "annemarie_dupont" for Anne-Marie Dupont, "albert_smith" for Al Bert-Smith) or a common
   word ("willpower" for Will Power; "@window" for Win Dow), is erased with her, an over-erasure accepted because the
   run-together form is common in logins, handles and file names; a shorter run ("annli" for
   Ann Li) is not read as hers (`concatenatedNames`). Digits right before a name written
   without spaces do not hide it ("2026danawhitfield.pdf", "2026Dana Whitfield.pdf"), and a link's "%27" or "%E2%80%99" reads as an
   apostrophe as its "%20" reads as a space ("siobhan_o%27brien.pdf"). Her name as ASCII
   spells it, accents left off, the letters `ASCII_LETTERS` lists ("ß", "ı", "ø", "ħ" and the
   like) spelled out and a Unicode hyphen written "-", is hers too, in every form ("Zoe Ferrand" and "zoeferrand" for Zoë Ferrand, "hansweiss" for Hans Weiß,
   "ayseyilmaz" for Ayşe Yılmaz; `asciiSpelling`): it erases another person whose name is
   spelled without the accent, accepted because logins and file names are mostly ASCII.
   `services/memory/name-run-together-forms.json` holds the cases the app and the graph are
   both tested on. Names,
   addresses and the text they are looked for in are compared folded (NFKC, lowercase,
   NFC, a curly apostrophe straight), so an accent typed as a combining mark matches the
   precomposed letter and fullwidth letters match their ASCII forms. A record's own
   name (the entity a chunk is filed under, an episode's or an entity's name) matches
   only the person's whole name or address, in either order, or her whole name written
   without spaces ("dana_whitfield", never "dana-whitfield"): a record filed under
   "Mary Ann Li" or "Dana Whitfield Foundation" is another's, and goes only if its own text names the
   person. An honorific with the surname alone ("Ms. Whitfield") is not matched.
4a. Removes every version written in place of one it removes, and in place of those, whatever
   that version's own text says: a correction of a fact about the person ("Based in Denver",
   filed under a correction's own name), an update based on their version, and a connector
   item's upstream edit, for a Drive file its whole new version
   (`services/memory/erasure-lineage.ts`). A conflict's or a stale write's winner, stored before
   the version it beat, stays. A version whose announcement named them (a Drive file named
   after them) goes whole. Each removed version takes its graph copy, the text of every change
   event about it, and the briefs that cite it, and goes on the suppression list by its id. A
   person's correction of a brief the erasure deletes goes with it, and a queued correction of an
   erased version withdraws itself when its job runs. The
   rule errs toward erasure: a correction that took the person's name out of a fact goes too.
4b. Redacts every rule (convention or decision) that names the person, in its subject or
   text or as its whole subject, in every scope, and every rule version written in place of
   one (`services/memory/erasure-rules.ts`). Redacted means the subject and text are blanked
   and the rule is retired, so it is never served at task start again; the row stays so the
   versions it replaced stay out of service. A rule's fact copy, the text of its change events
   and the task-start log's rows naming it go with it, and its id goes on the suppression list,
   so re-applying erasures after a restore redacts it again. A version that lost a race to
   replace a rule is not written in place of it, and stays.
   The person's names and addresses include the aliases registered for their contacts in the
   alias registry (or under their canonical name), when an alias is an address or a name of two
   words or more; those registry rows are removed with the contacts. A one-word nickname is
   never erased by.
4c. Deletes every working note, live or ended, whose task or body names the person, in
   every scope, each with a `delete` change event as a release has, so it leaves the
   task-start block, the Explore list and notices, and a later release of it finds nothing
   and writes no event. A post after the erasure that names the person is a new act. This runs in the last transaction, over the
   whole org: a renewal rewrites an older note's body, so a note's creation time does not
   say when it last named anyone.
5. Records one audit row that names the request, never the deleted values, and on
   completion one `person.erased` row with how many records each store removed. A
   request sent again after one failed part-way writes that one row with the failed
   attempt's counts included and its request id named (`earlierRequestIds`); each
   step that committed on its own left a hidden counts-only `person.erasure_step` row
   for this. A request for a person with no contact row is not linked to an earlier
   attempt and counts only its own removals.
6. Is idempotent. A second call removes 0 and succeeds. A request that failed
   part-way is completed by sending it again: the connector records' pointers to the
   person's graph episodes are dropped before the graph erases them, from the graph's
   own plan (`POST /people/erase/plan`), so a failure after the erase cannot strand one.
   Content written naming the person while the request runs is removed by its last
   transaction (chunks and briefs created since it started, change events committed
   since the summaries were scanned); a write that commits after it is a new act.
7. Pass bar: after one call and one connector re-sync, a probe by email, by name and
   by phone returns 0 hits from both stores for every caller, including an org-root
   reader.

## Bar 3: what is measured

`services/memory/consent-erasure-probe.realdb.qa.test.ts` asks the read path the
pass bar's question (point 7 above). Items 1 to 6 are proven row by row in
`services/memory/person-erasure.realdb.test.ts` and
`services/memory/person-erasure-aftermath.realdb.test.ts`.

- Real: Postgres with pgvector, `check()`, `erasePerson`, the suppression list,
  `processDriveFile`'s chunk writes, the guarded store, hybrid routing and vector
  SQL. Test doubles: the graph store (reads answer nothing; the graph erasure is
  proven on Neo4j in `memory-service/tests/test_person_erasure_integration.py`)
  and embeddings (every vector is identical).
- One person is seeded in a support scope, two sales passages (one by email in
  upper case, one by name), untagged at the org root (the contact-edit shape), and
  once by phone only. Two bystanders, and the same identity in another tenant.
- Before the erasure the org-root reader's four probes return all four passages
  naming her. After one request and one re-sync of a changed Drive file that
  names her, 0 of 16 probes return her email or name. The re-sync writes only the
  file's other passage. The other tenant's customer is still served. A second
  request removes 0 chunks. A refused request changes nothing.
- Named limit, measured: the phone-only passage is served on all 4 org-root probes
  after the erasure. `services/memory/person-erasure.ts` documents that phone numbers and
  nicknames are not matched.
- Guard removals, one at a time, each fail the suite: chunk deletion limited to
  the untagged partition (3 tests), its tenant predicate dropped (2), the Drive
  re-sync's suppression filter removed (2), case-sensitive matching (2), the
  `access.manage` check skipped (1). Each guard was restored and the suite passed.

Case types: normal, edge and error, all on the memory side. Not covered: long,
user side, and the graph store's read path. The fixture is synthetic, so this is
a unit-level measure.

## Bar 3: after a re-sync and after a backup restore

The rule: an erased person still returns nothing after a re-sync and
after restoring the latest backup.

**Re-sync** is measured from outside. The measure seeds a
disposable person in a GitHub issue of a scratch repository, connects the repository,
and erases the person. It then re-syncs the source unchanged, and again after editing
the issue and opening a second one that does not name them. The person must answer
nothing on the vector, graph and contact paths after each re-sync, and the second
issue must answer after the edited re-sync. That last check is what proves the
re-sync ran.

**A restore cannot be exercised from outside**, and nobody can run one against
production without taking it offline. What makes it safe is a procedure plus three
pieces of product behaviour, all proven together in
`services/memory/person-erasure-restore.realdb.test.ts`:

- **Read.** The vector read path, the task-start block, `memory_version` and the
  Explore page's chunk list (`GET /api/memory/stores`) never serve a chunk that names
  an erased person and was written at or before that erasure
  (`loadErasedContentFilter`): by its text, by the entity it is filed under being
  the person's whole name or address, or by its id being a version the erasure removed,
  such as a correction written in place of a fact about them. Content written after the erasure, such as a
  person re-added on purpose, is served as before. A fact filed under a person erased
  before record-name digests existed, whose text never names them, is still served
  after a restore: that erasure recorded no digest of the person's name in the form a
  record's name is matched, and no plaintext is kept to add one. Step 3 removes it only
  if the person's contact came back with it.
- **Re-ingest.** A connector re-sync of a restored record writes nothing naming the
  person. An unchanged item is skipped by its checksum, and any item the sync reaches
  is stopped by the suppression list.
- **Re-apply.** `reapplyErasures` (`services/memory/erasure-reapply.ts`) erases a
  restored contact again through the full erasure, which reaches the graph with the
  contact's own address and name. A contact is the person's by its whole address, or,
  when it has none, by being a row the erasure removed (its id, which a restore keeps);
  a contact whose name only contains theirs, or that has their name and another
  address or no address, is someone else's and is left alone. An erasure recorded
  before contact ids were kept re-erases no restored contact without an address. It
  deletes restored chunks no contact names, by their text, the name they are filed
  under, or their id as a version an erasure removed. A second run removes nothing.

The suppression list holds digests, not the person's values, so these paths cannot run
the erasure's own regular expressions. They emulate them, and
`services/memory/erasure-rule-agreement.realdb.test.ts` runs one table of cases through
both, chunks and contacts alike. Both rules read a name by the same characters
(`services/memory/person-name-characters.ts`) and fold it by one rule first (`foldName`:
NFKC, Unicode's lowercase whatever the database's collation, i and a combining dot above
(the Turkish dotted capital I) read as i, NFC, a final sigma read as σ), and they agree
on every row of the table. Each engine knows the Unicode version it ships (production's
Postgres lowercases with ICU at 15.1, Node may know 17.0), so the letters Unicode added
after 15.0 that the fold changes are read from one list by both
(`services/memory/name-fold-newer-letters.json`), in the plain reading, the camel-case reading
and the address pattern, and the same test folds every code point in both and expects no
difference; the graph folds those letters as its Java version does. The spellings that once set the engines apart (the dotted and
dotless i, final sigma, sharp s, ligatures, fullwidth letters, combining marks) are in
`services/memory/name-fold-spellings.json`, which the graph's erasure is held to as
well. Rows that agree include text and names spelled decomposed (NFD), lists of people
that read surname first would name the person, and a contact without an address, judged
by the id of the row the erasure removed. Not in the table: a contact with another
address that the erasure linked to the person only by graph entity is judged by that address, which
the list does not hold, so re-apply removes it only when the person's own restored
contact, erased again, links it.

All three depend on the suppression list being present. A backup taken before the
erasure does not hold the erasure's suppression rows. The suite's negative control
restores the list from the same backup and shows that the person is served again.

### Restore procedure

Steps 1 and 2 are the operator's: a restored database cannot know about erasures made after
its backup until their suppression list is copied back. Step 3 happens on its own.

1. **Before restoring**, export the live database's suppression list. It holds
   digests only, never a value, so the copy is safe to keep:
   `\copy (SELECT * FROM erasure_suppressions) TO 'erasure_suppressions.csv' CSV HEADER`.
2. **Restore** to a new database or branch. If the backup is older than migration
   `20261019100000_erasure_reapply_due`, run `npx prisma migrate deploy` against it first:
   without that migration's trigger the copy-back below marks nothing, and without its table
   `check()` fails on every request. Before it serves traffic, put the list back
   through a staging table, so a row the backup already holds is kept as it is:
   `CREATE TEMP TABLE staging (LIKE erasure_suppressions);`
   `\copy staging FROM 'erasure_suppressions.csv' CSV HEADER`
   `INSERT INTO erasure_suppressions SELECT * FROM staging ON CONFLICT ("orgId", kind, digest) DO NOTHING;`
   The restored rows keep their original `createdAt`, and the read filter compares
   against it.
   **This copy-back is what tells the database a restore happened.** The app writes the list
   only inside a transaction that sets `app.erasure_listing`
   (`services/memory/erasure-suppression.ts`, `listingInThisTransaction`); a trigger on
   `erasure_suppressions` takes any other insert, this one included, for a copy-back and marks
   the org due for a re-apply (`erasure_reapply_due`, migration
   `20261019100000_erasure_reapply_due`). Every org the copy-back holds an entry for is marked,
   including entries the backup already held: a backup taken while an erasure ran holds that
   erasure's entries without their applied markers. An org with no entry in the copy is not marked.
   The trigger fires however the rows go in: psql's `INSERT` or `\copy`, a loader that empties
   `search_path` first as pg_dump's output and pg_restore do (the trigger names every object
   with its schema), and a session with `session_replication_role = replica` (it is an
   `ENABLE ALWAYS` trigger). Copy back through the staging table above, or with
   `pg_dump --data-only --inserts --on-conflict-do-nothing -t erasure_suppressions`: a plain
   `COPY` of the whole list (`pg_restore --data-only`, pg_dump's default output) fails on the
   first entry the backup already holds, rolls back, and copies nothing. **Never copy the list
   back with triggers disabled** (`pg_restore --disable-triggers`, or `ALTER TABLE ... DISABLE
   TRIGGER`, which the table's owner can run as well as a superuser), and never set
   `app.erasure_listing` at the database, role or session level on the restored database
   (`ALTER DATABASE ... SET`, `ALTER ROLE ... SET`, `PGOPTIONS`): either makes the copy-back
   mark nothing, and the org serves its restored rows as if no restore had happened.
   From that commit until the re-apply finishes, `check()` refuses everything in a due org but
   `access.manage` (which the re-apply needs), for people and agents alike, with a reason that
   says the restore is not complete and names the fix; connector syncs of the org write nothing
   (`lib/inngest/connector-sync.ts`) and run again on their schedule. The check rides on the
   grants or token lookup `check()` already makes, so a read costs the same statements as
   before (`services/memory/restore-completion.realdb.test.ts`).
   What this does not cover: a restored database serves what its backup holds until step 2
   commits, so it must not take traffic before then; skipping step 2 leaves the database with
   no record of the later erasures at all (the negative control above); a copy-back with triggers
   disabled, or with `app.erasure_listing` set outside a transaction, marks nothing, and nothing
   else notices it, since the app keeps no record of which list entries it wrote itself to
   compare against; a logical-replication subscriber of this table (none exists today) would
   fire the trigger for every row the primary lists, so every org that ever erased anyone would
   read as due on it; an org whose re-apply
   cannot finish (no owner, admin or root admin grantee on the restored grants, or a store that
   keeps failing) stays refused, and the job logs it every ten minutes, until an operator fixes
   the cause and the next run completes it; and reads that do not pass through `check()` are not
   refused: the credentials in the README's "Credentials that bypass the authorizer", and the
   listings that filter by `readableScopePaths` after their own check, such as the uploads list
   (`GET /api/memory/uploads`), which can name a restored upload's filename until the re-apply
   removes it.
3. **The restore completes itself.** Every ten minutes the restore-completion job
   (`lib/inngest/person-erasure.ts`, `restoreCompletion`) re-applies the erasures of every due
   org (`completeRestore` in `services/memory/erasure-reapply.ts`) and, once the org's whole list
   reads as applied, ends its due row in the same transaction; its reads and syncs then work
   again. An entry copied back while a re-apply runs keeps the org due until the next run covers
   it. The job needs the deployment's Inngest and `GRAPHITI_SERVICE_URL`/`GRAPHITI_SERVICE_API_KEY`;
   a restored database with no Inngest (a local or scratch copy) stays refused until the
   operator runs the same pass by hand:
   `DATABASE_URL=<restored> bash scripts/run-check.sh scripts/complete-restore.ts`, which also
   finishes it at once instead of within ten minutes.
   The pass re-applies every org's erasures (`completeRestore` in
   `services/memory/erasure-reapply.ts`), each as one of that org's owners, admins, or members
   holding an admin grant on its root, whom `check()` allows on the restored grants, and marks
   every list entry it covered as applied (`markApplied`), only once the whole pass is done.
   The restore is complete only when it prints `"restoreComplete": true` and exits 0; if it
   stops part-way, run it again. The graph erasures need `GRAPHITI_SERVICE_URL` and
   `GRAPHITI_SERVICE_API_KEY`. (`scripts/reapply-erasures.ts <orgId> <adminUserId>` runs the
   same pass for one org as a named admin.)
   The restore brings back the applied markers (`erasure_suppressions_applied`) as the backup
   holds them, so the entries step 2 copied back read as not applied (`erasuresAppliedSql`) until
   the re-apply has run; memory_query's no-visible-match note stays absent in such an org
   (`services/memory/readable-values.ts`), as it does while a live erasure runs, and
   The restore stays blocked until then. Copy back only the suppression
   list, never the applied markers: copying them would mark entries applied that this
   database has not carried out. A person added again after their erasure (a contact
   created later with the same address or name) is not erased again: the full erasure
   matches by value and would remove the re-add too. Their restored contact row is
   deleted and their restored chunks are removed by time; the run reports how many as
   `reAddedContactsRemoved`, and anything else the backup put back for them (graph,
   ledger snapshots, change-feed summaries) is the operator's call. Restored briefs and
   working notes naming any erased person are deleted again by time, whether or not
   their contact came back (`briefsRemoved`, `notesRemoved`). The run marks its entries
   applied only after those passes, in the transaction that deletes the briefs and notes,
   and never an entry another erasure of the same person listed again while it ran: that one
   stays not applied until its own erasure finishes. Listing a person and marking entries
   applied take one per-org lock, so a listing never commits between a marker's read of the
   list and its commit (`erasure-suppression.ts`, `lockAppliedMarkers`), and a listing's time
   comes from the database clock under that lock, later than every earlier listing's, so the
   clocks of the app instances never order two erasures.
   One gap is accepted: an erasure that starts while an import is writing can finish, and the
   org read as applied, while the import still writes rows naming that person, until the
   import's own closing re-apply removes them (a failed re-apply undoes the import). In that
   window the check can only withhold the note, never claim one falsely: imported chunks keep
   their exported `createdAt`, so the read-time filter already leaves them out of what the
   check counts, and an imported note or rule naming a value makes the check count it as held.
   **Once, when migration `20261016070000_erasure_suppressions_applied` is deployed:** it marks
   applied only the entries known to be carried out (a request with its `person.erased` row,
   for an address or name entry only when no erasure that has not completed started at or
   before the entry's time, so never one an unfinished erasure listed again; a redacted
   rule; a withdrawn correction). An org with an erasure that failed or was running then
   reads as not applied, and its no-visible-match note stays absent until that is finished:
   run `scripts/complete-restore.ts` against the database once after the deploy; it re-applies
   every such org and exits 0 when none is left.
4. **Graph backups are separate.** If the memory service's graph is restored to a
   point before an erasure, step 3 reaches the person only through a restored
   contact, because the suppression list cannot name anyone. A person with no
   contact row must be erased again from the identifiers on the original request
   (`POST /api/access/erasure {email}`). Restore the graph to a point after the
   latest erasure whenever one exists.
5. **Verify** with the product's read paths on a disposable
   person erased before the backup was taken, or with a known erased address if the
   operator holds one.

Residuals: the read filter covers the vector store's search (`retrieve`), the
task-start block, `memory_version` and the stores overview's chunk list, not the
vector store's other reads (`findFactById`, conflict reads), the overview's chunk count
or its contact list, or change-feed summaries the backup put back, so a restored row is
reachable there until step 3 removes it: do not serve traffic before step 3. Restored ledger snapshots and change-feed summaries are scrubbed
only for a restored contact, by its full erasure in step 3. One whose contact did not
come back is not re-scrubbed. Content naming a person only by phone was never erased,
so a restore changes nothing for it.

## Bar 4: what is measured

`services/memory/consent-pii-scope.realdb.qa.test.ts` runs against real Postgres
with pgvector. The access check, guarded store, hybrid routing and vector SQL are
all real. The graph store and embeddings are test doubles, and every vector is
identical, so only the access predicates decide what comes back.

- Four people are seeded: one in a support scope, one in a sales scope, one
  untagged at the org root (the shape a contact edit ingests), and one in another
  tenant under a textually identical path.
- Six probes per caller name a person by email, by name, or not at all. Each full
  response is searched for every marker (name, email, phone), including the text
  of any denial.
- The callers are a sales reader, a support reader, a reader denied a scope, an
  org-root reader and the other tenant. Each one's permitted person must appear.
- Result: 0 of 30 probes leaked. Removing the tenant predicate, the untagged gate
  or the scope containment (one at a time, in `services/memory/pgvector-store.ts`)
  fails 2 tests each.

Case types: normal, edge and error, all on the memory side. The suite does not
cover long or user-side cases, or the graph store. The fixture is synthetic, so
this is a unit-level measure. A rerun on the scrubbed helpdesk slice is the
workload version.

## Related open defects

- An untagged graph fact cannot be deleted through any route.
- A disconnected source's orphan fact still answered on a real org.
- `/api/contacts/:id` GET, PATCH and DELETE run no access check. Its only caller
  page is gone; the route is due for deletion.
