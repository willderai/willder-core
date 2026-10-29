// A failed request's credentials never reach printed output.
//
// In one local run, a Playwright DELETE timeout printed its call log,
// cookie header included, to stderr. The values below are made up but shaped like Clerk's
// cookies, including the non-JWT ones a token-shape redaction misses.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { request } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exposesRequestHeaders, printableBody, printableError, redactRequestHeaders } from "./request-headers";

const CLIENT = "client_2xYzAbCdEfGhIjKlMnOpQrStUv";
const REFRESH = "rf_9QwErTyUiOpAsDfGhJkLzXcVbNm";

/** The shape of a Playwright APIRequestContext timeout. */
const PLAYWRIGHT_TIMEOUT = [
  "apiRequestContext.delete: Timeout 120000ms exceeded.",
  "Call log:",
  "  - → DELETE https://willder.example/api/memory/facts/v1?scope=org_x.demo",
  "  -   user-agent: Mozilla/5.0",
  "  -   accept: */*",
  `  -   cookie: __client_uat=1759900000; __client=${CLIENT}; __refresh_AbCd=${REFRESH}`,
  "  -   Authorization: Bearer wcap_fake",
].join("\n");

const BYPASS = "byp_7hGfDsAqWeRtYuIoPlKjHgFd";
const CAPABILITY = "wcap_" + "9sDfGhJkLqWeRtYuIoPzXcVbNm";

/**
 * A Playwright 1.61.1 DELETE timeout exactly as it prints, default or NO_COLOR=1: every
 * call-log line is wrapped in ANSI dim codes, so a header line starts with ESC, not a space.
 */
const PLAYWRIGHT_1_61_TIMEOUT = [
  "apiRequestContext.delete: Timeout 500ms exceeded.",
  "Call log:",
  "\x1b[2m  - → DELETE http://127.0.0.1:34415/api/memory/facts/v1?scope=x\x1b[22m",
  "\x1b[2m    - user-agent: Playwright/1.61.1 (x64; ubuntu 24.04) node/22.22\x1b[22m",
  "\x1b[2m    - accept: */*\x1b[22m",
  "\x1b[2m    - accept-encoding: gzip,deflate,br\x1b[22m",
  `\x1b[2m    - cookie: __client=${CLIENT}; __refresh_AbCd=${REFRESH}\x1b[22m`,
  `\x1b[2m    - authorization: Bearer ${CAPABILITY}\x1b[22m`,
  `\x1b[2m    - x-vercel-protection-bypass: ${BYPASS}\x1b[22m`,
  "",
].join("\n");

const SECRETS = [CLIENT, REFRESH, CAPABILITY, BYPASS];

describe("redactRequestHeaders", () => {
  it("removes the value of every credential header line and keeps the rest of the call log", () => {
    const out = redactRequestHeaders(PLAYWRIGHT_TIMEOUT);
    expect(out).not.toContain(CLIENT);
    expect(out).not.toContain(REFRESH);
    expect(out).not.toContain("wcap_fake");
    expect(out).toContain("  -   cookie: <redacted>");
    expect(out).toContain("  -   Authorization: <redacted>");
    expect(out).toContain("apiRequestContext.delete: Timeout 120000ms exceeded.");
    expect(out).toContain("user-agent: Mozilla/5.0");
  });

  it("covers set-cookie, proxy-authorization and x-api-key, in any case", () => {
    const out = redactRequestHeaders(
      `Set-Cookie: __session=${REFRESH}\nPROXY-AUTHORIZATION: Basic ${CLIENT}\nx-api-key: ${CLIENT}`,
    );
    expect(out).toBe("Set-Cookie: <redacted>\nPROXY-AUTHORIZATION: <redacted>\nx-api-key: <redacted>");
  });

  it("leaves prose that only mentions a header name mid-line", () => {
    const prose = "4.1: the authorization: check refused 12 of 12; a cookie: none was sent";
    expect(redactRequestHeaders(prose)).toBe(prose);
  });

  it("says whether text still exposes a header value, and not once it is redacted", () => {
    expect(exposesRequestHeaders(PLAYWRIGHT_TIMEOUT)).toBe(true);
    expect(exposesRequestHeaders(redactRequestHeaders(PLAYWRIGHT_TIMEOUT))).toBe(false);
  });
});

