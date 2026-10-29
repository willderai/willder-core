#!/usr/bin/env node
// Regenerates lib/unicode/confusables.json from Unicode's confusables.txt (UTS #39).
//
// The JSON is the only copy the app reads; this script is how it was made and how it is
// updated. It downloads one pinned release, refuses it unless its SHA-256 matches the one
// recorded below, and writes every mapping in the file, unfiltered, so the vendored data
// can always be reproduced and diffed against the official source.
//
// To move to a newer Unicode release: change VERSION and SHA256, run
// `node scripts/generate-confusables.mjs`, and commit the regenerated JSON.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const VERSION = "18.0.0";
const SOURCE = `https://www.unicode.org/Public/${VERSION}/security/confusables.txt`;
const SHA256 = "6ed3ee967c9dfdf6677d563c9985182fbc50a2efb7d6059cd57b2e2ce18f5b92";
const OUT = fileURLToPath(new URL("../lib/unicode/confusables.json", import.meta.url));

const response = await fetch(SOURCE);
if (!response.ok) throw new Error(`GET ${SOURCE} failed: ${response.status}`);
const text = await response.text();
const digest = createHash("sha256").update(text).digest("hex");
if (digest !== SHA256) {
  throw new Error(`${SOURCE} has SHA-256 ${digest}, expected ${SHA256}; update SHA256 only after checking the release`);
}

const fromHex = (codes) =>
  String.fromCodePoint(
    ...codes
      .trim()
      .split(/\s+/)
      .map((c) => parseInt(c, 16)),
  );
const prototypes = {};
for (const line of text.split("\n")) {
  const data = line.split("#")[0].trim();
  if (data === "") continue;
  const [source, target] = data.split(";");
  prototypes[fromHex(source)] = fromHex(target);
}

const out = { source: SOURCE, version: VERSION, sha256: SHA256, prototypes };
writeFileSync(OUT, `${JSON.stringify(out, null, 0)}\n`);
console.log(`wrote ${Object.keys(prototypes).length} mappings from ${SOURCE} to ${OUT}`);
