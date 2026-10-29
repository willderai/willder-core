// Who can read a source at the source, per connector.
//
// Feeds the widening check at connect time (services/access/source-widening.ts).
// A connector that can report its readers asks the provider; one that cannot
// says so explicitly. The rule: never report an empty list for a source whose
// readers were not actually read, because "unknown" is not "nobody".

import type { SourceReaders } from "@/services/access";
import type { SourceType } from "@/lib/generated/prisma/enums";
import { listFolderReaders } from "./gdrive";
import { repositoryReaders } from "./github";

/** What a connect knows about the source it is connecting. */
export interface SourceToRead {
  type: SourceType;
  /** Drive folder id, `owner/name` repository, website domain, or the connector's own id. */
  externalId: string;
  /** The credential the connect carries, when the connector has one. */
  token?: string;
}

/** Who can read `source` at the source, or why that cannot be told. */
export async function readersAtSource(source: SourceToRead): Promise<SourceReaders> {
  switch (source.type) {
    case "gdrive":
      return listFolderReaders(source.externalId, source.token ?? "");
    case "github":
      return repositoryReaders(source.externalId, source.token ?? "");
    case "website":
      // The website connector reads public pages without signing in, so
      // anyone can read what it ingests.
      return { kind: "known", readers: [{ kind: "everyone" }] };
    case "slack":
      return { kind: "unknown", reason: "Willder does not read Slack channel membership yet" };
    case "figma":
      return { kind: "unknown", reason: "Willder does not read Figma file sharing yet" };
    case "posthog":
      return { kind: "unknown", reason: "PostHog does not report who can see an insight" };
    default:
      return { kind: "unknown", reason: "this connector cannot report who can read its sources" };
  }
}