describe("Playwright 1.61.1 call logs, ANSI-wrapped", () => {
  it("redacts every credential header, the protection bypass included", () => {
    const out = redactRequestHeaders(PLAYWRIGHT_1_61_TIMEOUT);
    for (const secret of SECRETS) expect(out).not.toContain(secret);
    expect(out).toContain("    - cookie: <redacted>");
    expect(out).toContain("    - authorization: <redacted>");
    expect(out).toContain("    - x-vercel-protection-bypass: <redacted>");
    expect(out).toContain("    - accept: */*");
    expect(out).not.toContain("\x1b[");
  });

  it("reports the raw log as exposing and the redacted one as clean", () => {
    expect(exposesRequestHeaders(PLAYWRIGHT_1_61_TIMEOUT)).toBe(true);
    expect(exposesRequestHeaders(redactRequestHeaders(PLAYWRIGHT_1_61_TIMEOUT))).toBe(false);
  });

  it("does not report a colour-wrapped line with no credential as exposing", () => {
    expect(exposesRequestHeaders("\x1b[2m    - accept: */*\x1b[22m")).toBe(false);
  });

  it("printableError prints the timeout without any credential", () => {
    const out = printableError(new Error(PLAYWRIGHT_1_61_TIMEOUT));
    expect(out).toContain("Timeout 500ms exceeded");
    for (const secret of SECRETS) expect(out).not.toContain(secret);
  });
});

describe("a live Playwright request that times out", () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    server = createServer(() => {}); // never answers, so the request times out
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/memory/facts/v1?scope=x`;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  it("prints no credential it sent, through printableError", async () => {
    const ctx = await request.newContext({
      extraHTTPHeaders: {
        cookie: `__client=${CLIENT}; __refresh_AbCd=${REFRESH}`,
        authorization: `Bearer ${CAPABILITY}`,
        "x-vercel-protection-bypass": BYPASS,
      },
    });
    const error = await ctx.delete(url, { timeout: 300 }).then(
      () => undefined,
      (e: unknown) => e,
    );
    await ctx.dispose();
    const raw = error instanceof Error ? error.message : "";
    expect(raw).toContain(REFRESH); // the call log does carry it, so this test can fail
    const out = printableError(error);
    for (const secret of SECRETS) expect(out).not.toContain(secret);
  });
});

describe("printableError", () => {
  it("prints an Error's stack without its cookie header", () => {
    const error = new Error(PLAYWRIGHT_TIMEOUT);
    const out = printableError(error);
    expect(out).toContain("Timeout 120000ms exceeded");
    expect(out).not.toContain(REFRESH);
  });

  it("prints a thrown non-Error the same way", () => {
    expect(printableError(`cookie: __client=${CLIENT}`)).toBe("cookie: <redacted>");
  });

  it("removes a credential-shaped token outside a header line, such as in a URL or a body", () => {
    const out = printableError(new Error(`GET /api/mcp?token=${CAPABILITY} failed: {"echo":"${CAPABILITY}"}`));
    expect(out).not.toContain(CAPABILITY);
    expect(out).toContain("GET /api/mcp?token=<redacted> failed");
  });
});

describe("printableBody", () => {
  it("redacts before it cuts, so a credential straddling the cut leaves no head behind", () => {
    const body = `${"x".repeat(289)} ${CAPABILITY}`;
    // Cutting first would leave "wcap_9sDfG", too short for the token shape to recognise.
    const out = printableBody(body, 300);
    expect(out).toHaveLength(300);
    expect(out).not.toContain("wcap_");
    expect(out).not.toContain(CAPABILITY.slice(5, 10));
  });

  it("removes header lines a server echoes back in an error body", () => {
    const out = printableBody(
      `upstream rejected:\ncookie: __client=${CLIENT}\nAuthorization: Bearer ${CAPABILITY}`,
      300,
    );
    expect(out).toBe("upstream rejected:\ncookie: <redacted>\nAuthorization: <redacted>");
  });
});
