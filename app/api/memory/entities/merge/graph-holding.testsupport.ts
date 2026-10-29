// A fake for graphitiStore.groupsHoldingEntity, shared by the merge route's tests.

/** Answers as a graph holding an entity named `name` in each group `holds` accepts. */
export const holding =
  (holds: (groupId: string, name: string) => boolean) =>
  ({ groupIds, name }: { groupIds: string[]; name: string }) =>
    Promise.resolve(groupIds.filter((groupId) => holds(groupId, name)));
