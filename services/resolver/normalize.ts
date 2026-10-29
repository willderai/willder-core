// Text normalization utilities for the entity resolver.

export function normalizeStr(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

export function domainFromEmail(email: string): string | null {
  const parts = email.split("@");
  return parts.length === 2 ? parts[1].toLowerCase() : null;
}

export function domainFromUrl(url: string): string | null {
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

// Build a word-boundary-aware regex for an alias. Case-insensitive.
// Sorts caller responsibility: apply longest patterns first to avoid partial matches.
export function buildPattern(alias: string): RegExp {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w])${escaped}(?![\\w])`, "gi");
}

// Apply a list of [pattern, canonical] pairs to text, tracking substitutions.
// Pairs must be sorted longest-alias-first before calling.
export function applyPatterns(
  text: string,
  pairs: [RegExp, string, string, string | null | undefined][],
  // [pattern, canonical, entityType, entityId]
): {
  text: string;
  substitutions: Array<{ original: string; canonical: string; type: string; entityId?: string | null }>;
} {
  const substitutions: Array<{ original: string; canonical: string; type: string; entityId?: string | null }> = [];
  let out = text;

  for (const [pattern, canonical, type, entityId] of pairs) {
    out = out.replace(pattern, (match, offset: number, fullString: string) => {
      // Guard against double-expansion: if the canonical name is multi-word and
      // the match is the first word, check whether what follows is already the
      // rest of the canonical name. e.g. "Jane" + " Doe" → already "Jane Doe",
      // so skip the replacement to avoid "Jane Doe Doe".
      const canonicalWords = canonical.split(" ");
      if (canonicalWords.length > 1 && match.toLowerCase() === canonicalWords[0].toLowerCase()) {
        const rest = " " + canonicalWords.slice(1).join(" ");
        const following = fullString.slice(offset + match.length, offset + match.length + rest.length);
        if (following.toLowerCase() === rest.toLowerCase()) return match;
      }

      if (match.toLowerCase() !== canonical.toLowerCase()) {
        substitutions.push({ original: match, canonical, type, entityId });
      }
      return canonical;
    });
  }

  return { text: out, substitutions };
}
