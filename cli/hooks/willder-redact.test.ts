// Redaction for session-state capture, layer by layer: what each layer removes, what it
// leaves alone, and that no input makes any of them slow. The capture-level tests (what
// reaches the stored fact) are in willder-capture.test.ts and willder-capture.qa.test.ts.
import { describe, expect, it } from "vitest";
import { isSecretName, redact } from "./willder-redact.mjs";

const SECRET = "Zq8vN3pLw2Rt6YxK9mB4";
const clean = (text: string, env: Record<string, string | undefined> = {}) => redact(`before ${text} after`, env);

describe("isSecretName", () => {
  it.each([
    "PASSWORD",
    "PGPASSWORD",
    "db_passwd",
    "passphrase",
    "Pwd",
    "DB_PASS",
    "pass",
    "pw",
    "token",
    "GITHUB_TOKEN",
    "authToken",
    "x-auth-token",
    "secret",
    "clientSecret",
    "api-key",
    "apiKey",
    "X-Api-Key",
    "API_KEY",
    "OPENAI_KEY",
    "privateKey",
    "private_key",
    "accessKey",
    "key",
    "signingKey",
    "authKey",
    "dbPass",
    "userPwd",
    "credentials",
    "Authorization",
    "Proxy-Authorization",
    "auth",
    "Cookie",
    "Set-Cookie",
    "SENTRY_DSN",
    "DATABASE_URL",
    "pat",
    "jwt",
  ])("says %s is secret", (name) => {
    expect(isSecretName(name)).toBe(true);
  });

  it.each(["HOME", "PATH", "passage", "monkey", "keyboard", "author", "NODE_ENV", "url", "user", "session_id", "Task"])(
    "says %s is not",
    (name) => {
      expect(isSecretName(name)).toBe(false);
    },
  );
});

describe("layer 1: values of secret-named environment variables", () => {
  it.each(["OPENAI_KEY", "SIGNING_KEY", "DB_PASS", "apiKey", "MY_SERVICE_TOKEN", "SENTRY_DSN"])(
    "removes the value of %s wherever it appears",
    (name) => {
      expect(clean(`used ${SECRET} here`, { [name]: SECRET })).toBe("before used [redacted] here after");
    },
  );

  it("leaves values shorter than 8 characters, and values of other variables, alone", () => {
    expect(clean("abc1234 /Users/someone", { SHORT_KEY: "abc1234", HOME: "/Users/someone" })).toBe(
      "before abc1234 /Users/someone after",
    );
  });
});

describe("layer 2: private key blocks", () => {
  it.each([
    ["an RSA key", "-----BEGIN RSA PRIVATE" + " KEY-----", "-----END RSA PRIVATE KEY-----"],
    ["a PKCS#8 key", "-----BEGIN PRIVATE" + " KEY-----", "-----END PRIVATE KEY-----"],
    ["an encrypted key", "-----BEGIN ENCRYPTED PRIVATE" + " KEY-----", "-----END ENCRYPTED PRIVATE KEY-----"],
    ["a PGP key block", "-----BEGIN PGP PRIVATE KEY BLOCK-----", "-----END PGP PRIVATE KEY BLOCK-----"],
  ])("removes %s through its END line", (_, begin, end) => {
    expect(clean(`${begin}\nMIIE${SECRET}\n${SECRET}==\n${end}`)).toBe("before [redacted] after");
  });

  it("removes a key with no END line to the end of the text", () => {
    expect(redact(`key: -----BEGIN OPENSSH PRIVATE ${"KEY"}-----\nb3Bl${SECRET}`, {})).toBe("key: [redacted]");
  });
});

describe("layer 3: URL userinfo", () => {
  it.each([
    [
      "user and password",
      "postgres:" + `//app:${SECRET}@db.example.com/app`,
      "postgres://[redacted]@db.example.com/app",
    ],
    [
      "a token as the whole userinfo",
      `https://${SECRET}@github.com/acme/repo.git`,
      "https://[redacted]@github.com/acme/repo.git",
    ],
    ["a password with / and @", "redis:" + `//:a/b@${SECRET}@cache:6379`, "redis://[redacted]@cache:6379"],
  ])("removes %s", (_, url, expected) => {
    expect(clean(url)).toBe(`before ${expected} after`);
  });

  it("leaves a URL without userinfo alone", () => {
    expect(clean("https://github.com/acme/repo/pull/664")).toBe("before https://github.com/acme/repo/pull/664 after");
  });
});

