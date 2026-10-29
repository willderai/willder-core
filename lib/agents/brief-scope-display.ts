// The scope chip on a generated Brief (BriefView in app/(app)/agents/page.tsx)
// prefers the human-readable scopeLabel when present, falling back to the raw
// scopePath. A scope-less QA brief's scopePath is the org root (e.g.
// "org_cabc123"), so its label carries the target host
// ("(target) petstore.swagger.io") instead of the raw org root ltree path.
// Extracted so this display rule is covered by a test even though the
// project's vitest config only runs *.test.ts (node env, no DOM).
export function briefScopeDisplay(brief: { scopePath: string; scopeLabel?: string | null }): string {
  return brief.scopeLabel ?? brief.scopePath;
}
