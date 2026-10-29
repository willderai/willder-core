import { requireAccessContext } from "@/lib/access-context";
import { pagePermissions } from "@/lib/page-permissions";
import { AccessView } from "./access-view";

// Every tab on this page lists something only an access manager may read, so the
// tabs load only for someone the server would allow; anyone else is told so without
// a request that would be refused and recorded as a denial they never attempted.
export default async function AccessPage() {
  const rc = await requireAccessContext();
  const canManage = rc ? (await pagePermissions(rc)).manageAccess : false;
  return <AccessView canManage={canManage} />;
}
