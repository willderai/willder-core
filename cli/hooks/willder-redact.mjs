// Secret redaction for what the Willder hook writes into memory (willder-capture.mjs).
//
// Session-state capture sends text an agent produced: its last message, the test command it
// ran and that run's result line, the names of the files it changed, the task it was given.
// Any of these can quote a credential. `redact` replaces what looks like one with
// "[redacted]" before anything leaves the machine. It is best-effort: it removes the forms
// below, and words an agent writes about a secret in prose of its own are not detected.
//
// It runs in layers, each a separate pass:
//
// 1. Values of the caller's own secret-named environment variables, wherever they appear
//    (`OPENAI_KEY`, `DB_PASS`, `GITHUB_TOKEN`, ...; see `isSecretName`).
// 2. Private key blocks: PEM (`-----BEGIN ... PRIVATE KEY-----`) and PGP
//    (`-----BEGIN PGP PRIVATE KEY BLOCK-----`), to their END line or, without one, to the end.
// 3. A URL's userinfo before the host: user and password (to the last `@`) or a bare token.
//    An `@` in the path (`medium.com/@user`, `unpkg.com/react@18`) is not userinfo.
// 4. Known token shapes: Willder, Anthropic/OpenAI/Stripe-style, GitHub, GitLab, Slack, AWS,
//    Google, npm, JWTs, and `Bearer`/`Basic` credentials.
// 5. The value given to a secret-named key, in env (`KEY=v`), YAML (`key: v`, and the
//    indented lines of a `key: |` or `key: >` block), JSON (`"key": "v"`, escaped quotes and
//    JSON-in-a-string included), URL query (`?key=v`), Ruby/PHP (`key => v`), Go (`key := v`)
//    and HTTP header (`Authorization: <any scheme> v`, `X-Api-Key: v`, `Cookie: ...`) form,
//    on the key's line or, when that is empty, on the next indented line that is not itself
//    a key. A name is secret-named when one of its words, split at `-`, `_`, `.` and
//    camelCase, is a secret word (`isSecretName`). A secret-named command-line flag
//    (`--token v`, `-secret v`) gives up the word after it the same way. Words that also
//    name ordinary things (`key`, `pin`, `auth`, `private`) only give up a value that looks
//    like a credential.
// 6. Any remaining long run that looks random: 32+ base64 or hex characters with high
//    character entropy. Checksum and id lengths of hex (32, 40, 64) are kept, a UUID's
//    entropy is below the bar, and in a path only a random-looking segment is removed.
//
// The one rule this file enforces: every pattern is bounded, so redaction takes time linear
// in its input. Each quantifier has an upper limit and no pattern can restart a long scan at
// every position; cli/hooks/willder-redact.test.ts times each against a 100,000-character
// adversarial input.
//
// Zero dependencies on purpose: it is copied into projects beside willder-capture.mjs.

const REDACTED = "[redacted]";

/** The shortest environment value removed by value: shorter ones match ordinary words. */
const MIN_SECRET_VALUE_CHARS = 8;

/** The longest value layer 5 removes after a secret-named key, in characters. */
const MAX_VALUE_CHARS = 4096;

/** The longest key name layer 5 considers, in characters; a longer one is left alone. */
const MAX_NAME_CHARS = 256;

/** The most indented lines layer 5 removes after a YAML `key: |` or `key: >`. */
const MAX_BLOCK_LINES = 200;

/** Words that make a name secret wherever they appear inside one of its words. */
const SECRET_STEMS = [
  "password",
  "passwd",
  "passphrase",
  "secret",
  "token",
  "credential",
  "apikey",
  "privatekey",
  "accesskey",
  "authorization",
];

/** Words that make a name secret only as a whole word (`DB_PASS`, `Pwd`), not inside one (`passage`). */
const SECRET_WORDS = new Set(["pass", "pwd", "pw", "cookie", "cookies", "dsn", "jwt"]);

/**
 * Whole words that make a name secret but also name ordinary things (`key={item.id}`, `primary key: id`,
 * `pin: latest`, `"private": true`). A name that is secret only through these gives up its
 * value only when the value looks like one (`looksLikeValue`).
 */
const WEAK_WORDS = new Set(["key", "auth", "pat", "pin", "private"]);

