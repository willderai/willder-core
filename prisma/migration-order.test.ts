// Migrations must apply in the order they were written, which Prisma only guarantees for
// directory names that start with a full 14-digit timestamp.
//
// Prisma sorts migrations by the text before the first underscore, compared as strings. An
// 8-digit YYYYMMDD_ prefix therefore sorts before every 14-digit prefix from the same day, and
// ties among 8-digit prefixes fall back to the rest of the name, alphabetically. Two migrations
// were applied out of order this way (20260610_day10_agent_framework before the migration that
// creates its table, 20260716_payg_credits before the one that adds its columns), so
// `prisma migrate deploy` could not build a database from empty. Their statements were moved to
// correctly ordered directories; the originals stay, empty, because renaming an applied
// migration makes every existing database try to apply it again.
//
// The legacy 8-digit names below are frozen: renaming them is unsafe for the same reason. A new
// migration must use the 14-digit prefix that `prisma migrate dev --create-only` generates. The
// end-to-end guard is CI building its test database with `prisma migrate deploy`; this test
// catches the naming mistake without a database.
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDir = join(resolve(__dirname), "migrations");

const LEGACY_EIGHT_DIGIT_MIGRATIONS = new Set([
  "20260610_day10_agent_framework",
  "20260615_drive_sources",
  "20260616_memory_chunks",
  "20260617_contact_enrichment_fields",
  "20260617_contact_type_account_enrichment",
  "20260617_social_links_json",
  "20260713_add_agent_roles",
  "20260713_briefs",
  "20260713_fact_disputes",
  "20260716_payg_credits",
  "20260716_v2_billing",
  "20260720_interactive_agent_loop",
  "20260720_memory_chunks_embedding_col",
  "20260901_audit_log_run_id",
  "20260902_brief_scope_label",
  "20260902_draft_campaign_scope_path",
  "20260902_draft_campaign_scope_path_gist_idx",
  "20260908_scope_index_completeness_btree",
  "20260910_fact_provenance",
  "20260913_contact_agent_api",
  "20260914_connector_sources_slack_figma",
  "20260919_brief_backend_and_receipt_ack",
  "20260919_capability_grant_governance",
  "20260919_multi_agent_workflow_engine",
  "20260920_connector_source_posthog",
  "20260920_memory_chunk_source_id",
  "20260922_agent_cursors",
  "20260922_change_events",
  "20260922_source_file_episode_scope",
  "20260923_connector_source_github",
  "20260923_schema_drift_reconciliation",
  "20260924_agent_cursor_denied_since",
  "20260924_agent_grantee_canonical_key",
  "20260924_source_file_drive_episodes",
  "20260924_source_file_episode_retire_marker",
  "20260925_integration_provider_slack_figma",
]);

function migrationNames(): string[] {
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/** Prisma's apply order: the prefix before the first underscore, compared as a string. */
function prismaApplyOrder(names: string[]): string[] {
  const prefix = (name: string) => name.slice(0, name.indexOf("_"));
  return [...names].sort((a, b) => {
    if (prefix(a) !== prefix(b)) return prefix(a) < prefix(b) ? -1 : 1;
    return a < b ? -1 : 1;
  });
}

describe("migration order", () => {
  it("names every new migration with a 14-digit timestamp prefix", () => {
    const misnamed = migrationNames().filter(
      (name) => !/^\d{14}_/.test(name) && !LEGACY_EIGHT_DIGIT_MIGRATIONS.has(name),
    );
    expect(misnamed, "create migrations with `prisma migrate dev --create-only`").toEqual([]);
  });

  it("keeps the frozen legacy list in step with the directory", () => {
    const present = new Set(migrationNames());
    const missing = [...LEGACY_EIGHT_DIGIT_MIGRATIONS].filter((name) => !present.has(name));
    expect(missing).toEqual([]);
  });

  it.each([
    ["20260610012608_day8_agents_runs", "20260610014500_agent_framework"],
    ["20260716_v2_billing", "20260716120000_payg_credits"],
  ])("applies %s before %s, which alters what it creates", (first, second) => {
    const order = prismaApplyOrder(migrationNames());
    expect(order.indexOf(first)).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(first)).toBeLessThan(order.indexOf(second));
  });
});
