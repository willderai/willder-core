// Secret scan for connector text, run before anything reaches memory.
//
// A builder's repository, docs and threads routinely carry credentials: a token
// pasted into a README's setup section, a key in an issue's log excerpt, a
// private key block in a how-to. Memory is shared with agents and people the
// source never showed them to, so a secret that lands there has leaked. This
// module finds credentials by their published shapes and replaces each with a
// marker, keeping the sentence around it: the decision a line records is worth
// keeping, the key in it never is.
//
// The one rule it enforces: a match is replaced, never stored, and never echoed
// back in what the scan reports. `findings` names the kind of each secret, not
// its value.
//
// The patterns are the vendors' own token formats, so a hit is a real
// credential shape, not a guess from entropy. A credential with no fixed format
// is caught only where it sits in a recognisable place: a secret-named
// variable (`DB_PASSWORD=...`, `"api_key": "..."`, `DB_PASS=...`), a bearer
// header, or a URL's credentials, with or without a user name. Anything else
// without a shape is out of reach of a pattern scan, and the source's own
// secret scanning is still the backstop.

/** What replaces each secret in the stored text. */
export const SECRET_MARKER = "[secret removed]";

/** What replaces each email address in the stored text. */
export const EMAIL_MARKER = "[email removed]";

interface SecretPattern {
  kind: string;
  /**
   * Matches one secret. Capture group 1, when the pattern has one, is text
   * before the secret that stays (a variable name, a URL scheme), and group 2
   * text after it. Every other group is non-capturing.
   */
  pattern: RegExp;
}

// Every quantifier below has an upper bound and every pattern starts at a fixed
// prefix or a bounded run, so a scan stays linear in the text's length: an
// unbounded run at the start of a pattern rescans the rest of the text from
// every position, which took seconds on 100,000 characters.

/** After a secret name: an optional closing quote, spaces, then `:` or `=` (the pattern supplies it). */
const NAME_END = String.raw`["']?[ \t]{0,8}`;

/** Spaces and an optional opening quote between `:` or `=` and the value. Kept with the name. */
const VALUE_LEAD = String.raw`[ \t]{0,8}["']?`;

/**
 * The value itself: 8 or more characters with no space, quote, comma or
 * semicolon. A value that holds a marker already (a URL whose password went, a
 * vendor token inside it) is left alone, so one secret is counted once and its
 * marker stays whole.
 */
const VALUE = String.raw`(?![^\s"',;]{0,512}\[secret removed\])[^\s"',;]{8,512}`;

/**
 * Long secret names in any letter case. The established ones match anywhere in
 * a variable's name (`DB_PASSWORD`, `SENTRY_AUTH_TOKEN`). The later additions
 * only as its last part, because `ACCESS_KEY_ID` and `PASSPHRASE_FILE` name
 * an id and a path, not a secret.
 */
const LONG_NAME = String.raw`\b[A-Za-z0-9_-]{0,40}(?:(?:password|passwd|secret|api[_-]?key|token(?!s))[A-Za-z0-9_-]{0,40}|(?:passphrase|passcode|access[_-]?key)(?![A-Za-z0-9_-]))`;

/**
 * A value after the short secret name `word` (`pass`, `pwd`). Short names sit
 * inside ordinary words (bypass, compass, passage), sentences ("First pass:
 * ..."), test logs ("PASS: test-name") and code (`renderPass: RenderPass`),
 * so each counts only as the last, whole part of a name, in one of the forms a
 * credential is written in:
 * - `DB_PASS=...`, `--pass=...`, `?pwd=...`: an assignment with no space before
 *   `=`, as in env files, flags and query strings;
 * - `pass = "..."`, `PWD: '...'`: spaced, so only with a quoted value, as in code;
 * - `dbPass = '...'`: a camelCase part, also only with a quoted value;
 * - `"db_pass": "..."`: a lower-case JSON key;
 * - `pass: ...`, `  - db_pass: ...`: a lower-case YAML key at the start of a line;
 * - plus any `extraForms`.
 * Telling camelCase from a word needs letter case, so the pattern has no i flag.
 */
function shortSecretName(word: string, { value = VALUE, extraForms = [] as string[] } = {}): RegExp {
  const upper = word.toUpperCase();
  const title = word[0].toUpperCase() + word.slice(1);
  const forms = [
    String.raw`(?<![A-Za-z0-9])(?:${word}|${upper})=[ \t]{0,8}["']?`,
    String.raw`(?<![A-Za-z0-9])(?:${word}|${upper})[ \t]{0,8}[:=][ \t]{0,8}["']`,
    String.raw`(?<=[a-z0-9])${title}["']?[ \t]{0,8}[:=][ \t]{0,8}["']`,
    String.raw`(?<=["'](?:[a-z0-9]{1,40}[_.-]){0,4})${word}["'][ \t]{0,8}:[ \t]{0,8}["']`,
    String.raw`(?<=^[ \t]{0,40}(?:-[ \t]{1,4})?(?:[a-z0-9]{1,40}[_.]){0,4})${word}[ \t]{0,8}:[ \t]{0,8}["']?`,
    ...extraForms,
  ];
  return new RegExp(String.raw`((?:${forms.join("|")}))${value}`, "gm");
}

