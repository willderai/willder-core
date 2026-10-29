// Access control (UC2). The barrel for the check() chokepoint, its
// types, and the agent-capability helpers. Memory reads go through the guarded
// store (services/memory/guarded-store.ts), which calls check() here; never call
// the raw MemoryStore for reads in request paths.
export {
  check,
  can,
  readableScopePaths,
  orgRootPath,
  pathCovers,
  normalizeScopePath,
  scopeIsAbsent,
  isValidLtreePath,
  isMintableScopePath,
  resolveCallerScopePath,
  resolveCapability,
  deriveGrantGovernance,
  recordReadFactIds,
  recordAppliedChange,
  recordWriteEffect,
  resolveExecutedPartition,
  descendantScopePaths,
  MAX_DESCENDANT_SCOPES,
  MAX_SEARCHED_DESCENDANT_SCOPES,
  auditChangesUnderScope,
  scopeCacheStamp,
  bumpRemovalEpoch,
  removingFromGraph,
  REMOVAL_AUDIT_ACTIONS,
  type ScopeCacheStamp,
  anotherLiveAgentGrantCoversSql,
  recordBriefAcknowledgement,
  latestBriefAcknowledgement,
  AccessDeniedError,
  type AccessContext,
  type AccessAction,
  type DerivedAuditAction,
  type AccessDecision,
  type DescendantScopes,
  type AccessRequest,
  type ExecutedPartition,
  type Actor,
  type Permission,
} from "./check";
export { scopePathsStartingWith, strictDescendantScopePaths } from "./scope-registry";
export { ensureAccessRoot } from "./access-root";
export { AUDIT_ORIGINS, isAuditOrigin, type AuditOrigin } from "./origin";
export { lockOrgDeletion, OPEN_DELETION_STATUSES } from "./org-deletion-gate";
export { writeAuditRow, type AuditRowInput } from "./audit-row";
export { recordRefusal, type Refusal } from "./refusal";
export { authorizeRecord, recordAuthorizer } from "./authorize-record";
export { generateCapabilityToken, hashCapabilityToken, isIssuerBoundRefusal } from "./capabilities";
export { canonicalAgentId } from "./agent-identity";
export {
  clerkRoleToUserRole,
  recordMembership,
  recordMembershipRemoved,
  deleteUsersLeftWithoutMembership,
  deleteUsersWithoutMembership,
  pruneAdminDepartures,
  liveMembership,
  listMembers,
  MEMBER_ROLES,
  MEMBER_SORTS,
  type ListedMember,
  type MemberListQuery,
  type MemberSort,
  type Membership,
} from "./membership";
export {
  groupIdOutsideTenant,
  invalidCallerScopePath,
  operatorOrgRequired,
  orgRoleRequired,
  type DecisionReasons,
} from "./deny-reason";
export {
  scopeAudience,
  computeWidening,
  decideWidening,
  type SourceReader,
  type SourceReaders,
} from "./source-widening";
export { scopeContainsSql, flattenSql, escapeLikePrefix, type ScopeContainmentOptions } from "./scope-containment";
export {
  withinReadableScopesSql,
  readsWholeOrg,
  scopesWithinGrants,
  readableUsageRows,
  readableUsageCredits,
  readableUsagePage,
  USAGE_SORTS,
  type UsageListQuery,
  type UsageRow,
} from "./readable-rows";
export {
  issueCapability,
  issuableScopes,
  narrowestScopePath,
  type IssuableScope,
  type IssuedCapability,
} from "./issue-capability";
export {
  connectOAuthClient,
  listOAuthConnections,
  liveOAuthConnection,
  revokeOAuthConnection,
  type OAuthConnectionView,
} from "./oauth-connection";
export { findOAuthClient, onlyLoopbackRedirects, registerOAuthClient, type OAuthClientView } from "./oauth-client";
export {
  approveAuthorization,
  defaultAgentName,
  authorizationResponseUrl,
  exchangeAuthorizationCode,
  isOAuthAccessToken,
  refreshAccessToken,
  resolveOAuthAccessToken,
  validateAuthorizationRequest,
  type AuthorizationRequest,
} from "./oauth-authorization";
export { canonicalResource, OAUTH_SCOPES } from "./oauth-protocol";