describe("layer 4: known token shapes", () => {
  it.each([
    ["a JWT", `eyJhbGciOiJIUzI1NiJ9.${"eyJ"}zdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl`],
    ["a Slack token", "xox" + "b-1234567890-abcdefghij"],
    ["an AWS access key id", "AKIA" + "ABCDEFGHIJKLMNOP"],
  ])("removes %s", (_, token) => {
    expect(clean(token)).toBe("before [redacted] after");
  });

  it("keeps the Bearer or Basic scheme and removes the credential", () => {
    expect(clean(`Bearer ${SECRET}`)).toBe("before Bearer [redacted] after");
  });
});

describe("layer 5: values of secret-named keys", () => {
  it.each([
    ["env", `DB_PASS=${SECRET} npm test`, "DB_PASS=[redacted] npm test"],
    ["YAML", `token: ${SECRET}`, "token: [redacted]"],
    ["JSON", `{"api-key": "${SECRET}", "region": "us"}`, `{"api-key": [redacted], "region": "us"}`],
    ["JSON in a JSON string", `{\\"password\\": \\"${SECRET}\\"}`, `{\\"password\\": [redacted]}`],
    [
      "a URL query",
      `https://x.example/v1?user=me&api_key=${SECRET}&page=2`,
      "https://x.example/v1?user=me&api_key=[redacted]&page=2",
    ],
    ["Ruby or PHP", `'password' => '${SECRET}'`, "'password' => [redacted]"],
    ["Go", `secret := "${SECRET}"`, "secret := [redacted]"],
    ["a connection string", `Server=db;Pwd=${SECRET};Database=app`, "Server=db;Pwd=[redacted];Database=app"],
    ["an X-*-Token header", `X-Auth-Token: ${SECRET}`, "X-Auth-Token: [redacted]"],
    [
      "an Authorization header, keeping its scheme",
      `Authorization: Token ${SECRET} x`,
      "Authorization: Token [redacted]",
    ],
    [
      "a Set-Cookie header, to the end of the line",
      `Set-Cookie: sid=${SECRET}; Path=/; HttpOnly\nnext line`,
      "Set-Cookie: [redacted]\nnext line",
    ],
  ])("removes the value in %s form", (_, text, expected) => {
    expect(redact(text, {})).toBe(expected);
  });

  it("removes every indented line of a YAML block scalar and keeps the next key", () => {
    const yaml = `db:\n  password: >-\n    ${SECRET}\n    ${SECRET}\n\n  host: db.internal\n`;
    expect(redact(yaml, {})).toBe("db:\n  password: [redacted]\n  host: db.internal\n");
  });

  it("still reaches a secret assignment inside the value of a key that is not secret", () => {
    expect(redact(`url=https://x.example/?password=${SECRET}`, {})).toBe("url=https://x.example/?password=[redacted]");
  });

  it("leaves keys that are not secret, and prose about secrets, alone", () => {
    const text = "region: us-east-1, user=app, timeout=30. Rotated the token and fixed the password reset.";
    expect(redact(text, {})).toBe(text);
  });
});

