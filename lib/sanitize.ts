// Input sanitization — strip dangerous characters and enforce limits before
// content reaches the LLM, memory graph, or database.

// Max lengths per context
export const LIMITS = {
  memoryContent: 50_000, // ingest / chat write
  chatQuery: 2_000, // memory chat query
  campaignField: 500, // campaign name, ICP, tone
  contactField: 500, // contact/account name, title, description
  onboardingField: 5_000, // onboarding answers
  generic: 5_000,
} as const;

// Strip control characters (except newlines/tabs which are legitimate in text)
// and null bytes. Leaves all printable unicode intact.
function stripControls(s: string): string {
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

// Collapse runs of more than 3 consecutive newlines to 3
function collapseNewlines(s: string): string {
  return s.replace(/\n{4,}/g, "\n\n\n");
}

// Patterns that attempt to break out of the user content role and inject
// instructions into the system/assistant context. Kept narrow to avoid
// false positives on legitimate business text.
const INJECTION_PATTERNS = [
  /ignore\s+all\s+previous\s+instructions?/i, // classic jailbreak opener
  /<\s*system\s*>\s*[^<]{10}/i, // raw system tag with content
  /\[INST\]\s*<<SYS>>/i, // Llama instruction format
];

export function sanitize(value: string | null | undefined, maxLength: number = LIMITS.generic): string {
  if (!value) return "";
  return collapseNewlines(stripControls(value.trim())).slice(0, maxLength);
}

// Sanitize user content that will be passed directly to an LLM prompt.
// Applies sanitize() then checks for prompt injection patterns.
// Returns { safe: string, injectionDetected: boolean }.
export function sanitizeForLLM(
  value: string | null | undefined,
  maxLength: number = LIMITS.generic,
): { safe: string; injectionDetected: boolean } {
  const safe = sanitize(value, maxLength);
  const injectionDetected = INJECTION_PATTERNS.some((p) => p.test(safe));
  return { safe, injectionDetected };
}
