"use client";

/**
 * A Settings table read a page at a time from the server (org roles, entity
 * aliases): the toolbar, the page itself and the pager, with every state the page
 * can be in said plainly. The search, filters and order live in the URL under the
 * list's prefix, as does the page (`roles.page=3`).
 *
 * The rule: a count, an empty message or a no-match message is shown only from the
 * server's answer to the current request. While the next page loads, the last one's
 * rows stay on screen, dimmed and without a count, and so does the pager, inert; a
 * refusal or failure replaces the table instead of leaving old rows behind.
 */
import type { ReactNode } from "react";
import { Button } from "@/components/ui";
import { ListControls, ListNoMatch } from "@/components/list-controls/list-controls";
import { isNarrowed, showsListControls, type ListConfig } from "@/components/list-controls/list-query";
import { listViewKey } from "@/components/list-controls/list-page";
import type { ListStateControls } from "@/components/list-controls/use-list-state";
import { listPageUrl, pageToShow, useServerPage } from "@/components/list-controls/use-server-page";
import { ServerListPagination } from "@/components/list-controls/server-list-pagination";
import { MAX_ACCESS_PAGE } from "@/lib/access-lists";
import { listSearchText } from "@/lib/list-search";

/**
 * `path` is the list route; `rowsKey` the field of its answer holding the rows;
 * `revision` is bumped after a save or delete to read the page again; `empty` is
 * what an org with no rows at all sees; `children` draws the rows of one page.
 */
export function PagedSettingsList<R>({
  path,
  rowsKey,
  config,
  view,
  revision,
  onRetry,
  empty,
  children,
}: {
  path: string;
  rowsKey: string;
  config: ListConfig<R>;
  view: ListStateControls;
  revision: number;
  onRetry: () => void;
  empty: ReactNode;
  children: (rows: R[]) => ReactNode;
}) {
  const committed = view.committed;
  const list = useServerPage<R>({
    prefix: config.paramPrefix ?? "",
    maxPage: MAX_ACCESS_PAGE,
    rowsKey,
    viewKey: `${listSearchText(committed.query)}|${listViewKey(config, { ...committed, query: "" })}`,
    urlFor: (page) => listPageUrl(path, committed, page),
    searching: listSearchText(committed.query) !== "",
    revision,
  });

  if (list.state.status === "forbidden") {
    return (
      <div className="rounded-2xl border border-brick/20 bg-brick/[0.06] py-10 text-center text-sm text-fg-subtle">
        Admin access required to view {config.noun.many}.
      </div>
    );
  }
  if (list.state.status === "failed") {
    return (
      <div role="alert" className="flex flex-col items-center gap-3 py-10 text-center text-sm text-fg-muted">
        <p>Could not load {config.noun.many}.</p>
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }

  const { fresh, shown } = pageToShow(list.state);
  const loading = <p className="py-6 text-center text-sm text-fg-subtle">Loading…</p>;
  if (!shown) return loading;

  if (fresh?.count === 0 && !isNarrowed(committed)) {
    return (
      <div className="rounded-2xl border border-divider bg-fg/[0.02] py-10 text-center text-sm text-fg-subtle">
        {empty}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {showsListControls(shown.count, view.state) && (
        <ListControls config={config} controls={view} total={shown.count} shown={fresh?.total ?? null} />
      )}
      {shown.rows.length === 0 && !fresh ? (
        loading
      ) : shown.rows.length === 0 ? (
        list.page > 1 ? (
          <p className="py-6 text-center text-sm text-fg-muted">
            This page is past the last {config.noun.one}.{" "}
            <button type="button" onClick={() => list.setPage(1)} className="underline underline-offset-2">
              Go to page 1
            </button>
          </p>
        ) : (
          <ListNoMatch config={config} controls={view} />
        )
      ) : (
        <div aria-busy={!fresh} className={`transition-opacity ${fresh ? "" : "opacity-60"}`}>
          {children(shown.rows)}
        </div>
      )}
      <ServerListPagination noun={config.noun} list={list} />
    </div>
  );
}
