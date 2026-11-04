// The import gate that keeps `lib/blob-storage.ts` the only caller of the
// Vercel Blob SDK, made structural.
//
// `lib/blob-storage.ts` hard-codes `access: "private"`, so as long as nothing
// else reaches the SDK, no blob can be stored publicly. This rule is what
// makes "nothing else" true: any other module importing `@vercel/blob` is an
// error.
//
// It replaces lib/blob-access-invariant.test.ts's file-path allowlist, which
// enforced the same invariant by enumerating the files that called `put()` and
// therefore failed whenever a call site MOVED, even though the invariant still
// held. An import gate has no such list: it is repository-wide by default, so
// a new call site is caught on the day it lands without anyone updating
// anything, and a refactor that only moves code is not a violation.
//
// Test files are excluded, as in eslint.scope-gate.mjs: they name the SDK to
// mock it (`vi.mock("@vercel/blob", ...)`) and to assert what the wrapper
// passed it, which is how the invariant is proven, not a way around it.

const BLOB_SDK = "@vercel/blob";
const WRAPPER = "lib/blob-storage.ts";

/**
 * Is `specifier` the Blob SDK, by any path that resolves to it?
 *
 * Subpaths count. `@vercel/blob/client` is a real export of the same package
 * and exports its own `put` and `upload`, both of which take `access`, so
 * matching the bare package name alone would leave one extra path segment as a
 * complete way around this rule.
 */
function isBlobSdk(specifier) {
  // A Literal's value is not always a string -- `require(1)` parses fine.
  return typeof specifier === "string" && (specifier === BLOB_SDK || specifier.startsWith(`${BLOB_SDK}/`));
}

const MESSAGE =
  `Only ${WRAPPER} may import ${BLOB_SDK} or any of its subpaths. Import putPrivateBlob from "@/lib/blob-storage" ` +
  "and call it instead: it fixes access:'private', which keeps customer memory content out of " +
  "permanent, unauthenticated public URLs. Reaching the SDK here would let this call site choose " +
  "'public', and nothing downstream would notice.";

/**
 * Bans `@vercel/blob` and its subpaths as module specifiers in every form the
 * repository can reach them by: a static `import`, a re-`export ... from`, a
 * dynamic `import()`, and `require()`.
 *
 * The built-in `no-restricted-imports` covers only the static forms in ESLint
 * 9.39 -- verified against a probe file -- and the dynamic `import()` is the
 * form both real call sites used, so it would have let the actual violation
 * through. `no-restricted-syntax` would cover it, but flat config resolves
 * rules by name and the scope-containment gate already owns that
 * rule for an overlapping set of files, so a second config object setting it
 * would silently replace the scope gate's selectors. A rule of its own avoids both.
 */
const noBlobSdkImport = {
  meta: {
    type: "problem",
    docs: { description: `Disallow importing ${BLOB_SDK} outside ${WRAPPER}` },
    schema: [],
    messages: { restricted: MESSAGE },
  },
  create(context) {
    const report = (node) => context.report({ node, messageId: "restricted" });
    const reportIfBlobSdk = (node, source) => {
      if (source && source.type === "Literal" && isBlobSdk(source.value)) report(node);
    };
    return {
      ImportDeclaration: (node) => reportIfBlobSdk(node, node.source),
      ExportNamedDeclaration: (node) => reportIfBlobSdk(node, node.source),
      ExportAllDeclaration: (node) => reportIfBlobSdk(node, node.source),
      ImportExpression: (node) => reportIfBlobSdk(node, node.source),
      CallExpression: (node) => {
        if (node.callee.type === "Identifier" && node.callee.name === "require") {
          reportIfBlobSdk(node, node.arguments[0]);
        }
      },
    };
  },
};

export const blobAccessGate = {
  files: ["**/*.ts", "**/*.tsx"],
  ignores: [WRAPPER, "**/*.test.ts", "**/*.test.tsx"],
  plugins: { "blob-access": { rules: { "no-blob-sdk-import": noBlobSdkImport } } },
  rules: { "blob-access/no-blob-sdk-import": "error" },
};
