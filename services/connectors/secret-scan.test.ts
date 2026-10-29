import { describe, expect, it } from "vitest";
import { EMAIL_MARKER, SECRET_MARKER, holdsSecretOrAddress, scanForSecrets } from "./secret-scan";

// Every credential below is assembled at runtime from made-up parts, so no
// literal token sits in the repository for a scanner to flag.
const join = (...parts: string[]) => parts.join("");
const CREDENTIALS: [kind: string, value: string][] = [
  ["GitHub token", join("gh", "p_", "a1B2".repeat(9))],
  ["GitHub token", join("github", "_pat_", "11ABCDEFG0", "x".repeat(70))],
  ["Anthropic key", join("sk-", "ant-", "api03-", "Zz9".repeat(10))],
  ["OpenAI key", join("sk-", "proj-", "q".repeat(24), "T3Blbk", "FJ", "r".repeat(24))],
  ["Stripe key", join("sk", "_live_", "4eC39HqLyjWDarjtT1zdp7dc")],
  ["Slack token", join("xo", "xb-", "1234567890-", "abcdefghijkl")],
  ["npm token", join("np", "m_", "a1B2c3D4".repeat(4), "e5F6")],
  ["GitLab token", join("gl", "pat-", "Ab3De5Gh7Jk9Mn1Pq3St")],
  ["SendGrid key", join("S", "G.", "a1_b".repeat(5), "c2", ".", "d3-e".repeat(10), "f4g")],
  ["AWS access key", join("AK", "IA", "EXAMPLE0", "KEYID000")],
  ["Google API key", join("AI", "za", "Sy", "D".repeat(33))],
  ["Willder capability token", join("wc", "ap_", "A".repeat(43))],
  [
    "JSON web token",
    join(
      "ey",
      "JhbGciOiJIUzI1NiJ9",
      ".",
      "ey",
      "JzdWIiOiIxMjM0NTY3ODkwIn0",
      ".",
      "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    ),
  ],
];

/** Every scan a linear-time test runs; a test adds a deliberately slow one here to see it fail. */
const SCANS: ((text: string) => unknown)[] = [
  (text) => scanForSecrets(text, { removeEmails: true }),
  holdsSecretOrAddress,
];

describe("scanForSecrets", () => {
  it.each(CREDENTIALS)("removes a %s and keeps the sentence around it", (kind, value) => {
    const { text, findings } = scanForSecrets(`Set it with export KEY=${value} before running.`);
    expect(text).toBe(`Set it with export KEY=${SECRET_MARKER} before running.`);
    expect(findings).toEqual([kind]);
  });

  it("removes a private key block whole", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE" + " KEY-----",
      "MIIEowIBAAKCAQEA",
      "x".repeat(64),
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const { text, findings } = scanForSecrets(`Deploy key:\n${pem}\nRotate it monthly.`);
    expect(text).toBe(`Deploy key:\n${SECRET_MARKER}\nRotate it monthly.`);
    expect(findings).toEqual(["private key"]);
  });

  it.each([
    ["an env line", "DB_PASSWORD=correct-horse-battery", "DB_PASSWORD="],
    ["a JSON key", '"api_key": "4f9c2e7a1b3d"', '"api_key": "'],
    ["a YAML key", "client_secret:  s3cr3t-value-here", "client_secret:  "],
    ["a token variable", "export SENTRY_AUTH_TOKEN='sntrys_abcdefgh123'", "export SENTRY_AUTH_TOKEN='"],
  ])("removes a secret-named value in %s and keeps the name", (_shape, line, kept) => {
    const { text, findings } = scanForSecrets(line);
    expect(text.startsWith(`${kept}${SECRET_MARKER}`)).toBe(true);
    expect(findings).toEqual(["secret-named value"]);
  });

  it.each([
    ["a long name", "passphrase: correct-horse-battery", "passphrase: "],
    ["a long name", "PASSCODE=8675309-0042", "PASSCODE="],
    ["a long name", "SSH_KEY_PASSPHRASE=q9Lm42pWr7xZ", "SSH_KEY_PASSPHRASE="],
    ["a long name", "AWS_SECRET_ACCESS_KEY=q9Lm42pWr7xZ", "AWS_SECRET_ACCESS_KEY="],
    ["a long name", '"accessKey": "q9Lm42pWr7xZ"', '"accessKey": "'],
    ["a short name in an env line", "DB_PASS=q9Lm42pWr7xZ", "DB_PASS="],
    ["a short name in an env line", "pwd=q9Lm42pWr7xZ", "pwd="],
    ["a short name in an env line", "DB_PASS=\tq9Lm42pWr7xZ", "DB_PASS=\t"],
    ["a short name in an env line", "export SMTP_PWD='q9Lm42pWr7xZ'", "export SMTP_PWD='"],
    ["a short name in a flag", "mysql --pass=q9Lm42pWr7xZ", "mysql --pass="],
    [
      "a short name in a query string",
      "https://api.example.com/login?user=ana&pwd=q9Lm42pWr7xZ",
      "https://api.example.com/login?user=ana&pwd=",
    ],
    ["a short name in code, quoted", 'pass = "q9Lm42pWr7xZ"', 'pass = "'],
    ["a short name in code, quoted", "DB_PASS: 'q9Lm42pWr7xZ'", "DB_PASS: '"],
    ["a short camelCase name, quoted", "const dbPass = 'q9Lm42pWr7xZ'", "const dbPass = '"],
    ["a short camelCase name, quoted", '{"dbPass": "q9Lm42pWr7xZ"}', '{"dbPass": "'],
    ["a short name as a JSON key", '{"pwd": "q9Lm42pWr7xZ"}', '{"pwd": "'],
    ["a short name as a JSON key", '{"db_pass": "q9Lm42pWr7xZ"}', '{"db_pass": "'],
    ["a short name as a YAML key", "redis.pass: q9Lm42pWr7xZ", "redis.pass: "],
    ["a short name as a YAML key", "redis:\n  host: cache\n  pass: q9Lm42pWr7xZ", "redis:\n  host: cache\n  pass: "],
    ["a short name as a YAML key", "users:\n  - pwd: q9Lm42pWr7xZ", "users:\n  - pwd: "],
    ["openssl's pass: form", "openssl pkcs12 -passin pass:q9Lm42pWr7xZ -in a.p12", "openssl pkcs12 -passin pass:"],
  ])("removes a secret-named value after %s and keeps the name: %s", (_shape, line, kept) => {
    const { text, findings } = scanForSecrets(line);
    expect(text.startsWith(`${kept}${SECRET_MARKER}`)).toBe(true);
    expect(findings).toEqual(["secret-named value"]);
  });

  it("leaves words, sentences, logs and code that only contain a short secret name alone", () => {
    // `pass` and `pwd` count only as the whole last part of a name, written the way a
    // credential is: unspaced, quoted, a JSON key or a YAML key at a line start.
    const prose = [
      "bypass: north-gate-entrance",
      "BYPASS=enabled-for-admins",
      "compass: north-by-northwest",
      "Compass=north-by-northwest",
      "encompass: every-workspace",
      "passage=chapter-twelve-onwards",
      "passport=AB12345678",
      "PASS_RATE=0.95123456",
      "password reset steps: see-the-wiki-page",
      "First pass: refactoring-the-parser",
      "first-pass: refactoring-the-parser",
      "Make sure the tests pass: integration-suite",
      "PASS: tests/unit/parser_spec.rb",
      "    PASS: tests/unit/parser_spec.rb",
      "TEST-PASS: integration-suite",
      "[ci] tests_pass: integration-suite-green",
      '"PASS": "TestParserHandlesEmpty"',
      "Pass: everything-green-today",
      "ByPass: north-gate-entrance",
      "const bloomPass: UnrealBloomPass = new UnrealBloomPass()",
      "  renderPass: RenderPass;",
      "onPass={handlePassClick}",
      "<Step firstPass={runFirstPass} />",
      "this.pass = passthroughStream",
      "run pwd: /home/user/project",
      "pwd: /home/user/project",
      "PWD=/home/runner/work/app/app",
      "export PWD=$(pwd)/build",
      "ROOT_PWD=~/out/bin",
    ].join("\n");
    expect(scanForSecrets(prose)).toEqual({ text: prose, findings: [] });
  });

  it("leaves names that hold a path, an id or an option alone: only a secret's own name counts", () => {
    const code = [
      "export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json",
      "fetch(url, { credentials: 'same-origin' })",
      "AWS_SHARED_CREDENTIALS_FILE=~/.aws/credentials",
      "credentialsProvider: DefaultCredentialsProvider",
      "accessKeyId: AKIA-is-not-here-yet",
      "PRIVATE_KEY_PATH=/etc/ssl/private/server.key",
      "--private-key=~/.ssh/id_ed25519",
      "PASSPHRASE_FILE=/run/secrets/signing-key",
    ].join("\n");
    expect(scanForSecrets(code)).toEqual({ text: code, findings: [] });
  });

  it.each([
    [
      "a link password inside a secret-named value",
      "DB_PASSWORD=postgres:" + "//admin:q9Lm42pWr7xZ@db/main",
      `DB_PASSWORD=postgres://${SECRET_MARKER}@db/main`,
      ["password in URL"],
    ],
    [
      "a link with no user inside a short name",
      "db_pass=redis:" + "//:q9Lm42pWr7xZ@cache",
      `db_pass=redis://${SECRET_MARKER}@cache`,
      ["password in URL"],
    ],
    ["a vendor token after a prefix", `PASS=abc-${CREDENTIALS[0][1]}`, `PASS=abc-${SECRET_MARKER}`, ["GitHub token"]],
  ])("counts %s once and keeps its marker whole", (_shape, line, expected, findings) => {
    expect(scanForSecrets(line)).toEqual({ text: expected, findings });
  });

  it("removes a PGP private key block whole", () => {
    const block = [
      "-----BEGIN PGP PRIVATE KEY BLOCK-----",
      "lQOYBF",
      "x".repeat(64),
      "-----END PGP PRIVATE KEY BLOCK-----",
    ].join("\n");
    const { text, findings } = scanForSecrets(`Signing key:\n${block}\nKeep it offline.`);
    expect(text).toBe(`Signing key:\n${SECRET_MARKER}\nKeep it offline.`);
    expect(findings).toEqual(["private key"]);
  });

  it("removes a Slack incoming webhook's secret path and keeps the host", () => {
    const hook = join("https://hooks.slack.com/services/", "T0123ABCD/", "B0123ABCD/", "aB3dE5gH7jK9mN1pQ3sT5vX7");
    const { text, findings } = scanForSecrets(`Alerts post to ${hook} today.`);
    expect(text).toBe(`Alerts post to https://hooks.slack.com/services/${SECRET_MARKER} today.`);
    expect(findings).toEqual(["Slack webhook"]);
  });

  it("removes a bearer token and keeps the header", () => {
    const { text } = scanForSecrets(`curl -H "Authorization: Bearer ${"Ab1.".repeat(8)}" https://api.example.com`);
    expect(text).toBe(`curl -H "Authorization: Bearer ${SECRET_MARKER}" https://api.example.com`);
  });

  it.each([
    "Authorization: bearer",
    "authorization: bearer",
    "AUTHORIZATION: BEARER",
    "Authorization:\tbEaReR",
    '"authorization": "bearer',
  ])("removes a bearer token after an Authorization header whatever the scheme's letter case: %s", (header) => {
    const { text, findings } = scanForSecrets(`${header} ${"Ab1.".repeat(8)}`);
    expect(text).toBe(`${header} ${SECRET_MARKER}`);
    expect(findings).toEqual(["bearer token"]);
  });

  it("leaves sentences about bearer tokens alone", () => {
    const prose = [
      "Bearer tokens are described in RFC 6750, and the bearer of a token holds its rights.",
      "We use bearer authentication/authorization for the API.",
      "Supports bearer AuthenticationMiddleware out of the box, see the bearer docs/authentication/bearer-tokens.md page.",
    ].join("\n");
    expect(scanForSecrets(prose)).toEqual({ text: prose, findings: [] });
  });

  it("counts a vendor token in a secret-named variable once, under its vendor", () => {
    const { text, findings } = scanForSecrets(`GITHUB_TOKEN=${CREDENTIALS[0][1]}`);
    expect(text).toBe(`GITHUB_TOKEN=${SECRET_MARKER}`);
    expect(findings).toEqual(["GitHub token"]);
  });

  it("leaves short and plural names alone: counts, limits and placeholders are not secrets", () => {
    const prose = "max_tokens: 4096\ntokens: input=unknown output=unknown\npassword: <yours>\nsecret: none";
    expect(scanForSecrets(prose)).toEqual({ text: prose, findings: [] });
  });

  // Load-independent: each input is grown until one scan of it takes at least 0.5 ms (from 1,000
  // characters, at most 400,000), then timed against ten times its size in the same run, the
  // minimum of seven runs each. Load only ever adds time, so the minimum is the clean measure.
  // A linear scan grows about 10x; a quadratic one about 100x (6 to 9 s at 100,000 characters).
  it("stays linear on hostile input: 10x the characters take well under 60x the time", () => {
    const units: [unit: string, per100k: number, tail?: string][] = [
      ["a.", 50_000],
      ["a", 100_000],
      ["a", 100_000, "@"],
      ["sk-", 33_000],
      ["x://y:", 16_000],
      ["token=", 16_000],
      ["-----BEGIN PGP PRIVATE KEY BLOCK-----", 2_700],
      ["https://hooks.slack.com/services/", 3_000],
      ["npm_", 25_000],
      ["glpat-", 16_000],
      ["SG.", 33_000],
      ["bearer ", 14_000],
      ["x://:", 20_000],
      ["pass=", 20_000],
      ["_PASS:", 16_000],
      ["\n pass:", 12_000],
      ["dbPass ", 14_000],
      ["passphrase=", 9_000],
      ["authorization: bearer ", 4_500],
      ["\n  - db_pass:", 7_000],
      ['"a_pwd": "', 9_000],
      [`pass=${"x".repeat(500)}[`, 190],
      ["a%25", 25_000],
      ["a&#0000", 14_000],
      ["ana%40example.", 7_000],
      ["aB1", 33_000],
      ["ab_cd_ef_", 11_000],
    ];
    const minimumOf = (runs: number, input: string, scan: (text: string) => unknown) =>
      Math.min(
        ...Array.from({ length: runs }, () => {
          const started = performance.now();
          scan(input);
          return performance.now() - started;
        }),
      );
    for (const scan of SCANS) {
      for (const [unit, per100k, tail = ""] of units) {
        let count = Math.max(1, Math.round(per100k / 100));
        while (count < per100k * 4 && minimumOf(1, unit.repeat(count) + tail, scan) < 0.5) count *= 2;
        const small = minimumOf(7, unit.repeat(count) + tail, scan);
        const large = minimumOf(7, unit.repeat(count * 10) + tail, scan);
        expect(large / small, `${JSON.stringify(unit.slice(0, 20))} x${count}`).toBeLessThan(60);
      }
    }
  }, 120_000);

  it("removes the password from a connection string and keeps its scheme", () => {
    const { text } = scanForSecrets("DATABASE_URL=postgres:" + "//app:hunter2@db.internal:5432/main");
    expect(text).toBe(`DATABASE_URL=postgres://${SECRET_MARKER}@db.internal:5432/main`);
  });

  it.each([
    ["REDIS_URL=redis:" + "//:q9Lm42pWr7xZ@cache:6379", `REDIS_URL=redis://${SECRET_MARKER}@cache:6379`],
    ["rediss://:q9Lm42pWr7xZ@10.0.0.5:6380/0", `rediss://${SECRET_MARKER}@10.0.0.5:6380/0`],
    [
      "git clone https://:q9Lm42pWr7xZ@git.example.com/repo.git",
      `git clone https://${SECRET_MARKER}@git.example.com/repo.git`,
    ],
  ])("removes a password from a link with no user name: %s", (line, expected) => {
    const { text, findings } = scanForSecrets(line);
    expect(text).toBe(expected);
    expect(findings).toEqual(["password in URL"]);
  });

  it("leaves links with a user and no password, and ports, alone", () => {
    const prose =
      "Clone ssh://git@github.com/acme/app.git, then open http://localhost:3000/@me and https://example.com:8443/docs.";
    expect(scanForSecrets(prose)).toEqual({ text: prose, findings: [] });
  });

  it("reports the kind of each secret, never its value", () => {
    const value = CREDENTIALS[0][1];
    const { findings } = scanForSecrets(`${value} and ${value}`);
    expect(findings).toEqual(["GitHub token", "GitHub token"]);
    expect(JSON.stringify(findings)).not.toContain(value);
  });

  it("leaves ordinary text alone, prefixes and look-alikes included", () => {
    const prose =
      "Use sk-learn for the model, ask about AKIA rules, see https://example.com/docs and ghp_ is the classic prefix. " +
      "npm_config_cache is an env var, glpat- starts a GitLab token, SG. starts a SendGrid key, and https://hooks.slack.com/services/ takes a path.";
    expect(scanForSecrets(prose)).toEqual({ text: prose, findings: [] });
  });

  it("removes email addresses only when asked, and does not count them as secrets", () => {
    const line = "Co-authored-by: Zoë Example <zoe.example+tag@mail.example.co.uk>";
    expect(scanForSecrets(line).text).toBe(line);
    expect(scanForSecrets(line, { removeEmails: true })).toEqual({
      text: `Co-authored-by: Zoë Example <${EMAIL_MARKER}>`,
      findings: [],
    });
  });

  // The same address, however a link, a mailto: or an HTML page writes its at sign.
  it.each([
    "ops%40example.com",
    "ops%2540example.com",
    "ops&#64;example.com",
    "ops&#064;example.com",
    "ops&#x40;example.com",
    "ops&#X40;example.com",
    "ops&commat;example.com",
    // Forms an HTML or URL decoder still reads as the address: no semicolon, a third encoding, an encoded dot.
    "ops&#64example.com",
    "ops%252540example.com",
    "ops&#64;example&#46;com",
    "ops%40example%2Ecom",
  ])("removes %s as an email address", (address) => {
    expect(scanForSecrets(`mailto:${address} first`, { removeEmails: true }).text).toBe(`mailto:${EMAIL_MARKER} first`);
  });

  it("leaves a percent-encoded at sign that names no address", () => {
    const text = "the %40 in a URL is an at sign; 100%40 of them";
    expect(scanForSecrets(text, { removeEmails: true }).text).toBe(text);
  });
});