/** Names whose value is the rest of the header line: an Authorization scheme and credential, or several cookies. */
const WHOLE_LINE_WORDS = new Set(["authorization", "cookie", "cookies"]);

/**
 * The words of a name: split at anything not a letter or digit, and between a lower-case
 * letter or digit and an upper-case one, lower-cased. `X-Api-Key` and `apiKey` both give
 * ["...", "api", "key"].
 * @param {string} name
 */
function wordsOf(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * How strongly a variable, key or header name says its value is a secret: "strong", "weak"
 * (only through WEAK_WORDS), or null when it does not. A stem split across words
 * (`api-key`, `privateKey`) counts as strong.
 * @param {string} name
 * @returns {"strong" | "weak" | null}
 */
function secretStrength(name) {
  const words = wordsOf(name);
  const joined = words.join("_");
  if (
    SECRET_STEMS.some((stem) => joined.replaceAll("_", "").includes(stem)) ||
    words.some((word) => SECRET_WORDS.has(word)) ||
    joined.includes("database_url") ||
    joined.includes("connection_string")
  ) {
    return "strong";
  }
  return words.some((word) => WEAK_WORDS.has(word)) ? "weak" : null;
}

/**
 * Whether a variable, key or header name says its value is a secret.
 * @param {string} name
 */
export function isSecretName(name) {
  return secretStrength(name) !== null;
}

/**
 * Whether a value looks like a credential rather than an ordinary word or a code expression:
 * 4 to 12 digits (a PIN or code), or 8+ characters mixing letters and digits or upper and
 * lower case past the first letter, or 20+ characters. Quotes around it are ignored.
 * @param {string} raw
 */
function looksLikeValue(raw) {
  const value = raw.replace(/^\\?["']|\\?["']$/g, "");
  if (/^[{([$`<]/.test(value)) return false;
  if (/^[0-9]{4,12}$/.test(value)) return true;
  if (value.length < 8) return false;
  return (
    (/[0-9]/.test(value) && /[A-Za-z]/.test(value)) ||
    (/[a-z]/.test(value) && /[A-Z]/.test(value.slice(1))) ||
    value.length >= 20
  );
}

/** Layer 1: the values of secret-named environment variables, longest first. */
function redactEnvValues(text, env) {
  const values = Object.entries(env)
    .filter(
      ([name, value]) => typeof value === "string" && value.length >= MIN_SECRET_VALUE_CHARS && isSecretName(name),
    )
    .map(([, value]) => value)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const value of values) out = out.split(value).join(REDACTED);
  return out;
}

const KEY_BEGIN = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g;
const KEY_END = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g;

/** Layer 2: private key blocks, from BEGIN through END, or to the end of the text when END is missing. */
function redactPrivateKeys(text) {
  let out = "";
  let from = 0;
  KEY_BEGIN.lastIndex = 0;
  for (let begin = KEY_BEGIN.exec(text); begin; begin = KEY_BEGIN.exec(text)) {
    KEY_END.lastIndex = begin.index + begin[0].length;
    const end = KEY_END.exec(text);
    out += `${text.slice(from, begin.index)}${REDACTED}`;
    from = end ? end.index + end[0].length : text.length;
    KEY_BEGIN.lastIndex = from;
  }
  return out + text.slice(from);
}

/**
 * Layer 3: a URL's userinfo, which comes before the host. Either `user:password@`, where the
 * password may hold `/` or `@` and runs to the last `@` before whitespace (but `host:port/`
 * is not a password), or a bare token with no `/` or `:` before its `@`. An `@` after the
 * host (`medium.com/@user`, `unpkg.com/react@18`) is left alone. The scheme is at most 32
 * characters and each part of the userinfo at most 256.
 */
const URL_USERINFO =
  /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/)(?:[^\s/:@]{0,256}:(?![0-9]{1,5}(?:[/?#\s]|$))\S{0,256}@|[^\s/:@]{1,256}@)/g;

/** Layer 4: token and key shapes with what each becomes. Every run has an upper bound. */
const TOKEN_SHAPES = [
  [/\b(?:wcap|sk|rk|pk)[-_](?:live_|test_|ant-[a-z0-9]{1,16}-)?[A-Za-z0-9_-]{12,512}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,255}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,255}/g, REDACTED],
  [/\bglpat-[A-Za-z0-9_-]{20,255}/g, REDACTED],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,255}/g, REDACTED],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{35}/g, REDACTED],
  [/\bnpm_[A-Za-z0-9]{36}/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,512}\.[A-Za-z0-9_-]{8,8192}\.[A-Za-z0-9_-]{8,2048}/g, REDACTED],
  // The credential may start on the next line; "Basic authentication" in prose is kept.
  [
    /\b(Bearer|Basic)(?:[ \t]{1,8}|[ \t]{0,8}\r?\n[ \t]{0,64})([A-Za-z0-9._~+/=-]{8,4096})/gi,
    (match, scheme, credential) => (looksLikeValue(credential) ? `${scheme} ${REDACTED}` : match),
  ],
];

/**
 * Layer 5's key: a whole name (it starts where the previous character cannot be part of
 * one), an optional closing quote (escaped for JSON inside a string), and the separator.
 */
const KEY_AND_SEPARATOR = new RegExp(
  String.raw`(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]{1,${MAX_NAME_CHARS}})((?:\\?["'])?[ \t]{0,8}(?:=>|:=|=|:)[ \t]{0,8})`,
  "g",
);

/** The value forms after a secret-named key, each tried at the separator's end. */
const ESCAPED_QUOTED = new RegExp(String.raw`\\"(?:(?!\\")[^\n]){0,${MAX_VALUE_CHARS}}(?:\\")?`, "y");
const DOUBLE_QUOTED = new RegExp(String.raw`"(?:[^"\\\n]|\\.){0,${MAX_VALUE_CHARS}}"?`, "y");
const SINGLE_QUOTED = new RegExp(String.raw`'[^'\n]{0,${MAX_VALUE_CHARS}}'?`, "y");
const BLOCK_SCALAR = /[|>][+-]?[0-9]?[ \t]*(?=\r?\n)/y;
/** A known Authorization scheme before its credential; it is kept, and the credential removed. */
const AUTH_SCHEME =
  /(?:Bearer|Basic|Token|Digest|Negotiate|NTLM|OAuth|DPoP|ApiKey|Key|JWT|AWS4-HMAC-SHA256)[ \t]{1,8}(?=[^\s"'])/iy;
const REST_OF_HEADER = new RegExp(String.raw`[^\r\n"']{1,${MAX_VALUE_CHARS}}`, "y");
const BARE_VALUE = new RegExp(String.raw`[^\s"'&;,<>]{1,${MAX_VALUE_CHARS}}`, "y");
/** A value a formatter or YAML writer moved to the next, indented line. */
const NEXT_LINE = /[ \t]{0,8}\r?\n[ \t]{1,64}(?=\S)/y;
/** A line that is itself a key (a YAML child mapping, possibly a list item), so not the value above it. */
const KEY_LINE = new RegExp(
  String.raw`(?:-[ \t]+)?[A-Za-z0-9_.-]{1,${MAX_NAME_CHARS}}["']?[ \t]{0,8}(?:=>|:=|=|:)(?=\s|$)|#`,
  "y",
);

/** The length of the value at `at`, the first form that matches, or 0. */
function matchAt(pattern, text, at) {
  pattern.lastIndex = at;
  return pattern.exec(text)?.[0].length ?? 0;
}

/**
 * Where the indented lines of a YAML block scalar end: every following line indented more
 * than the key's own line, or blank, up to MAX_BLOCK_LINES.
 */
function blockEnd(text, keyAt, indicatorEnd) {
  const lineStart = text.lastIndexOf("\n", keyAt - 1) + 1;
  const keyIndent = /^[ \t]*/.exec(text.slice(lineStart, keyAt))[0].length;
  let end = indicatorEnd;
  for (let lines = 0; lines < MAX_BLOCK_LINES; lines++) {
    const next = text.indexOf("\n", end);
    if (next === -1) break;
    const lineEnd = text.indexOf("\n", next + 1);
    const line = text.slice(next + 1, lineEnd === -1 ? text.length : lineEnd);
    const indent = /^[ \t]*/.exec(line)[0].length;
    if (line.trim() !== "" && indent <= keyIndent) break;
    end = lineEnd === -1 ? text.length : lineEnd;
    if (lineEnd === -1) break;
  }
  return end;
}

/** The length of the value at `valueAt` in any of the inline forms, or 0. */
function inlineValueLength(text, valueAt, words) {
  return (
    matchAt(ESCAPED_QUOTED, text, valueAt) ||
    matchAt(DOUBLE_QUOTED, text, valueAt) ||
    matchAt(SINGLE_QUOTED, text, valueAt) ||
    (words.some((word) => WHOLE_LINE_WORDS.has(word)) ? matchAt(REST_OF_HEADER, text, valueAt) : 0) ||
    matchAt(BARE_VALUE, text, valueAt)
  );
}

/**
 * A command-line flag (`--token`, `-secret`) and the spaces after it. Its value is the next
 * quoted or bare word, unless that is another flag or a redirection.
 */
const FLAG = /(?<![A-Za-z0-9_-])(--?[A-Za-z][A-Za-z0-9_-]{0,63})[ \t]{1,8}(?=[^\s-])/g;

/** Layer 5, flag form: the value given to a secret-named flag, held to the same weak-name rule. */
function redactSecretFlags(text) {
  let out = "";
  let from = 0;
  FLAG.lastIndex = 0;
  for (let flag = FLAG.exec(text); flag; flag = FLAG.exec(text)) {
    // A flag is judged by its last two words, which say what its value is: `--with-token`
    // and `--api-key` take a secret, `--passWithNoTests` and `--token-refresh-interval` do not.
    const strength = secretStrength(wordsOf(flag[1]).slice(-2).join("_"));
    if (!strength) continue;
    const valueAt = flag.index + flag[0].length;
    const length =
      matchAt(DOUBLE_QUOTED, text, valueAt) ||
      matchAt(SINGLE_QUOTED, text, valueAt) ||
      matchAt(BARE_VALUE, text, valueAt);
    if (!length || (strength === "weak" && !looksLikeValue(text.slice(valueAt, valueAt + length)))) continue;
    out += `${text.slice(from, valueAt)}${REDACTED}`;
    from = valueAt + length;
    FLAG.lastIndex = from;
  }
  return out + text.slice(from);
}

/** Layer 5: the value given to every secret-named key. */
function redactSecretAssignments(text) {
  let out = "";
  let from = 0;
  KEY_AND_SEPARATOR.lastIndex = 0;
  for (let key = KEY_AND_SEPARATOR.exec(text); key; key = KEY_AND_SEPARATOR.exec(text)) {
    const [, name, separator] = key;
    const strength = secretStrength(name);
    if (!strength) {
      // A name that is not secret consumes only itself and its separator, so a secret
      // assignment inside its value (`url=https://x?password=y`) is still reached.
      continue;
    }
    let valueAt = key.index + name.length + separator.length;
    const words = wordsOf(name);
    if (words.includes("authorization")) valueAt += matchAt(AUTH_SCHEME, text, valueAt);
    let valueEnd = valueAt;
    const block = matchAt(BLOCK_SCALAR, text, valueAt);
    if (block) {
      valueEnd = blockEnd(text, key.index, valueAt + block);
    } else {
      let length = inlineValueLength(text, valueAt, words);
      if (!length) {
        // Nothing on the key's line: the value may be on the next, indented line, unless
        // that line is a key of its own (`password:` as a YAML parent) or a comment.
        const wrap = matchAt(NEXT_LINE, text, valueAt);
        if (wrap && !matchAt(KEY_LINE, text, valueAt + wrap)) {
          valueAt += wrap;
          length = inlineValueLength(text, valueAt, words);
        }
      }
      valueEnd = valueAt + length;
    }
    if (valueEnd === valueAt) continue;
    if (strength === "weak" && !looksLikeValue(text.slice(valueAt, valueEnd))) continue;
    out += `${text.slice(from, valueAt)}${REDACTED}`;
    from = valueEnd;
    KEY_AND_SEPARATOR.lastIndex = valueEnd;
  }
  return out + text.slice(from);
}

/** Layer 6's candidates: runs of base64, base64url or hex characters, 32 to 4,096 long. */
const RANDOM_LOOKING_RUN = /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/=_-]{32,4096}(?![A-Za-z0-9+/=_-])/g;
const HEX_ONLY = /^[0-9a-fA-F]+$/;

/** Shannon entropy of `text`'s characters, in bits per character. */
function entropy(text) {
  const counts = new Map();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** The pieces a name or path is written in: capitalised or lower-case words, upper-case runs, digit runs. */
const WORD_PIECES = /[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[0-9]+/g;

/**
 * Whether a run looks random rather than like a word, a path or an identifier. Hex needs 3
 * bits of entropy per character and is kept at md5, git object id and SHA-256 lengths (32,
 * 40, 64): those are checksums and ids far more often than secrets, and a secret-named key
 * given one is caught by layer 5. Anything else
 * needs 4 bits per character, two of upper case, lower case and digits, and short pieces: an
 * identifier or path is written in words (`AbstractProxyFactoryBean`, `services/orders`),
 * which average 4 or more characters, and random text is not.
 */
function looksRandom(run) {
  if (HEX_ONLY.test(run)) return ![32, 40, 64].includes(run.length) && entropy(run) >= 3;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((cls) => cls.test(run)).length;
  if (classes < 2 || entropy(run) < 4) return false;
  const pieces = run.match(WORD_PIECES) ?? [];
  const letters = pieces.filter((piece) => /[A-Za-z]/.test(piece));
  const averageLength = letters.reduce((sum, piece) => sum + piece.length, 0) / Math.max(letters.length, 1);
  return averageLength < 4;
}

/** Whether a path segment is written mostly in lower case, as directory and file names are and base64 is not. */
function lowerCaseMostly(segment) {
  const letters = segment.replace(/[^A-Za-z]/g, "");
  const lower = segment.replace(/[^a-z]/g, "");
  return letters.length > 0 && lower.length / letters.length >= 0.85;
}

/** The average length of a segment's letter pieces (`api_op_PutObject`: api, op, Put, Object). */
function averageLetterPiece(segment) {
  const letters = (segment.match(WORD_PIECES) ?? []).filter((piece) => /[A-Za-z]/.test(piece));
  return letters.reduce((sum, piece) => sum + piece.length, 0) / Math.max(letters.length, 1);
}

/**
 * Whether a path segment is written in words: mostly lower case, not random itself, and
 * with letter pieces of 3 or more characters on average. A short slice of base64 is mostly
 * lower case one time in several, but rarely all three.
 */
function writtenInWords(segment) {
  return lowerCaseMostly(segment) && !looksRandom(segment) && averageLetterPiece(segment) >= 3;
}

/**
 * A run with `/` and no `+` or `=` (which base64 has and paths almost never do) is a path
 * when at least two of its segments longer than 3 characters, and at least half of them,
 * are written in words; then only a segment of 32+ characters that looks random is removed
 * (`uploads/<random>/avatar`), and a content-hash file name or a vendor path is kept.
 * Otherwise it is base64, and judged whole. The cost: a path of digits and one hash
 * (`storage/2026/10/12/<md5>`) is judged whole too.
 */
function redactRun(run) {
  if (run.includes("/") && !/[+=]/.test(run)) {
    const segments = run.split("/");
    const voting = segments.filter((segment) => segment.length > 3);
    const inWords = voting.filter(writtenInWords).length;
    if (inWords >= 2 && inWords * 2 >= voting.length) {
      return segments.map((segment) => (segment.length >= 32 && looksRandom(segment) ? REDACTED : segment)).join("/");
    }
  }
  return looksRandom(run) ? REDACTED : run;
}

/** Layer 6: long runs that look random. */
function redactRandomRuns(text) {
  return text.replace(RANDOM_LOOKING_RUN, redactRun);
}

/**
 * `text` with every secret the layers above recognise replaced by "[redacted]". `env` is the
 * hook's environment; the values of its secret-named variables are removed wherever they
 * appear. Best-effort, and linear in the length of `text`.
 * @param {string} text
 * @param {Record<string, string | undefined>} env
 */
export function redact(text, env) {
  let out = redactEnvValues(text, env);
  out = redactPrivateKeys(out);
  out = out.replace(URL_USERINFO, `$1${REDACTED}@`);
  for (const [pattern, replacement] of TOKEN_SHAPES) out = out.replace(pattern, replacement);
  out = redactSecretAssignments(out);
  out = redactSecretFlags(out);
  return redactRandomRuns(out);
}
