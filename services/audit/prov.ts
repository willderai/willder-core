// One memory change as a W3C PROV-JSON document (https://www.w3.org/submissions/prov-json/),
// so the four answers the audit trail gives about a fact -- who wrote it, from what source,
// who read it, and what it replaced -- can be handed to any PROV tool.
//
// The one rule this file enforces: the document states exactly the answers it is given and
// nothing more. It carries ids, names, scopes and times, never the fact's text, and every
// statement maps to one answer:
//
//   author    the change (an activity) generated the version (an entity), which is
//             attributed to its writer; the writer is associated with the change, and the
//             association names the audit row that authorized it. For a connector sync the
//             writer acted on behalf of the person who connected the source (delegation).
//   source    the version was derived from the connected source (prov:PrimarySource).
//   readers   each reader's first read (an activity) used the version.
//   replaced  the version was derived from each version it replaced, and the version that
//             replaced it was derived from it (prov:Revision). A lineage that loops (the
//             version replacing itself, or replacing the version that replaced it) has no
//             valid PROV: a derivation cycle orders a generation before itself
//             (PROV-CONSTRAINTS 42). Such data is a defect, so no revision is stated between
//             the versions in the loop, and each is marked willder:lineageLoop instead.
//
// Pure: GET /api/audit/timeline/:changeId/prov gathers the answers and this builds the
// document.
import type { AuthorizationKind } from "@/services/audit/actor-names";
import type { ActorType } from "@/types/memory";

/**
 * The namespace every identifier in the document is minted under. It is an identifier,
 * not a page: PROV needs a stable absolute IRI to tell Willder's names apart from anyone
 * else's, and nothing ever fetches it, so the URL does not have to resolve. It never
 * changes, because an exported document names its records under it and a consumer joins
 * documents on those names.
 */
export const PROV_NAMESPACE = "https://willder.ai/ns/prov/";

/** An actor as the audit trail records it: a person, an agent, or the system itself
 * (`extraction`, e.g. a connector sync). */
export interface ProvActor {
  actorType: ActorType;
  actorId: string;
  name: string;
}

/** The four answers about one change, as the audit API gives them. */
export interface ChangeAnswers {
  change: { id: string; op: string; at: string; recordType: string; recordId: string; scopePath: string };
  author: {
    writer: ProvActor;
    /** The visible audit row that authorized the change; null when none was recorded. */
    authorizedById: string | null;
    /** `connect`: a connector sync, authorized by the person who connected the source.
     * `accepted`: content another writer produced, authorized by the person who accepted it. */
    authorizationKind: AuthorizationKind | null;
    /** The actor of the authorizing row when that is someone other than the writer. */
    authority: ProvActor | null;
  };
  /** The connected source a sync wrote from; null for a direct write. */
  source: { id: string; name: string; type: string } | null;
  /** Each reader's first allowed read of a scope covering the change, oldest first. */
  readers: { readId: string; at: string; reader: ProvActor }[];
  /** True when the reads behind `readers` were cut at the route's limit. */
  readersTruncated: boolean;
  replaced: { replacesIds: string[]; replacedById: string | null };
}

type ProvValue = string | number | boolean | { $: string; type: string };
type ProvRecord = Record<string, ProvValue>;

/** A PROV-JSON document: `prefix` maps prefixes to namespaces; every other key is a PROV-JSON
 * record type (`entity`, `used`, ...) mapping identifiers to attributes. */
export type ProvDocument = Record<string, Record<string, ProvRecord | string>>;

const qname = (value: string) => ({ $: value, type: "prov:QUALIFIED_NAME" });

/** A local name safe in a qualified name: no `:`, `/`, space or other reserved character. */
function local(value: string): string {
  return encodeURIComponent(value);
}

/** The identifier of an actor; each actor type is its own namespace, as in the audit log. */
export function provAgentId(actor: { actorType: ActorType; actorId: string }): string {
  return `willder:${actor.actorType}/${local(actor.actorId)}`;
}

/** The identifier of a memory record version. */
export function provRecordId(recordId: string): string {
  return `willder:record/${local(recordId)}`;
}

