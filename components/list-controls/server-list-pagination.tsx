"use client";

/**
 * The pager under a list read through `useServerPage` (the Access grants and tokens, the
 * Settings roles and aliases, the Integrations lists).
 *
 * The rule: the pager is drawn from the fresh page or, while the next one loads, from
 * the page shown before it, held in place with its counts hidden and naming the page
 * asked for. Unmounting it until the answer arrived would drop keyboard focus from Next
 * on every page turn.
 */
import { ListPagination } from "./list-controls";
import { pageToShow, type ServerPageState } from "./use-server-page";
import { serverListPage } from "./use-url-page";

/** `list` is what `useServerPage` returns. */
export function ServerListPagination<R, E extends object>({
  noun,
  list,
  className,
}: {
  noun: { one: string; many: string };
  list: { state: ServerPageState<R, E>; page: number; setPage: (page: number) => void };
  className?: string;
}) {
  const { fresh, shown } = pageToShow(list.state);
  if (!shown) return null;
  return (
    <ListPagination
      noun={noun}
      paging={serverListPage(fresh ?? { ...shown, page: list.page }, list.setPage)}
      loading={fresh === null}
      className={className}
    />
  );
}