/**
 * Credential formats, each anchored on a vendor prefix so ordinary text does
 * not match, then the shapes a credential with no fixed format takes: a
 * bearer header, a password in a URL, a secret-named variable (long names,
 * then the short `pass` and `pwd`). Order matters only where one shape
 * contains another: the PEM block runs first so its body is removed as one
 * secret, and the named-variable shapes run last so a vendor token or a link
 * password in them is counted under its own kind.
 */
const SECRET_PATTERNS: SecretPattern[] = [
  {
    kind: "private key",
    pattern:
      /-----BEGIN [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)/g,
  },
  { kind: "GitHub token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g },
  { kind: "Anthropic key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,255}/g },
  { kind: "OpenAI key", pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,255}T3BlbkFJ[A-Za-z0-9_-]{20,255}/g },
  { kind: "Stripe key", pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,255}/g },
  { kind: "Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,255}/g },
  {
    kind: "Slack webhook",
    pattern: /(\bhttps:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/)[A-Za-z0-9_/-]{20,512}/g,
  },
  { kind: "npm token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: "GitLab token", pattern: /\bgl(?:pat|dt|rt|ptt)-[A-Za-z0-9_-]{20,255}/g },
  { kind: "SendGrid key", pattern: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g },
  { kind: "AWS access key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { kind: "Google API key", pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g },
  { kind: "Willder capability token", pattern: /\bwcap_[A-Za-z0-9_-]{43}/g },
  {
    kind: "JSON web token",
    pattern: /\beyJ[A-Za-z0-9_-]{10,4096}\.eyJ[A-Za-z0-9_-]{10,8192}\.[A-Za-z0-9_-]{10,1024}/g,
  },
  { kind: "bearer token", pattern: /(\bBearer[ \t]{1,8})[A-Za-z0-9._~+/-]{20,4096}={0,2}/g },
  // HTTP auth schemes are case-insensitive (RFC 9110): after an Authorization header, `bearer` and `BEARER` are the
  // same scheme. Elsewhere only `Bearer` counts, so prose like "we use bearer authentication/authorization" stays.
  {
    kind: "bearer token",
    pattern: /(\bauthorization["']?[ \t]{0,8}[:=][ \t]{0,8}["'`]?bearer[ \t]{1,8})[A-Za-z0-9._~+/-]{20,4096}={0,2}/gi,
  },
  // The user name may be empty: Redis and others take a password alone, with nothing before its colon.
  { kind: "password in URL", pattern: /(\b[a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/:@]{0,256}:[^\s/@]{1,256}(@)/gi },
  {
    kind: "secret-named value",
    pattern: new RegExp(String.raw`(${LONG_NAME}${NAME_END}[:=]${VALUE_LEAD})${VALUE}`, "gi"),
  },
  // openssl's own form, `-passin pass:...`, as in certificate how-tos.
  {
    kind: "secret-named value",
    pattern: shortSecretName("pass", { extraForms: [String.raw`(?<=-pass(?:in|out)[ \t]{1,8})pass:`] }),
  },
  // `pwd` is also the shell's working directory (`PWD=/home/runner/work`), so a value that starts like a path stays.
  { kind: "secret-named value", pattern: shortSecretName("pwd", { value: String.raw`(?![/~$.])${VALUE}` }) },
];

/**
 * The at sign and the dot as text carries them: plain, percent-encoded any number of times
 * (`%40` in a link or a `mailto:`, `%2540` once that link is encoded again), or as an HTML
 * character reference with or without its semicolon (`&#64;`, `&#x40`, `&commat;`), which
 * a browser reads the same either way. An address written in any of these is the same address.
 */
const AT_SIGN = String.raw`(?:@|＠|%(?:25){0,4}40|&#0{0,6}64;?|&#[xX]0{0,6}40;?|&commat;?)`;
const DOT = String.raw`(?:\.|%(?:25){0,4}2[eE]|&#0{0,6}46;?|&#[xX]0{0,6}2[eE];?|&period;?)`;

/** An email address: a bounded local part, an at sign in any form above, a domain with at least one dot. */
const EMAIL_PATTERN = new RegExp(
  String.raw`[A-Za-z0-9._%+-]{1,64}${AT_SIGN}[A-Za-z0-9-]{1,63}(?:${DOT}[A-Za-z0-9-]{1,63}){0,8}${DOT}[A-Za-z]{2,24}\b`,
  "g",
);

/** How many rounds of percent and HTML decoding `decodedForScan` makes before it stops. */
const MAX_DECODE_ROUNDS = 5;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  commat: "@",
  period: ".",
  sol: "/",
  colon: ":",
  lowbar: "_",
  hyphen: "-",
  plus: "+",
  equals: "=",
};

/** One round of percent-decoding (each run of `%XX` read as UTF-8) and HTML character references. */
function decodeOnce(text: string): string {
  const percent = text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run.replace(/%([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    }
  });
  return percent.replace(
    /&(?:#(\d{1,32})|#[xX]([0-9A-Fa-f]{1,32})|([A-Za-z]{2,8}));?/g,
    (match, dec?: string, hex?: string, name?: string) => {
      // Leading zeros are allowed in any number, as a browser reads them.
      const code = dec !== undefined ? Number(dec) : hex !== undefined ? parseInt(hex, 16) : null;
      if (code !== null) return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
      return NAMED_ENTITIES[name!.toLowerCase()] ?? match;
    },
  );
}

/**
 * `text` as a reader would see it once every encoding is undone: percent-encoding and HTML
 * character references decoded until nothing changes, then NFKC (which folds a fullwidth
 * `＠` into `@`) with invisible format characters (zero-width spaces, soft hyphens) removed.
 * Null when it still changes after `MAX_DECODE_ROUNDS` rounds: what it hides is unknown.
 * A check copy only, never stored.
 */
export function decodedForScan(text: string): string | null {
  let decoded = text;
  for (let round = 0; ; round++) {
    const next = decodeOnce(decoded);
    if (next === decoded) break;
    if (round === MAX_DECODE_ROUNDS) return null;
    decoded = next;
  }
  return decoded.normalize("NFKC").replace(/\p{Cf}/gu, "");
}

/** Any at sign with something before it, or one followed by a dotted name: an address, or part of one. */
const ADDRESS_SHAPED = /\S@|@[^\s@/]*[.。｡．][^\s@]/u;

/**
 * Credential shapes, looser than the scan's vendor patterns:
 * - a known vendor prefix and a run after it, without the word boundary the scan needs;
 *   `sk-`, `npm_` and `SG.` also end ordinary words ("task-start", "ask-misses"), so they
 *   count only where no letter or digit comes before them;
 * - any lowercase `prefix_` (up to three parts, later ones may hold digits: `hf_`, `shpat_`, `lin_api_`, `sk_test_`, `dop_v1_`)
 *   before 20 or more letters and digits, the form most vendors without a pattern use;
 * - a run of 24 or more letters and digits that mixes upper case, lower case and digits.
 * Every quantifier is bounded, so a check stays linear in the text's length.
 */
const CREDENTIAL_SHAPED = [
  /(?:gh[pousr]_|github_pat_|A[KS]IA|sk_live_|rk_live_|xox[abporse]-|glpat-|gldt-|glrt-)[A-Za-z0-9_.-]{12}/,
  /(?<![A-Za-z0-9])(?:sk-|npm_|SG\.)[A-Za-z0-9_.-]{12}/,
  /(?<![A-Za-z0-9])[a-z]{2,12}_(?:[a-z0-9]{1,12}_){0,2}[A-Za-z0-9]{20}/,
  /(?<![A-Za-z0-9])(?=[A-Za-z0-9]{0,256}[A-Z])(?=[A-Za-z0-9]{0,256}[a-z])(?=[A-Za-z0-9]{0,256}[0-9])[A-Za-z0-9]{24}/,
];

/**
 * Whether `text` may hold a secret or an email address in any encoding, for a field stored
 * verbatim, where a hit drops the field rather than scrubbing it. It reads the decoded copy
 * by shape, looser than the scan: an at sign with anything before it, a credential prefix
 * with no boundary, or the scan's own hit. A false hit only drops a field; a missed one leaks.
 * Text that will not finish decoding counts as a hit.
 */
export function holdsSecretOrAddress(text: string): boolean {
  const decoded = decodedForScan(text);
  if (decoded === null) return true;
  if (ADDRESS_SHAPED.test(decoded) || CREDENTIAL_SHAPED.some((shape) => shape.test(decoded))) return true;
  return scanForSecrets(decoded, { removeEmails: true }).text !== decoded;
}

/** How many capture groups a pattern has: an empty alternative always matches, with each group unset. */
function captureGroupCount(pattern: RegExp): number {
  return (new RegExp(`${pattern.source}|`).exec("")?.length ?? 1) - 1;
}

export interface ScanResult {
  /** The text with every secret, and every email address when asked, replaced by a marker. */
  text: string;
  /** The kind of each secret removed, one entry per match, in pattern order. Never a value. */
  findings: string[];
}

/**
 * Replace every credential-shaped string in `text` with `SECRET_MARKER`. With
 * `removeEmails`, every email address is replaced by `EMAIL_MARKER` as well;
 * emails are personal data, not secrets, so they are not counted in
 * `findings`.
 */
export function scanForSecrets(text: string, { removeEmails = false }: { removeEmails?: boolean } = {}): ScanResult {
  const findings: string[] = [];
  let scanned = text;
  for (const { kind, pattern } of SECRET_PATTERNS) {
    const captures = captureGroupCount(pattern);
    scanned = scanned.replace(pattern, (_match: string, ...rest: unknown[]) => {
      // After the match come its capture groups, then the offset and the whole input.
      const [keep = "", tail = ""] = rest.slice(0, captures).map((group) => (typeof group === "string" ? group : ""));
      findings.push(kind);
      return `${keep}${SECRET_MARKER}${tail}`;
    });
  }
  if (removeEmails) scanned = scanned.replace(EMAIL_PATTERN, EMAIL_MARKER);
  return { text: scanned, findings };
}
