// Compares the MCP tools the registry registers with a hand-kept list that has to
// cover every one of them: the public docs, the read-path classification, the
// refusal check's arguments. Those lists are deliberate guards: adding a tool must
// fail the build until someone decides what the list says about it. The comparison
// reports tool names, not two truncated arrays, so the failure names what to add or
// remove.

/** The tools a hand-kept list is missing (`unlisted`) or still names after removal (`stale`). */
export interface ToolListDrift {
  unlisted: string[];
  stale: string[];
}

/** No drift: what a test expects when the list matches the registry. */
export const NO_DRIFT: ToolListDrift = { unlisted: [], stale: [] };

/** Compare registered tool names with the names a hand-kept list covers. */
export function toolListDrift(registered: Iterable<string>, listed: Iterable<string>): ToolListDrift {
  const registeredNames = new Set(registered);
  const listedNames = new Set(listed);
  return {
    unlisted: [...registeredNames].filter((name) => !listedNames.has(name)).sort(),
    stale: [...listedNames].filter((name) => !registeredNames.has(name)).sort(),
  };
}
