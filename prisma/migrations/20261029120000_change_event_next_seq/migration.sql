-- An org's next change-event seq, taken under its change-feed lock, inside the statement that
-- uses it.
--
-- Every change event is written under the org's change-feed lock (an advisory transaction lock,
-- services/memory/change-events.ts), held to commit, so seq order is commit order. Until now a
-- writer sent three statements for it: take the lock, read MAX(seq) + 1, insert the event. All
-- three sit inside the lock, and every other writer in the org waits for them and for the
-- commit: with six agents posting at once, the last one waited for five of those sections, each
-- three round trips long.
--
-- The lock and the read cannot share one plain SQL statement: under READ COMMITTED a statement
-- reads one snapshot, taken when it starts, so a writer that waited for the lock inside its
-- statement would still read the MAX(seq) from before the writer it waited for committed, and
-- take the same seq. A VOLATILE PL/pgSQL function runs each of its own statements with a new
-- snapshot, so the read below sees everything committed before the lock was granted. Called
-- from the INSERT itself, the lock, the read and the insert are one round trip.
--
-- The lock key is the same one lockOrgChangeFeed() takes (namespace 8241001, the second key the
-- org id's hashtext), so this and every reader that takes the lock to read the feed exclude each
-- other exactly as before; taking it twice in one transaction does not block.
-- services/memory/change-events.realdb.test.ts holds both properties.
--
-- Not SECURITY DEFINER: it runs as the caller, who already inserts into change_events. Pinned
-- to pg_catalog, pg_temp with every other name qualified, as every function here is
-- (20261018120000_functions_resolve_only_pg_catalog).
CREATE FUNCTION public.change_event_next_seq(org_id TEXT) RETURNS BIGINT
LANGUAGE plpgsql VOLATILE
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(8241001, pg_catalog.hashtext(org_id));
  RETURN (SELECT COALESCE(pg_catalog.max(e."seq"), 0) + 1 FROM public."change_events" e WHERE e."orgId" = org_id);
END
$$;
