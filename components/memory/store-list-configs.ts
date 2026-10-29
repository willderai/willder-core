// How each list on the Explore page searches, filters and orders. The server does the
// work (lib/memory-store-lists.ts names what it accepts); these entries mirror what it
// matches, so the toolbar and the URL describe the same view as the request.
import type { StoreBrief, StoreChunk, StoreFile, StoreNote, StoreRecord, StoreRule } from "@/types/memory";
import { STORE_LIST_FILTERS } from "@/lib/memory-store-lists";
import { compareText, compareTime, type ListConfig } from "@/components/list-controls/list-query";

const NEWEST_FIRST = { asc: "Oldest first", desc: "Newest first" } as const;
const A_TO_Z = { asc: "A–Z", desc: "Z–A" } as const;

const RECORD_KIND_LABEL: Record<StoreRecord["kind"], string> = { source: "Sources", contact: "Contacts" };
const BRIEF_TYPE_LABEL: Record<StoreBrief["type"], string> = {
  handoff: "Handoffs",
  architecture_plan: "Architecture plans",
  qa_review: "QA reviews",
};
const RULE_KIND_LABEL: Record<StoreRule["kind"], string> = { convention: "Conventions", decision: "Decisions" };
const NOTE_KIND_LABEL: Record<StoreNote["kind"], string> = {
  claim: "Claims",
  intent: "Intents",
  status: "Status",
  question: "Questions",
};
const FILE_TYPE_LABEL: Record<(typeof STORE_LIST_FILTERS.files.values)[number], string> = {
  gdrive: "Google Drive",
  website: "Website",
  slack: "Slack",
  figma: "Figma",
  posthog: "PostHog",
  github: "GitHub",
};

export const RECORD_LIST: ListConfig<StoreRecord> = {
  noun: { one: "source or contact", many: "sources and contacts" },
  searchText: (r) => [r.title],
  sorts: [
    {
      key: "updated",
      label: "Updated",
      compare: (a, b) => compareTime(a.updatedAt, b.updatedAt),
      defaultDirection: "desc",
      directionLabels: NEWEST_FIRST,
    },
    { key: "title", label: "Name", compare: (a, b) => compareText(a.title, b.title), directionLabels: A_TO_Z },
  ],
  filters: [
    {
      key: STORE_LIST_FILTERS.records.param,
      label: "Kind",
      options: STORE_LIST_FILTERS.records.values.map((kind) => ({ value: kind, label: RECORD_KIND_LABEL[kind] })),
      matches: (r, kind) => r.kind === kind,
    },
  ],
  paramPrefix: "records.",
};

export const BRIEF_LIST: ListConfig<StoreBrief> = {
  noun: { one: "brief", many: "briefs" },
  searchText: (b) => [b.title],
  sorts: [
    {
      key: "created",
      label: "Created",
      compare: (a, b) => compareTime(a.createdAt, b.createdAt),
      defaultDirection: "desc",
      directionLabels: NEWEST_FIRST,
    },
    { key: "title", label: "Title", compare: (a, b) => compareText(a.title, b.title), directionLabels: A_TO_Z },
  ],
  filters: [
    {
      key: STORE_LIST_FILTERS.briefs.param,
      label: "Type",
      options: STORE_LIST_FILTERS.briefs.values.map((type) => ({ value: type, label: BRIEF_TYPE_LABEL[type] })),
      matches: (b, type) => b.type === type,
    },
  ],
  paramPrefix: "briefs.",
};

export const RULE_LIST: ListConfig<StoreRule> = {
  noun: { one: "rule or decision", many: "rules and decisions" },
  searchText: (r) => [r.subject, r.text],
  sorts: [
    {
      key: "created",
      label: "Recorded",
      compare: (a, b) => compareTime(a.createdAt, b.createdAt),
      defaultDirection: "desc",
      directionLabels: NEWEST_FIRST,
    },
    { key: "subject", label: "Subject", compare: (a, b) => compareText(a.subject, b.subject), directionLabels: A_TO_Z },
  ],
  filters: [
    {
      key: STORE_LIST_FILTERS.rules.param,
      label: "Kind",
      options: STORE_LIST_FILTERS.rules.values.map((kind) => ({ value: kind, label: RULE_KIND_LABEL[kind] })),
      matches: (r, kind) => r.kind === kind,
    },
  ],
  paramPrefix: "rules.",
};

export const NOTE_LIST: ListConfig<StoreNote> = {
  noun: { one: "working note", many: "working notes" },
  searchText: (n) => [n.task, n.body],
  sorts: [
    {
      key: "created",
      label: "Posted",
      compare: (a, b) => compareTime(a.createdAt, b.createdAt),
      defaultDirection: "desc",
      directionLabels: NEWEST_FIRST,
    },
  ],
  filters: [
    {
      key: STORE_LIST_FILTERS.notes.param,
      label: "Kind",
      options: STORE_LIST_FILTERS.notes.values.map((kind) => ({ value: kind, label: NOTE_KIND_LABEL[kind] })),
      matches: (n, kind) => n.kind === kind,
    },
  ],
  paramPrefix: "notes.",
};

export const CHUNK_LIST: ListConfig<StoreChunk> = {
  noun: { one: "text passage", many: "text passages" },
  searchText: (c) => [c.snippet, c.author, c.source],
  sorts: [
    {
      key: "created",
      label: "Ingested",
      compare: (a, b) => compareTime(a.createdAt, b.createdAt),
      defaultDirection: "desc",
      directionLabels: NEWEST_FIRST,
    },
  ],
  filters: [
    {
      key: STORE_LIST_FILTERS.chunks.param,
      label: "Version",
      options: [
        { value: "current", label: "Current" },
        { value: "superseded", label: "Superseded" },
      ],
      matches: (c, version) => (version === "superseded") === (c.supersededById !== null),
    },
  ],
  paramPrefix: "chunks.",
};

export const FILE_LIST: ListConfig<StoreFile> = {
  noun: { one: "file", many: "files" },
  searchText: (f) => [f.externalFileId, f.sourceName],
  sorts: [
    {
      key: "synced",
      label: "Last sync",
      compare: (a, b) => compareTime(a.syncedAt, b.syncedAt),
      defaultDirection: "desc",
      directionLabels: NEWEST_FIRST,
    },
    {
      key: "name",
      label: "Name",
      compare: (a, b) => compareText(a.externalFileId, b.externalFileId),
      directionLabels: A_TO_Z,
    },
    {
      key: "chunks",
      label: "Passages",
      compare: (a, b) => a.chunkCount - b.chunkCount,
      defaultDirection: "desc",
      directionLabels: { asc: "Fewest first", desc: "Most first" },
    },
  ],
  filters: [
    {
      key: STORE_LIST_FILTERS.files.param,
      label: "Source",
      options: STORE_LIST_FILTERS.files.values.map((type) => ({ value: type, label: FILE_TYPE_LABEL[type] })),
      matches: (f, type) => f.sourceType === type,
    },
  ],
  paramPrefix: "files.",
};