describe("layer 6: long runs that look random", () => {
  it.each([
    ["a base64 secret", "8f2KxQ9vLm3RtY7wN1pZcB6hJ4sD0gEa"],
    ["an AWS secret access key", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"],
    ["a long hex secret", "9a3f7c1e5b2d8f4a6c0e9b7d3f1a5c8e2b4d6f8a1c3e5b7d"],
  ])("removes %s", (_, run) => {
    expect(clean(run)).toBe("before [redacted] after");
  });

  it.each([
    ["a git commit id", "9fceb02d0ae598e95dc970b74767f19372d61af8"],
    ["a SHA-256 hex digest", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"],
    ["a UUID", "3f1c9a2e-77aa-4b1c-9d00-1234567890ab"],
    ["a long identifier", "AbstractSingletonProxyFactoryBeanImpl2Handler"],
    ["a file path", "src/components/Dashboard/WidgetContainerV2/index.tsx"],
    ["a constant name", "WILLDER_CAPTURE_SESSION_STATE_ENABLED_FOR_PROJECT_2026"],
    ["a repeating pattern", "xY1zxY1zxY1zxY1zxY1zxY1zxY1zxY1zxY1z"],
    ["a hex run with little variety", "000000000000000000000000000000000000ff"],
  ])("leaves %s alone", (_, run) => {
    expect(clean(run)).toBe(`before ${run} after`);
  });
});

describe("no input makes redaction slow", () => {
  // Each input is built to make one pattern rescan at every position or backtrack without
  // bound. 100,000 characters of plain prose take a few milliseconds.
  const N = 100_000;
  const repeat = (unit: string) => unit.repeat(Math.ceil(N / unit.length)).slice(0, N);
  const env = { SOME_TOKEN: "abcdefghij", DB_PASS: "xxxxxxxxx" };

  /** The fastest of three runs, so one slow scheduling slice on a busy machine does not fail the test. */
  const fastestMs = (text: string) =>
    Math.min(
      ...[0, 1, 2].map(() => {
        const started = performance.now();
        redact(text, env);
        return performance.now() - started;
      }),
    );

  it.each([
    ["URL scheme runs", "a."],
    ["URL scheme runs with hyphens", "a-"],
    ["URL scheme runs with plus signs", "ab+"],
    ["URL starts with no @", "a://"],
    ["JWT heads with no dots", "eyJaaaaaaaa-"],
    ["JWT heads with one dot", "eyJaaaaaaaa.aaaaaaaa."],
    ["vendor token prefixes", "sk-"],
    ["GitHub token prefixes", "ghp_"],
    ["Google key prefixes", "AIza"],
    ["Bearer with no credential", "Bearer "],
    ["private key BEGIN lines with no END", "-----BEGIN RSA PRIVATE" + " KEY-----\n"],
    ["secret keys with no value", "password="],
    ["unterminated double-quoted values", 'password: "'],
    ["unterminated escaped JSON values", 'password: \\"'],
    ["YAML block indicators", "password: |\n"],
    ["Authorization headers", "Authorization: Token "],
    ["one long name", "a"],
    ["long camelCase words", "FooBar"],
    ["base64-like runs", "Aa1"],
    ["hex-like runs", "a1"],
    ["secret keys with the value on the next line", "password:\n  "],
    ["secret-named flags with no value", "--token "],
    ["secret-named flags with word values", "--key abcdefgh "],
    ["YAML parents whose next line is a key", "password:\n  a: "],
    ["Bearer at the end of a line", "Bearer\n"],
    ["URL userinfo with a colon and no @", "a://b:c"],
    ["path-like runs", "ab/"],
    ["weak names with word values", "key=abcdefgh "],
  ])("redacts 100,000 characters of %s in under 200 ms", (_, unit) => {
    expect(fastestMs(repeat(unit))).toBeLessThan(200);
  });
});

describe("round 4: values on the next line, and content that is not a secret", () => {
  it("keeps a YAML mapping under a secret-named parent: the child is a key, not the parent's value", () => {
    const yaml = "password:\n  # rotated yearly\n  min_length: 8\n  require_digit: true\n";
    expect(redact(yaml, {})).toBe(yaml);
  });

  it("removes a Bearer credential on the line after the scheme, and keeps prose about Basic authentication", () => {
    expect(redact(`-H "Authorization: Bearer\n  ${SECRET}"`, {})).not.toContain(SECRET);
    expect(redact(`curl -H Bearer\n  ${SECRET}`, {})).toBe("curl -H Bearer [redacted]");
    expect(redact("Basic authentication is off for this route.", {})).toBe(
      "Basic authentication is off for this route.",
    );
  });

  it("treats *_PRIVATE names as secret, and keeps an ordinary value after private:", () => {
    expect(redact(`ssh with ${SECRET}`, { SSH_PRIVATE: SECRET })).toBe("ssh with [redacted]");
    expect(isSecretName("APP_PRIVATE")).toBe(true);
    expect(redact('{"name": "app", "private": true}', {})).toBe('{"name": "app", "private": true}');
  });

  it.each([
    ["a JSX key", "<li key={todo.itemId}>"],
    ["a database key", "primary key: id"],
    ["a version pin", "pin: latest"],
    ["prose after auth:", "auth: required for writes"],
  ])("keeps an ordinary word after a weak secret name: %s", (_, text) => {
    expect(redact(text, {})).toBe(text);
  });

  it.each([
    ["key=", `key=${SECRET}`, "key=[redacted]"],
    ["pin:", "pin: 4821", "pin: [redacted]"],
    ["auth:", `auth: ${SECRET}`, "auth: [redacted]"],
    ["api-key=, which is strong even for a plain word", "api-key=correcthorse", "api-key=[redacted]"],
    ["X-Api-Key:, likewise", "X-Api-Key: correcthorse", "X-Api-Key: [redacted]"],
    ["key: with a mixed-case value", "key: AbCdEfGhIj", "key: [redacted]"],
    ["auth: with a long passphrase", "auth: correcthorsebatterystaple", "auth: [redacted]"],
  ])("still removes a value that looks like one after %s", (_, text, expected) => {
    expect(redact(text, {})).toBe(expected);
  });

  it.each([
    ["a path with a content-hash file name", "public/images/hero-4f3a2b1c9d8e7f60.png"],
    ["a Go vendor path", "vendor/github.com/aws/aws-sdk-go-v2/service/s3/api_op_PutObject.go"],
    ["a Java package path", "src/main/java/com/example/billing/MyAPIClientImpl2Factory.java"],
    ["an md5 sum", "d41d8cd98f00b204e9800998ecf8427e"],
  ])("keeps %s", (_, text) => {
    expect(clean(text)).toBe(`before ${text} after`);
  });

  it("removes only the random segment of a path, and an md5-length hex value given to a secret name", () => {
    expect(clean("uploads/8f2KxQ9vLm3RtY7wN1pZcB6hJ4sD0gEa/avatar.png")).toBe(
      "before uploads/[redacted]/avatar.png after",
    );
    expect(redact("api_key=d41d8cd98f00b204e9800998ecf8427e", {})).toBe("api_key=[redacted]");
  });

  it.each([
    ["an @ in a Medium path", "https://medium.com/@someone/a-post-1a2b"],
    ["an @ in a package path", "https://unpkg.com/react@18.3.1/umd/react.production.min.js"],
    ["a port and an @ in the path", "http://localhost:3000/pkg@2/index.js"],
  ])("keeps a URL with %s: only userinfo before the host is removed", (_, url) => {
    expect(clean(url)).toBe(`before ${url} after`);
  });
});

describe("round 5: secret-named command-line flags", () => {
  it.each([
    [
      "an md5-length hex token after --token",
      "deploy --token d41d8cd98f00b204e9800998ecf8427e --prod",
      "deploy --token [redacted] --prod",
    ],
    ["a plain word after --api-key", "cli --api-key correcthorse", "cli --api-key [redacted]"],
    ["a quoted password after --password", `mysql --password "s3cr3t pass" db`, "mysql --password [redacted] db"],
    ["a secret after a single-dash flag", "tool -secret Zq8vN3pLw2Rt6YxK9mB4", "tool -secret [redacted]"],
    [
      "a token after --with-token, judged by its last two words",
      "gh auth login --with-token Zq8vN3pLw2Rt6YxK9mB4",
      "gh auth login --with-token [redacted]",
    ],
  ])("removes %s", (_, text, expected) => {
    expect(redact(text, {})).toBe(expected);
  });

  it.each([
    ["a weak flag with an ordinary word", "aws --auth-type bearer"],
    ["a flag with no value", "gh auth login --with-token < token.txt"],
    ["a flag that is not secret", "npm test -- --reporter verbose"],
    ["a weak flag with a version", "tool --pin latest"],
    ["a secret-named flag followed by another flag", "tool --token --verbose"],
    ["a secret word inside a hyphenated word", "rotate the api-token monthly"],
    ["a flag whose secret word is not one of its last two", "client --token-refresh-interval 30"],
  ])("keeps %s", (_, text) => {
    expect(redact(text, {})).toBe(text);
  });
});

describe("round 5: what makes a run with a slash a path", () => {
  it("needs two segments written in words: one is not enough, so a short-segment random run is judged whole", () => {
    expect(clean("uploads/Zq8vN3pLw2Rt6YxK9mB4Zq8vN3pL")).toBe("before [redacted] after");
  });

  it.each([
    "imDzxhNclNEzzrnlxyD/+UmhJmi8utlr",
    "76blzo/+C1wi2UQBMWKGFAKVb648OPlJuwk/Mmgj",
    "ultHrZnigTsWbfl/chgdD6P8xW32iRzj/aig+ndx",
    "x/Nq95EjYFg/cmqm/npPG9eGsw8ALqTy/lb+avvy",
  ])("judges a run with + or = as base64, not a path, even when two of its segments read as words: %s", (secret) => {
    expect(clean(secret)).toBe("before [redacted] after");
  });

  // Random base64 with `/` and no `+` or `=`, each judged whole only because of one part of
  // the path vote; found by sampling, one pair per part.
  it.each([
    ["a segment must be mostly lower case (85%)", "shIsokQ5OcLlO/HSfxKqpdzZlq/bpjhw"],
    ["a segment must be mostly lower case (85%)", "qaaKUIckZhzvzDSLXo/mTGObfffznFYH"],
    ["a segment must not look random itself", "q4Gytcu/BbzCQlzu53Vpfvjrn1leYsht"],
    ["a segment must not look random itself", "ehjon/lUJDmsxw5rIezrb24dbhx/iPjv"],
    ["a segment's letter pieces must average 3+", "9qnkbq08x834qnTae/El389GcnGctf3h"],
    ["a segment's letter pieces must average 3+", "mjjxUMm/boPRREujf7Fy9mYsiV6PFs/snAxhBift"],
    ["at least half the segments must read as words", "word/Xq9ZpW/Rt6YkQ/mB4KzN/Lp3QxV/text"],
  ])("judges slash-holding base64 whole: %s (%s)", (_, secret) => {
    expect(clean(secret)).toBe("before [redacted] after");
  });

  it("still keeps a path of words and removes only its random segment", () => {
    expect(clean("uploads/8f2KxQ9vLm3RtY7wN1pZcB6hJ4sD0gEa/avatar.png")).toBe(
      "before uploads/[redacted]/avatar.png after",
    );
  });
});
