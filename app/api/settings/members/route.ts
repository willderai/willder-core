import { NextResponse } from "next/server";
import { requireAccessContext } from "@/lib/access-context";
import { readSearchParam } from "@/lib/list-search";
import { MAX_MEMBER_PAGE } from "@/lib/page-limits";
import { listMembers, MEMBER_ROLES, MEMBER_SORTS, type MemberListQuery, type MemberSort } from "@/services/access";
import type { UserRole } from "@/types";

// GET /api/settings/members — the org's members: everyone with a live membership of
// this org, with their role here, whichever org they last had open. Any member of the
// org may call this; it returns name, email, role, when they joined and the identity
// provider's user id (no PII beyond that). That id is one Clerk already shows every
// member of the org, and it is how a caller matches a Clerk membership to the row here.
//
// Query (all optional): q (text in the name or email), role (owner, admin or member),
// sort (name, role or joined), order (asc or desc) and page. Without page, every
// matching member is returned (the dropdowns that pick a member read it that way);
// with page, one page of PAGE_SIZE. `total` is how many members match and
// `memberCount` how many the org has; both count live memberships of this org only.

/** Members per page when the caller asks for pages. */
const PAGE_SIZE = 25;

function parseQuery(params: URLSearchParams): MemberListQuery | { error: string } {
  const searched = readSearchParam(params);
  if ("error" in searched) return searched;
  const role = params.get("role");
  if (role !== null && !(MEMBER_ROLES as readonly string[]).includes(role)) {
    return { error: `role must be one of ${MEMBER_ROLES.join(", ")}` };
  }
  // The dropdowns' order, role then name, unless the caller picks another.
  const sort = params.get("sort") ?? "role";
  if (!(MEMBER_SORTS as readonly string[]).includes(sort))
    return { error: `sort must be one of ${MEMBER_SORTS.join(", ")}` };
  const order = params.get("order") ?? "asc";
  if (order !== "asc" && order !== "desc") return { error: "order must be asc or desc" };
  const pageText = params.get("page");
  const page = pageText === null ? null : Number(pageText);
  if (page !== null && (!Number.isInteger(page) || page < 1 || page > MAX_MEMBER_PAGE)) {
    return { error: `page must be a whole number from 1 to ${MAX_MEMBER_PAGE}` };
  }
  return {
    search: searched.search,
    role: role as UserRole | null,
    sort: sort as MemberSort,
    order,
    page: page === null ? null : { number: page, size: PAGE_SIZE },
  };
}

export async function GET(req: Request) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const query = parseQuery(new URL(req.url).searchParams);
  if ("error" in query) return NextResponse.json({ error: query.error }, { status: 400 });

  const unfiltered = query.search === "" && query.role === null;
  const [{ members, total }, memberCount] = await Promise.all([
    listMembers(rc.org.id, query),
    unfiltered
      ? null
      : listMembers(rc.org.id, {
          search: "",
          role: null,
          sort: "joined",
          order: "asc",
          page: { number: 1, size: 1 },
        }).then((all) => all.total),
  ]);

  return NextResponse.json({
    members,
    total,
    memberCount: memberCount ?? total,
    ...(query.page ? { page: query.page.number, pageSize: query.page.size } : {}),
  });
}
