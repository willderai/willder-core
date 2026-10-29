// Inngest client + functions for durable background work. Memory ingestion was
// the first job: extraction is slow (LLM-bound, seconds), so the API enqueues
// an event and returns immediately and the job runs in the background with
// retries. Locally, run the Inngest dev server: `npx inngest-cli@latest dev`.
//
// Every job now lives in its own file under lib/inngest/. This file is only
// the barrel that re-exports them, so each existing `@/lib/inngest` import
// keeps working, plus the `functions` array that app/api/inngest/route.ts
// serves. Nothing is implemented here: add a job as a new module under
// lib/inngest/ and re-export it below.
import { memoryIngest } from "./inngest/memory-ingest";
import { fileIngest } from "./inngest/file-ingest";
import { enrichmentRun } from "./inngest/enrichment";
import {
  neo4jKeepAlive,
  architectureNightly,
  qaManagerChildRun,
  abandonedRunSweep,
  graphExtractionRetry,
  taskStartLogRetention,
} from "./inngest/scheduled-jobs";
import { sourceSync } from "./inngest/connector-sync";
import { sourceScheduledResync } from "./inngest/source-resync";
import { orgDeletionFinalExport, orgDeletionSweep } from "./inngest/org-deletion";
import { personErasure, personErasureSweep, restoreCompletion } from "./inngest/person-erasure";

export { inngest } from "./inngest/client";
export * from "./inngest/memory-ingest";
export * from "./inngest/file-ingest";
export * from "./inngest/enrichment";
export * from "./inngest/scheduled-jobs";
export {
  runWhileSourceCurrent,
  sourceScopeIsCurrent,
  sourceWriteState,
  type ConnectorSyncOutcome,
  type SourceWriteState,
} from "./inngest/source-state";
// Named, not `export *`: this barrel's surface is exactly what it was before
// connector sync moved out of this file. The connector modules export a little
// more to each other (`connectorActorId`, `retireRecordedEpisode`) that was
// file-private before the split and stays out of `@/lib/inngest`.
export {
  planConnectorSync,
  type ConnectorSyncFile,
  type ConnectorSyncIngestPlanItem,
  type ConnectorSyncPlan,
  type RetirableEpisode,
} from "./inngest/connector-records";
export {
  buildConnectorIngestInput,
  listGitHubItems,
  listPostHogItems,
  retireVanishedTextItem,
  syncOneTextItem,
} from "./inngest/connector-text-items";
export { processDriveFile, retireVanishedDriveFile, type DriveSyncFile } from "./inngest/connector-drive-files";
export {
  loadScopedSource,
  sourceSync,
  sourceSyncStatus,
  summarizeSyncOutcomes,
  SOURCE_SYNC_EVENT,
  type SourceSyncInput,
} from "./inngest/connector-sync";

/** Every Inngest function this app serves (app/api/inngest/route.ts). */
export const functions = [
  memoryIngest,
  fileIngest,
  enrichmentRun,
  neo4jKeepAlive,
  architectureNightly,
  qaManagerChildRun,
  abandonedRunSweep,
  graphExtractionRetry,
  taskStartLogRetention,
  sourceSync,
  sourceScheduledResync,
  orgDeletionFinalExport,
  orgDeletionSweep,
  personErasure,
  personErasureSweep,
  restoreCompletion,
];