/** Builds the PROV-JSON document for one change's answers. */
export function changeToProvJson(answers: ChangeAnswers): ProvDocument {
  const { change, author, source, readers, replaced } = answers;
  const doc: Record<string, Record<string, ProvRecord>> = {
    entity: {},
    activity: {},
    agent: {},
    wasGeneratedBy: {},
    wasAttributedTo: {},
    wasAssociatedWith: {},
    actedOnBehalfOf: {},
    wasDerivedFrom: {},
    used: {},
  };
  let relation = 0;
  const add = (type: string, attributes: ProvRecord) => {
    doc[type][`_:${type}${++relation}`] = attributes;
  };
  const addAgent = (actor: ProvActor) => {
    doc.agent[provAgentId(actor)] = {
      "prov:type": qname(actor.actorType === "human" ? "prov:Person" : "prov:SoftwareAgent"),
      "prov:label": actor.name,
      "willder:actorType": actor.actorType,
      "willder:actorId": actor.actorId,
    };
  };

  const version = provRecordId(change.recordId);
  const write = `willder:change/${local(change.id)}`;
  doc.entity[version] = {
    "prov:type": qname(`willder:${local(change.recordType)}`),
    "willder:recordId": change.recordId,
    "willder:scope": change.scopePath,
    ...(answers.readersTruncated ? { "willder:readersTruncated": true } : {}),
  };
  doc.activity[write] = {
    "prov:type": qname(`willder:${local(change.op)}`),
    "prov:startTime": change.at,
    "prov:endTime": change.at,
    "willder:changeId": change.id,
  };
  add("wasGeneratedBy", { "prov:entity": version, "prov:activity": write, "prov:time": change.at });

  const writer = provAgentId(author.writer);
  addAgent(author.writer);
  add("wasAttributedTo", { "prov:entity": version, "prov:agent": writer });
  add("wasAssociatedWith", {
    "prov:activity": write,
    "prov:agent": writer,
    ...(author.authorizedById ? { "willder:authorizedBy": author.authorizedById } : {}),
    ...(author.authorizationKind ? { "willder:authorizationKind": author.authorizationKind } : {}),
  });
  if (author.authority && provAgentId(author.authority) !== writer) {
    addAgent(author.authority);
    add("actedOnBehalfOf", {
      "prov:delegate": writer,
      "prov:responsible": provAgentId(author.authority),
      "prov:activity": write,
    });
  }

  if (source) {
    const sourceId = `willder:source/${local(source.id)}`;
    doc.entity[sourceId] = {
      "prov:label": source.name,
      "willder:sourceId": source.id,
      "willder:sourceType": source.type,
    };
    add("wasDerivedFrom", {
      "prov:generatedEntity": version,
      "prov:usedEntity": sourceId,
      "prov:activity": write,
      "prov:type": qname("prov:PrimarySource"),
    });
  }

  const { replacesIds, replacedById } = replaced;
  const looped = new Set<string>();
  if (replacesIds.includes(change.recordId) || replacedById === change.recordId) looped.add(change.recordId);
  if (replacedById !== null && replacesIds.includes(replacedById)) looped.add(change.recordId).add(replacedById);
  for (const id of looped) {
    doc.entity[provRecordId(id)] ??= { "willder:recordId": id };
    doc.entity[provRecordId(id)]["willder:lineageLoop"] = true;
  }

  for (const id of replacesIds) {
    if (looped.has(id)) continue;
    doc.entity[provRecordId(id)] ??= { "willder:recordId": id };
    add("wasDerivedFrom", {
      "prov:generatedEntity": version,
      "prov:usedEntity": provRecordId(id),
      "prov:activity": write,
      "prov:type": qname("prov:Revision"),
    });
  }
  if (replacedById && !looped.has(replacedById)) {
    doc.entity[provRecordId(replacedById)] ??= { "willder:recordId": replacedById };
    add("wasDerivedFrom", {
      "prov:generatedEntity": provRecordId(replacedById),
      "prov:usedEntity": version,
      "prov:type": qname("prov:Revision"),
    });
  }

  for (const { readId, at, reader } of readers) {
    const read = `willder:read/${local(readId)}`;
    if (!doc.agent[provAgentId(reader)]) addAgent(reader);
    doc.activity[read] = {
      "prov:type": qname("willder:read"),
      "prov:startTime": at,
      "willder:auditRowId": readId,
    };
    add("used", { "prov:activity": read, "prov:entity": version, "prov:time": at });
    add("wasAssociatedWith", { "prov:activity": read, "prov:agent": provAgentId(reader) });
  }

  const records = Object.entries(doc).filter(([, byId]) => Object.keys(byId).length > 0);
  return {
    prefix: { willder: PROV_NAMESPACE },
    ...Object.fromEntries(records),
  };
}
