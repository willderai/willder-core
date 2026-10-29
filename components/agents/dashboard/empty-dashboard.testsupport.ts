// Empty but well-formed answers for the agents dashboard's own requests, for page tests
// that are about something else on the page and stub `fetch` for it.

const zero = { total: 0, completed: 0, failed: 0, running: 0, waiting: 0, stalled: 0 };

/** The dashboard route's answer for an org with no activity, or null for any other URL. */
export function emptyDashboardResponse(url: string): Response | null {
  if (url === "/api/agents/dashboard") {
    return Response.json({
      windowDays: 7,
      agents: { own: { total: 0, active: 0 }, connected: null },
      runs: { day: zero, week: zero },
      decisions: null,
      factsWritten: 0,
    });
  }
  if (url.startsWith("/api/agents/roster")) {
    return Response.json({ rows: [], total: 0, page: 1, pageSize: 12 });
  }
  if (url.startsWith("/api/agents/activity")) return Response.json({ runs: [], next: null });
  return null;
}
