// Drift check between each connector's parser and its fixtures.
//
// Every connector parser runs over its whole fixture corpus with each provider
// payload wrapped by `trackReads`. A field the parser reads that no fixture
// ever carries a value for fails the check, naming the field: that branch of
// the parser is untested, and a provider change to it would ship unnoticed.
// Fix a failure by adding the field, in the provider's real shape, to the
// connector's fixture builder under fixtures/, never by loosening this check.

import { afterEach, describe, expect, it, vi } from "vitest";
import { listRepositoryItems, repositoryReaders } from "./github";
import { busyRepository, fakeGitHub, messyRepository, type FakeRepositoryState } from "./fixtures/github";
import { fakeDrive, largeDriveFolder } from "./fixtures/gdrive";
import { busySlackChannel, fakeFigma, fakeSlack, messyFigmaFile, messySlackChannel } from "./fixtures/slack-figma";
import { newReadLog, uncoveredReads, type ReadLog } from "./fixtures/read-tracker";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function gitHubReads(states: FakeRepositoryState[]): Promise<ReadLog> {
  const log = newReadLog();
  for (const state of states) {
    vi.stubGlobal("fetch", vi.fn(fakeGitHub(state, log).fetch));
    await listRepositoryItems(state.repo.full_name, "test-token");
    await repositoryReaders(state.repo.full_name, "test-token");
  }
  return log;
}

describe("connector fixtures carry every field their parser reads", () => {
  it("GitHub", async () => {
    const log = await gitHubReads([messyRepository(), busyRepository({ commits: 60, issues: 40, pulls: 20 })]);
    expect(log.size).toBeGreaterThan(20);
    expect(uncoveredReads(log)).toEqual([]);
  });

  it("Google Drive", async () => {
    vi.stubEnv("GDRIVE_MOCK", "false");
    const log = newReadLog();
    vi.stubGlobal("fetch", vi.fn(fakeDrive(largeDriveFolder("folder-shared-1"), log).fetch));
    const { listFolderFiles, listFolderReaders } = await import("./gdrive");
    await listFolderFiles("folder-shared-1", "test-drive-token");
    await listFolderReaders("folder-shared-1", "test-drive-token");
    expect(log.size).toBeGreaterThan(8);
    expect(uncoveredReads(log)).toEqual([]);
  });

  it("Slack", async () => {
    vi.stubEnv("SLACK_MOCK", "false");
    const log = newReadLog();
    const { listChannelMessages } = await import("./slack");
    for (const channel of [messySlackChannel(), busySlackChannel(250)]) {
      vi.stubGlobal("fetch", vi.fn(fakeSlack(channel, log).fetch));
      await listChannelMessages("C0EXAMPLE", "test-slack-token");
    }
    expect(log.size).toBeGreaterThan(4);
    expect(uncoveredReads(log)).toEqual([]);
  });

  it("Figma", async () => {
    vi.stubEnv("FIGMA_MOCK", "false");
    const log = newReadLog();
    vi.stubGlobal("fetch", vi.fn(fakeFigma(messyFigmaFile(), log).fetch));
    const { listFileComments } = await import("./figma");
    await listFileComments("AbCdEf123456", "test-figma-token");
    expect(log.size).toBeGreaterThan(4);
    expect(uncoveredReads(log)).toEqual([]);
  });
});

describe("the drift check", () => {
  it("names a field the parser reads once no fixture carries it", async () => {
    const state = messyRepository();
    for (const pull of state.pulls) delete (pull as Partial<typeof pull>).draft;
    for (const issue of state.issues) issue.user = null;

    const log = await gitHubReads([state]);

    expect(uncoveredReads(log)).toEqual(["issues[].user", "pulls[].draft"]);
  });
});
