// The Node versions package.json promises are the ones `npm install` actually accepts.
//
// Prisma's preinstall script refuses any Node outside its own `engines` range, so a range
// wider than Prisma's (the old `>=20.19`) let a stranger on Node 23 start an install that
// then stopped inside node_modules/prisma. `engines` states that range and `devEngines`
// makes npm 10.9+ refuse up front, naming the required and current versions, before any
// package is downloaded.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import semver from "semver";
import { describe, expect, it } from "vitest";

const repoRoot = __dirname;
const readJson = (file: string) => JSON.parse(readFileSync(resolve(repoRoot, file), "utf8"));

const pkg = readJson("package.json");
const prismaRange: string = readJson("package-lock.json").packages["node_modules/prisma"].engines.node;
// .nvmrc names a major line ("20"); `nvm use` installs its newest release.
const nvmrcLine = readFileSync(resolve(repoRoot, ".nvmrc"), "utf8").trim();

describe("package.json Node versions", () => {
  it("promises exactly the range the locked Prisma accepts", () => {
    expect(pkg.engines.node).toBe(prismaRange);
  });

  it("refuses any other Node before installing, through devEngines", () => {
    expect(pkg.devEngines.runtime).toEqual({ name: "node", version: pkg.engines.node, onFail: "error" });
  });

  it("accepts the Node line .nvmrc names", () => {
    expect(semver.intersects(nvmrcLine, pkg.engines.node)).toBe(true);
  });

  it.each(["23.7.0", "22.11.0", "21.7.3", "20.18.3"])("refuses Node %s, which Prisma refuses", (version) => {
    expect(semver.satisfies(version, pkg.engines.node)).toBe(false);
  });
});
