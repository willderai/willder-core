// Shared types for the entity resolver: the known entities each tier loads and
// the resolution each pass returns.
export type EntityType = "user" | "account" | "contact" | "org";

export interface KnownEntity {
  id: string;
  entityId?: string | null; // Neo4j uuid, if linked
  type: EntityType;
  canonicalName: string;
  aliases: string[]; // raw alias strings (patterns compiled on use)
}

export interface Resolution {
  original: string;
  canonical: string;
  type: EntityType;
  entityId?: string | null;
}

export interface ResolveResult {
  resolvedText: string;
  resolutions: Resolution[];
  changed: boolean;
}
