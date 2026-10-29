# The Willder export format

An export is everything you may read of your org's memory, in one file you can read,
parse, keep, and import elsewhere: into a fresh org, another deployment, or the
open-source core. The code is `services/memory/export-format.ts` (the record shapes),
`services/memory/org-export.ts` (writing) and `services/memory/org-import.ts` (reading).

## Getting one

- `GET /api/memory/export` streams the file, named `willder-export-YYYY-MM-DD.jsonl`.
- `npm run selfhost:export` writes the same file from the command line on a self-hosted install, as a person of its org, with no web session ([self-host.md](self-host.md#export-npm-run-selfhostexport)).
  With `--scope team` it holds only `team` and its descendants, as far as that person may read them, and the manifest's `scopes` names only those.
- `POST /api/memory/import` takes that file as the request body and loads it into the
  signed-in org. It answers with a receipt: how many records of each type it wrote.

## Who gets what

| Caller | The export holds |
|---|---|
| A person whose grant covers the org root (an admin) | every scope, the records with no scope, and the audit log |
| Any other member | the scopes their grants let them read and their descendants; no audit log |
| An agent token | nothing: the request is refused and the refusal is in the audit log |

Uploads follow the same rule: an upload is written, with its raw file, only when it is in a
scope the caller can read. Content an erasure removed is never written; see "Erased content" below. Audit rows are
written as the audit log holds them. A member's export holds a dependency edge only when both of its
records are in scopes the member can read. Starting an export writes one row to the audit
log.

Importing needs admin on the target org root, and an org that holds no memory yet: no
facts, rules, notes, briefs, edges, sources or kept uploads. Agent tokens cannot import.

## The file

JSON Lines: one JSON object per line, UTF-8, each with a `type`. The first line is the
manifest and the last is the end record. In between are the data records, all of one
type before the next, in this order: `scope`, `source`, `fact`, `upload`, `convention`,
`working_note`, `brief`, `edge`, `audit`. Each `upload` is followed by its raw file, as
`upload_part` lines and one `upload_end` ("Uploads" below). A record only refers to records
written before it, except `convention.supersededById` and `fact.uploadId`, which an import
links once both records exist. Uploads come after facts because a passage can decide that
an erasure covers its upload, and then the file is never written.

```json
{"type":"manifest","format":"willder-export","schemaVersion":2,"exportedAt":"2026-10-14T21:00:00.000Z","coverage":"org","scopes":[""]}
{"type":"scope","path":"sales","name":"Sales","createdAt":"2026-01-01T00:00:00.000Z"}
{"type":"fact","id":"fa1","scope":"sales","content":"Acme renews in March.","entityName":"Acme","factVersion":true,"role":null,"source":"text","actorType":"agent","actorId":"ag1","actorName":"Scout","sourceId":null,"uploadId":null,"occurredAt":null,"createdAt":"2026-01-01T00:00:00.000Z"}
{"type":"end","counts":{"scope":1,"source":0,"fact":1,"upload":0,"convention":0,"working_note":0,"brief":0,"edge":0,"audit":0}}
```

### Scopes

Every `scope` is relative to the exporting org's root: `""` is the root, `"sales"` a child,
`"sales.eu"` a grandchild. A fact with no scope has `"scope": null` and belongs to the org
root. Data records never name the org they came from; an import places them under the
target org's own root. Audit rows are history and keep their `target` as it was written.

### Records

| `type` | What it is | Notes |
|---|---|---|
| `manifest` | Format name, `schemaVersion`, when, and the scopes covered | `coverage` is `org` or `scopes` |
| `scope` | One scope in the tree | `path`, `name` |
| `source` | A connected source and the files it synced | Credentials are never exported; an import lists it as `disconnected` |
| `fact` | One stored version of a fact | Every version, superseded ones included; `factVersion` says whether it is a version of the fact `entityName` names; `uploadId` is the upload a passage was extracted from, when the caller can read that upload |
| `upload` | A file a person uploaded: `filename`, `fileType`, `actorId` (who uploaded it), `scope` | `file` is `follows` (its raw file is the next lines) or `missing` (kept, but its raw file could not be found) |
| `convention` | A rule or decision, every version | `supersedesId` is the rule it replaced, `supersededById` the one that won a race to replace it, `retiredAt` when it stopped applying |
| `working_note` | A short note an agent posted about work in progress | Expired and released notes are included |
| `brief` | A handoff, architecture plan or QA review | Its content, the facts it cites by section, the sources it was written from, and its retirements (why it stopped being current) |
| `edge` | One edge of the dependency graph: `supersedes`, `derivedFrom`, `dependsOn`, `ownedBy`, `deliveredTo`, `causedBy` | From the newer or dependent record to the one it rests on |
| `audit` | One audit log row | Written for the record; an import never writes another org's history |
| `upload_part` | One piece of an upload's raw file: `uploadId`, `index` from 0, `data` as standard base64 of up to 48 KiB | Not counted in the end record |
| `upload_end` | Closes an upload's raw file: `parts`, `bytes` and its `sha256` in hex | Not counted in the end record |
| `end` | Records written per type | A file without it was cut short |

Ids are the exporting org's. They are stable within one file, so records can refer to each
other; an import gives every record a new id and keeps those references.

### Uploads

An upload's raw file has no other home, so the export carries it. Each `upload` record is
followed straight away by its raw file: `upload_part` lines in order from index 0, then one
`upload_end` with the part count, the byte count and the SHA-256 of the whole file. The
export reads the file from storage as it writes it, one part at a time, and the import
hands each part to storage as a stream as it arrives, so a large file is never held whole
by either. A file whose `upload_end` is missing, or
whose parts disagree with it, is refused.

An upload that is kept but whose raw file storage no longer has is written with
`"file": "missing"` and no parts, so the export says what it lacks; an import cannot restore
it and counts it in the receipt as `uploadsWithoutFile`. An upload removed while the export
runs is left out when the removal is marked before the export reaches that upload: the export
checks again just before reading its raw file. A removal marked after that check, while the
file is being read, does not stop the file being written. A passage whose upload is not in the file (left out as erased) still names
it by `uploadId`; an import leaves that passage pointing at no upload.

The import stores each raw file under the target org as its parts arrive, and records the
upload once the file matches its `upload_end`. An import that fails deletes every raw file it
stored.

### What is not in it

- **Embeddings.** They are derived from the text, so an import computes them again with
  its own model. The same model gives the same search results.
- **People, roles and grants.** Who may read what is decided by the target org's own
  members and grants.
- **Graph facts held only in the knowledge graph.** The graph store keeps entities and the
  relations extracted from ingested text; an import rebuilds them only when that text is
  ingested again. Facts stored for search are exported in full.
- **Change feed, read receipts and task-start bookkeeping.** These record what agents were
  shown in the exporting org, not what the org knows.

## Importing

The import reads the file a line at a time and checks every record before writing it. It
refuses, and leaves the org as it was, when:

- the first line is not a `willder-export` manifest of a schema version it reads;
- a line is not JSON or not a valid record, a scope is not a valid path, or an id repeats;
- the end record is missing, or its counts disagree with the records in the file;
- a record comes after records of a type that follows it in the order above;
- an upload's raw file is cut short, out of order, or disagrees with its `upload_end`, or a
  part holds more than 48 KiB;
- a schema version 1 file holds an upload;
- the org already holds memory, or the caller is not its admin.

An import is a restore, so the target org's erasures apply to it as they do to an export,
by the same rule ("Erased content" below). A record they cover is left out and counted in
the receipt under `erased`. Exporting, erasing a person and importing the earlier file back
therefore does not bring them back.

An edge whose two ends were not both imported (possible in a member's scoped export, or when
one end was left out as erased) is skipped and counted in the receipt as `skippedEdges`.

Once every record is written, the import re-applies the org's erasures
(`services/memory/erasure-reapply.ts`) and reports what that pass removed as
`erasuresReapplied`. `imported` counts what was written before that pass. The pass catches
facts and rules covered by an erasure that started after the import loaded its filter, and
erases again any contact a database restore put back in the org. It reaches briefs and
working notes only where `erasure-reapply.ts` has passes for them. If the pass fails, the
import is undone and answers 503: the file is fine, and importing it again is safe.

The receipt is `{ imported, erased, skippedEdges, auditRowsNotImported, uploadsWithoutFile, erasuresReapplied }`.

## Erased content

The export and the import judge a record by one rule, `services/memory/export-erasure.ts`,
against the org's suppression list (`services/memory/erasure-suppression.ts`). A record
written at or before the latest erasure of a person it names is covered. A person erased,
added again and erased again is covered up to the second erasure, which removed everything
naming them that was written in between.

| Record | Covered when |
|---|---|
| `fact` | its text names the person, it is filed under their name, or its id is a version the erasure removed; a passage of an upload counts as written when its file was uploaded, if that is earlier |
| `convention` | its subject or text names the person, or its id is a rule the erasure redacted |
| `working_note` | its task or body names the person |
| `brief` | its text names the person (title, summary, diagram, grantee and scope label as written; sections, milestones, charts and decisions as JSON), or a citation's stored text names them, or it cites a version the erasure removed |
| `upload` | its filename names the person, as text or as a whole name (`Jordan_Example_offer.pdf` and `JordanExample offer.pdf` both do), or one of its passages is covered; a raw file cannot be redacted, so the whole file stays out, as the erasure deletes it |

An export judges an upload by every passage of it, including passages in scopes a member
cannot read, so a member and an admin leave out the same uploads. A passage holds its file's
text, so it is judged as written when the file was uploaded: a file uploaded before an
erasure whose passages were extracted after it is still covered. An import
judges an upload by its filename and by the passages in the file before it, and never
stores the raw file of one it leaves out. It writes each passage judged by its own time,
before its upload's record arrives, so when the upload arrives it removes the passages of it
covered as of the upload's time and counts them as erased. The pass that re-applies erasures
after an import also removes an upload whose filename or passage, judged the same way, an
erasure covers; the raw file of one the import kept was stored by then.

A brief that paraphrased the person away still goes when a fact it cited named them, as the
erasure itself deletes it. Scopes, sources and audit rows are never covered. Record ids are
the source org's, so an id match only fires in the org the export came from; an export
imported into another org is filtered by that org's own erasures, which matches names and
addresses but not ids.

Known limits, shared with the erasure itself: a name inside a brief's JSON columns split by
a line break is stored escaped (`\n`) and is not matched there; a brief's `createdAt` comes
from the app server's clock, so one written by a server running ahead of the erasing one can
read as newer than the erasure.

## Compatibility

`schemaVersion` changes when a record changes in a way an older reader would misread. An
import reads its own version and every earlier one, and refuses a later one rather than
guess. Version 2 added uploads, their raw files and `fact.uploadId`; a version 1 file has
none of them and imports as it always did.
