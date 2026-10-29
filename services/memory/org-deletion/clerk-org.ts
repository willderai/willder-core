// The last step of an org deletion outside Willder's own stores: deleting the org's Clerk
// organization, so no one can sign in to it again and be given a new, empty Willder org.
//
// The one rule: it is safe to repeat. A Clerk organization that is already gone counts as
// deleted, so a run that died after this step, or a deletion Clerk itself started, finishes.
import { clerkClient } from "@clerk/nextjs/server";
import { isClerkAPIResponseError } from "@clerk/nextjs/errors";

/** Delete the Clerk organization `clerkOrgId`, or do nothing if Clerk has none by that id. */
export async function deleteClerkOrganization(clerkOrgId: string): Promise<void> {
  const client = await clerkClient();
  try {
    await client.organizations.deleteOrganization(clerkOrgId);
  } catch (error) {
    if (isClerkAPIResponseError(error) && error.status === 404) return;
    throw error;
  }
}
