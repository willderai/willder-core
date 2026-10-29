// Test-command recognition for the session-state capture (willder-capture.mjs): which shell
// commands run tests, whether a run passed, which files are test files, and which test files a
// command named, wrote before its run or wrote after it. Everything here reads the command's own
// words and the output Claude Code reports; nothing runs a process or touches the disk.
//
// Best-effort by design: a runner this does not recognise is reported as no run recognised,
// never as no tests run, and an unknown word is never read as a test path.
//
// Zero dependencies on purpose, like the rest of the hook: `willder init` copies it into projects.
import { homedir } from "node:os";
import { posix } from "node:path";

/**
 * The test runners the capture recognises, each with the extensions of the files it runs as
 * tests. A runner that hands off to a project's own script (`npm test`, `make test`, `turbo run
 * test`) runs whatever that script runs, so it adds no extension of its own. A test file needs
 * an extension a recognised runner runs ({@link TEST_EXTENSION}), so the two lists cannot drift:
 * a runner added here makes its files count as tests.
 */
const JS_TEST_EXTENSIONS = ["m?[jt]sx?", "c[jt]s", "coffee", "vue", "svelte"];
const TEST_RUNNERS = [
  { command: String.raw`(?:\S*/)?(?:vitest|jest|mocha|ava|karma)`, extensions: JS_TEST_EXTENSIONS },
  { command: String.raw`(?:\S*/)?(?:pytest|py\.test|unittest)`, extensions: ["py"] },
  { command: String.raw`(?:\S*/)?(?:phpunit|pest)`, extensions: ["php"] },
  { command: String.raw`(?:\S*/)?rspec`, extensions: ["rb"] },
  { command: String.raw`(?:\S*/)?cucumber(?:-js)?`, extensions: ["feature", "rb", ...JS_TEST_EXTENSIONS] },
  { command: String.raw`(?:\S*/)?bats`, extensions: ["bats", "sh", "bash"] },
  { command: String.raw`(?:\S*/)?zunit`, extensions: ["zsh"] },
  { command: String.raw`(?:\S*/)?ctest`, extensions: ["c", "cc", "cpp", "cxx", "h", "hh", "hpp"] },
  { command: String.raw`(?:\S*/)?gotestsum`, extensions: ["go"] },
  { command: String.raw`(?:npm|pnpm) (?:test|t)(?::\S+)?`, extensions: [] },
  { command: String.raw`(?:npm|pnpm) run(?:-script)? test(?:[-_:]\S*)?`, extensions: [] },
  { command: String.raw`(?:yarn|bun) (?:run )?test(?:[-_:]\S*)?`, extensions: [] },
  { command: String.raw`node (?:\S+ )*?--test`, extensions: JS_TEST_EXTENSIONS },
  { command: String.raw`go test`, extensions: ["go"] },
  { command: String.raw`cargo (?:test|nextest)`, extensions: ["rs"] },
  { command: String.raw`dotnet test`, extensions: ["cs", "fs", "vb"] },
  { command: String.raw`mix test`, extensions: ["exs?"] },
  { command: String.raw`deno test`, extensions: JS_TEST_EXTENSIONS },
  { command: String.raw`swift test`, extensions: ["swift"] },
  { command: String.raw`zig (?:build )?test`, extensions: ["zig"] },
  { command: String.raw`nimble test`, extensions: ["nim"] },
  { command: String.raw`(?:dart|flutter) test`, extensions: ["dart"] },
  { command: String.raw`(?:\S*/)?busted`, extensions: ["lua"] },
  { command: String.raw`prove`, extensions: ["t", "pl", "pm"] },
  { command: String.raw`rebar3 (?:eunit|ct)`, extensions: ["erl"] },
  { command: String.raw`(?:lein test|(?:clojure|clj) -[XM]:test)`, extensions: ["clj[cs]?"] },
  { command: String.raw`sbt test`, extensions: ["scala"] },
  { command: String.raw`(?:cabal|stack) test`, extensions: ["hs"] },
  { command: String.raw`dune (?:test|runtest)`, extensions: ["ml"] },
  { command: String.raw`(?:\S*/)?elm-test`, extensions: ["elm"] },
  { command: String.raw`xcodebuild (?:\S+ )*?test`, extensions: ["swift", "m", "mm"] },
  { command: String.raw`(?:robot|pabot)`, extensions: ["robot"] },
  { command: String.raw`Invoke-Pester`, extensions: ["ps1"] },
  { command: String.raw`R CMD check`, extensions: ["r"] },
  { command: String.raw`julia (?:\S+ )*?\S*runtests\.jl`, extensions: ["jl"] },
  { command: String.raw`(?:\S*/)?turbo (?:run )?test(?:[-_:]\S*)?`, extensions: [] },
  { command: String.raw`(?:\S*/)?nx (?:\S+ )*?(?:test|\S*:test)`, extensions: [] },
  { command: String.raw`(?:make|just) (?:test|check)(?:[-_:]\S*)?`, extensions: [] },
  {
    command: String.raw`(?:\./)?(?:gradlew|gradle) (?:\S+ )*?(?:\S*:)?(?:test|check)`,
    extensions: ["java", "kts?", "groovy", "scala"],
  },
  {
    command: String.raw`(?:\./)?(?:mvnw|mvn) (?:\S+ )*?(?:test|verify)`,
    extensions: ["java", "kt", "groovy", "scala"],
  },
  { command: String.raw`(?:\S*/)?python3? (?:\S*/)?manage\.py test`, extensions: ["py"] },
  { command: String.raw`(?:bin/)?rails test`, extensions: ["rb"] },
  { command: String.raw`rake (?:test|spec)`, extensions: ["rb"] },
  { command: String.raw`php artisan test`, extensions: ["php"] },
  { command: String.raw`(?:playwright|cypress) (?:test|run)`, extensions: JS_TEST_EXTENSIONS },
];

/**
 * A test runner at the start of a shell command ({@link TEST_RUNNERS}): `vitest`, `jest`,
 * `pytest`, `npm test`, `go test`, `turbo run test`, `./mvnw test`, `rails test` and the like,
 * with or without a path to its binary (`node_modules/.bin/vitest`). Only a command that starts
 * with one runs tests: `npm install -D vitest`, `cat jest.config.js` and `git commit -m 'make
 * jest happy'` name a runner and run none. Best-effort: a call this does not recognise is
 * recorded as no run recognised, never as no tests run.
 */
const RUNNER_AT_START = new RegExp(`^(?:${TEST_RUNNERS.map((runner) => runner.command).join("|")})(?=\\s|$)`);

/**
 * Options that make a runner run no tests though it starts: `gradle build -x test`,
 * `mvn verify -DskipTests`, `cargo test --no-run`, `pytest --collect-only`, `jest --clearCache`,
 * `vitest --version`, `--help`, `--dry-run`. A command holding one is not a test run.
 */
const RUNS_NO_TESTS =
  /(?:^|\s)(?:-x|--exclude-task)(?:=|\s+)\S*test\b|(?:^|\s)-D(?:skipTests|maven\.test\.skip)(?:=true)?(?=\s|$)|(?:^|\s)--(?:no-run|collect-only|co|clear-?cache|list-?tests|show-?config|version|help|dry-run|fixtures(?:-per-test)?)(?=[\s=]|$)|(?:^|\s)-h(?=\s|$)|(?:^|\s)-run(?:=|\s+)['"]?\^\$|(?:^|[\s/])(?:vitest|jest)\s+(?:list|bench)\b/i;

/**
 * Output that says a run ran no test: no files found, nothing collected, every test skipped or
 * filtered out. Such a run is no evidence about the tests, unless the output also counts some
 * that passed or failed ({@link RAN_SOME}).
 */
const RAN_NONE =
  /\bno tests? (?:ran|found|to run)\b|no test files found|collected 0 items|\b0 (?:tests?|passed)\b|\btests?\s+\d+ skipped\b|\bno tests\b/i;
const RAN_SOME = /\b[1-9]\d* (?:passed|passing|failed|failing)\b/i;
/** A runner's summary that counts failures, though the command around it exited 0 (`npm test || true`). */
export const COUNTS_FAILURES = /\b[1-9]\d* (?:failed|failing|errors?)\b/i;

/**
 * A package manager's options before its command, which choose where it runs, not what:
 * `npm -w web test`, `pnpm --filter web test`, `pnpm -r test`, `yarn workspace web test`. They
 * are dropped, leaving `npm test`.
 */
const PACKAGE_MANAGER_OPTIONS =
  /^((?:npm|pnpm|yarn|bun)\s+)(?:(?:(?:-w|--workspace|-F|--filter|-C|--dir|--prefix|--cwd)(?:=\S+|\s+\S+)|-r|--recursive|-ws|--workspaces|--if-present|-s|--silent|--include-workspace-root|workspace\s+\S+|workspaces\s+foreach(?:\s+-\S+)*)\s+)+/;

/**
 * What may come before a runner without changing that it runs: an environment assignment
 * (`CI=1`), a package runner (`npx`, `pnpm exec`, `bundle exec`, `python -m`, ...) with its
 * flags, or a wrapper (`time`, `env`, `timeout 60`). One is stripped at a time.
 */
const RUNNER_PREFIX =
  /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*|npx(?:\s+-\S+)*|pnpx|bunx|bun x|(?:npm|pnpm|yarn) (?:exec|dlx)(?:\s+-\S+)*|yarn|pnpm|uv run|poetry run|pipenv run|bundle exec|python3? -m|time|env(?:\s+(?:-u\s+\S+|--unset(?:=\S+|\s+\S+)|-\S+))*|nice(?:\s+-n\s+\S+)?|timeout \S+|xvfb-run)\s+/;

/** A shell running a command string, `sh -c "npm test"`, whose string is read as commands of its own. */
const SHELL_STRING = /^(?:ba|z)?sh\s+-c\s+(['"])(.*)\1$/s;

/** A shell script run directly or through a shell whose name says it runs tests: `./test.sh`, `bash run-tests.sh`. */
const TEST_SCRIPT = /^(?:(?:ba|z)?sh\s+)?(?:\S*\/)?(?:[^/\s]*[-_.])?tests?(?:[-_.][^/\s]*)?\.sh(?=\s|$)/;

/** A line of runner output that sums up a run: "12 passed", "Tests: 1 failed", "3 failing". */
const SUMMARY_LINE = /\b\d+ (passed|failed|passing|failing|errors?)\b|\bTests?:/i;

/**
 * A test file, or a file that decides what a test asserts or how tests run: a directory part
 * such as `test`, `tests`, `spec`, `__tests__`, `__snapshots__`, `__mocks__`, `fixtures`,
 * `testdata`, `e2e` or `<Project>.Tests`; a file name holding `test`, `tests`, `spec`, `specs`
 * or `testing` as a word (`a.test.ts`, `app.e2e-spec.ts`, `test_a.py`, `a_test.go`,
 * `a_test.rs`, `test-utils.tsx`); a CamelCase test class (`FooTest.java`); a snapshot; or a test
 * runner's own config or setup file (`conftest.py`, `vitest.config.ts`, `jest.setup.js`). Not a
 * project's general manifest or build file (`package.json`, `pyproject.toml`, `tsconfig.json`):
 * an edit to a test file is evidence against a pass, so only real test files count.
 */
const TEST_DIRECTORY =
  /(^|\/)(__tests__|__snapshots__|__mocks__|__fixtures__|tests?|specs?|testing|testdata|test[-_]data|fixtures?|mocks?|stubs?|fakes?|snapshots?|e2e|cypress|playwright|features|step[-_]definitions|[^/]*[._-](tests?|unittests?|integrationtests?|functionaltests?|specs?))\//i;
const TEST_NAME = /(^|[._-])(tests?|specs?|testing|unittests?|e2e|cy)([._-]|$)|^test\w*\.py$|\.feature$/i;
/**
 * The extensions a file named like a test needs to be one: one a recognised runner runs
 * ({@link TEST_RUNNERS}), or a snapshot. `notes_test_plan.md` is a document, not a test.
 */
const TEST_EXTENSION = new RegExp(
  `\\.(?:${[...new Set(TEST_RUNNERS.flatMap((runner) => runner.extensions)), "snap"].join("|")})$`,
  "i",
);
/** A CamelCase test class, `FooTest.java`, `OrderSpec.kt`, `AckTests.cs`, `CheckoutIT.java`. */
const TEST_CLASS = /[a-z0-9](Tests?|Spec|IT)\.[^./]+$/;
const TEST_CONFIG =
  /^(conftest\.py|\.env\.test(\.local)?|\.?pytest\.ini|tox\.ini|noxfile\.py|\.rspec|phpunit\.xml(\.dist)?|\.mocharc(\.[^.]+)?|setup-?tests\.[^.]+|(vitest|vite|jest|playwright|cypress|karma|mocha|ava|jasmine|wdio)\.[^/]*)$/i;

/** What splits a command's arguments into words: whitespace, quotes, parentheses, redirects, `=` and `,`. */
export const WORD_SEPARATOR = /[\s'"`()<>=,]+/;

/** A heredoc's start, `<<EOF`, `<<-'EOF'` or `<< "EOF"`, with its delimiter; not a here-string, `<<<`, which has no body. */
const HEREDOC_START = /(?<!<)<<(?!<)-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;

/** What the second fact line says when every runner in the command was given test paths, none of them an edited test. */
const NAMED_OTHER = "none of them; it named other tests";
/** What it says when a runner was given no test path: it ran the tests it found, the edited ones among them. */
const NAMED_SUITE = "none by name; it ran tests without naming them";

/** A command word that is a value for configuration, not a test path: a config, manifest or settings file. */
const CONFIG_WORD = /\.(json|jsonc|ya?ml|toml|ini|cfg|env)$/i;
/** A project or solution file a runner is given (`dotnet test App.Tests/App.Tests.csproj`): it names its directory. */
const PROJECT_FILE = /\.(csproj|fsproj|vbproj|sln)$/i;

/**
 * `part` without the brackets of a subshell or a group around it, `(cd web && npm test)`, which
 * do not change what runs. A scan from each end, not a regular expression: a pattern anchored at
 * the end backtracks over every run of spaces on a long line.
 */
function withoutBrackets(part) {
  let start = 0;
  let end = part.length;
  while (start < end && /[\s({]/.test(part[start])) start++;
  while (end > start && /[\s)}]/.test(part[end - 1])) end--;
  return part.slice(start, end);
}

/**
 * The shell commands `command` runs, one per entry, without the bodies of its heredocs: text
 * fed to `cat` or `python3` on stdin is not a command, though it may read like one. Commands are
 * split at `;`, `&&`, `||`, `|`, `&` and line breaks outside quotes only, so a commit message
 * such as `"Fix prune; vitest passes"` stays part of its `git commit`.
 */
export function shellCommands(command) {
  const commands = [];
  const pending = [];
  let current = "";
  let quote = null;
  for (const line of command.split(/\r?\n/)) {
    if (quote === null && pending.length > 0) {
      if (line.trim() === pending[0]) pending.shift();
      continue;
    }
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (quote !== null) {
        current += char;
        if (char === "\\" && quote === '"' && i + 1 < line.length) current += line[++i];
        else if (char === quote) quote = null;
      } else if (char === "'" || char === '"' || char === "`") {
        quote = char;
        current += char;
      } else if (char === "\\" && i + 1 < line.length) {
        current += char + line[++i];
      } else if (char === ";" || char === "|" || char === "&") {
        commands.push(current);
        current = "";
        if ((char === "|" || char === "&") && line[i + 1] === char) i++;
      } else {
        current += char;
      }
    }
    if (quote === null) {
      commands.push(current);
      current = "";
      for (const [, , delimiter] of line.matchAll(HEREDOC_START)) pending.push(delimiter);
    } else {
      current += "\n";
    }
  }
  commands.push(current);
  return commands.map(withoutBrackets).filter((part) => part !== "");
}

/** The words after the test runner `part` starts with, or null when it starts with none ({@link RUNNER_AT_START}). */
function runnerArguments(part) {
  let rest = part;
  for (;;) {
    const runner = RUNNER_AT_START.exec(rest);
    if (runner) return rest.slice(runner[0].length);
    const options = rest.replace(PACKAGE_MANAGER_OPTIONS, "$1");
    if (options !== rest) {
      rest = options;
      continue;
    }
    const prefix = RUNNER_PREFIX.exec(rest);
    if (!prefix) return null;
    rest = rest.slice(prefix[0].length);
  }
}

/**
 * Whether the shell command `part` runs tests: it starts with a runner or a test script, or is a
 * shell string holding one, and holds no option that skips them.
 */
export function runsTests(part) {
  const string = SHELL_STRING.exec(part);
  if (string) return shellCommands(string[2]).some(runsTests);
  return (runnerArguments(part) !== null || TEST_SCRIPT.test(part)) && !RUNS_NO_TESTS.test(part);
}

/**
 * The test run a tool event reports, or null when it is not one: a Bash call one of whose
 * commands starts with a test runner and does not skip its tests ({@link runsTests}). Claude Code sends PostToolUse when a command exits 0 and
 * PostToolUseFailure when it does not; an interrupted run says nothing about the tests and is
 * not counted.
 * @returns {{ command: string, passed: boolean, line: string } | null}
 */
export function testRunOf(input) {
  const command = input?.tool_input?.command;
  if (input?.tool_name !== "Bash" || typeof command !== "string") return null;
  if (!shellCommands(command).some(runsTests)) return null;
  if (input.hook_event_name === "PostToolUse") {
    const output = `${input.tool_response?.stdout ?? ""}\n${input.tool_response?.stderr ?? ""}`;
    if (RAN_NONE.test(output) && !RAN_SOME.test(output)) return null;
    const line = summaryLine(output);
    // A command can exit 0 around a failed run (`npm test || true`, `npx vitest run | tail`): the
    // runner's own count of failures decides.
    return { command, passed: !(line && COUNTS_FAILURES.test(line)), line: line ?? "exit 0" };
  }
  if (input.hook_event_name === "PostToolUseFailure" && input.is_interrupt !== true) {
    const error = typeof input.error === "string" ? input.error : "";
    if (RAN_NONE.test(error) && !RAN_SOME.test(error)) return null;
    return { command, passed: false, line: summaryLine(error) ?? (error.split("\n")[0].trim() || "failed") };
  }
  return null;
}

/** The last line of `output` that sums up a test run, trimmed, or undefined. */
function summaryLine(output) {
  const lines = String(output)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => SUMMARY_LINE.test(line));
  return lines.at(-1);
}

/**
 * Whether `path`, as git lists it, is a test file ({@link TEST_DIRECTORY}, {@link TEST_NAME},
 * {@link TEST_CLASS}, {@link TEST_CONFIG}). A name git quoted (`"a\"b.test.ts"`) is read
 * without its quotes.
 */
export function isTestFile(path) {
  const unquoted = path.replace(/^"(.*)"$/, "$1");
  const name = unquoted.slice(unquoted.lastIndexOf("/") + 1);
  const named = (TEST_NAME.test(name) || TEST_CLASS.test(name)) && TEST_EXTENSION.test(name);
  return TEST_DIRECTORY.test(unquoted) || named || TEST_CONFIG.test(name) || /\.snap$/i.test(name);
}

/**
 * A runner's word as a test path, or null when it is not one: a word holding `/`, a glob, a
 * node id or a file extension, without quotes, a leading `./`, a trailing `/`, a node id
 * (`a.py::test_x`) or a line (`a.test.ts:12`). A config or settings file is not a test path.
 */
function testPathOf(word) {
  const path = word
    .replace(/^['"]|['"]$/g, "")
    .replace(/::.*$/, "")
    .replace(/:\d+(?::\d+)?$/, "")
    .replace(/^(\.\/)+/, "")
    .replace(/\/+$/, "");
  if (
    path === "" ||
    path === "." ||
    path.startsWith("-") ||
    CONFIG_WORD.test(path) ||
    TEST_CONFIG.test(path.slice(path.lastIndexOf("/") + 1))
  )
    return null;
  if (PROJECT_FILE.test(path)) return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null;
  return /[/*?]|\.[A-Za-z0-9]+$/.test(word) ? path : null;
}

/**
 * Whether the test path `target` (from {@link testPathOf}) covers the project file `file`: the
 * same path, a path ending with it, a directory holding it, a glob matching it, or a part of it,
 * as vitest and jest read a path as a filter. Compared without case.
 */
function namesFile(target, file) {
  const word = target.toLowerCase();
  const path = file.toLowerCase();
  if (/[*?]/.test(word)) {
    const pattern = word
      .split(/(\*\*\/?|\*|\?)/)
      .map((part) =>
        part === "**" || part === "**/"
          ? ".*"
          : part === "*"
            ? "[^/]*"
            : part === "?"
              ? "[^/]"
              : part.replace(/[.+^${}()|[\]\\]/g, "\\$&"),
      )
      .join("");
    return new RegExp(`(^|/)${pattern}$`).test(path);
  }
  return (
    path === word ||
    path.endsWith(`/${word}`) ||
    word.endsWith(`/${path}`) ||
    path.startsWith(`${word}/`) ||
    path.includes(word)
  );
}

/**
 * Which test files the session had changed when a test run happened ({@link isTestFile}), and
 * which of them the run's command named. `changed` is the session's changed files at that
 * moment, or null when git could not say.
 *
 * `named` lists the edited test files some runner's test paths cover ({@link namesFile}); when
 * none does, it is NAMED_OTHER only when every runner was given test files and nothing else,
 * none of them edited, and NAMED_SUITE otherwise: a runner given no path, a directory, an
 * option's value (`--reporter=./r.mjs`, `--cov=src`) or `./...` may have run the edited tests.
 * Only a runner's own words count: a path in another command of the same call
 * (`git add a.test.ts && npm test`) is not a test it ran.
 * @param {string} command
 * @param {string[] | null} changed
 * @returns {{ files: string[], named: string[] | typeof NAMED_OTHER | typeof NAMED_SUITE } | null}
 */
export function editedTestsOf(command, changed) {
  if (changed === null) return null;
  const files = changed.filter(isTestFile);
  if (files.length === 0) return { files, named: [] };
  const runners = shellCommands(command)
    .filter(runsTests)
    .map((part) =>
      (runnerArguments(part) ?? "")
        .split(WORD_SEPARATOR)
        .map(testPathOf)
        .filter((path) => path !== null),
    );
  const named = files.filter((file) =>
    runners.some((paths) => paths.some((path) => namesFile(path, file) || namesFile(path, snapshotOwner(file)))),
  );
  if (named.length > 0) return { files, named };
  const testFilesOnly = (paths) =>
    paths.length > 0 && paths.every((path) => isTestFile(path) && /\.[A-Za-z0-9]+$/.test(path));
  return { files, named: runners.length > 0 && runners.every(testFilesOnly) ? NAMED_OTHER : NAMED_SUITE };
}

/**
 * A shell command that writes, moves, removes or restores files, besides any `>` redirect:
 * `cat` and `sed` without `-i` only read.
 */
const WRITES_FILES =
  /^(?:tee|(?:sed|perl)\s+(?:\S+\s+)*?-i|mv|cp|rm|touch|truncate|patch|git\s+(?:checkout|restore|reset|stash|apply|mv|rm|am|cherry-pick|revert))\b/;

/**
 * The test files the other commands of a Bash call write, move, remove or restore, before and
 * after its last test run: `cat > a.test.ts <<E … E && npx vitest run` rewrites a test the run
 * then passes, and `npx vitest run && git checkout -- a.test.ts` puts it back before the hook
 * can see it in git. Read from the command's words, since git sees only what is left after the
 * whole call; a path is named from the session's directory, following the call's `cd`s.
 * @param {string} command
 * @returns {{ before: string[], after: string[] }}
 */
export function testWritesAroundRun(command) {
  const parts = shellCommands(command);
  const run = parts.findLastIndex(runsTests);
  const before = new Set();
  const after = new Set();
  // The directory the call has moved to, from the session's: `cd web && cat > a.test.ts …` writes web/a.test.ts.
  let dir = "";
  for (const [i, part] of parts.entries()) {
    const cd = /^(?:cd|pushd)\s+(['"]?)(.+?)\1$/.exec(part);
    if (cd) {
      const target = cd[2].replace(/^~(?=\/|$)/, homedir());
      dir = target.startsWith("/") ? posix.normalize(target) : posix.join(dir, target);
      continue;
    }
    if (i === run || runsTests(part)) continue;
    if (!WRITES_FILES.test(part) && !/>/.test(part.replace(/\d?>&\d|>\s*\/dev\/null/g, ""))) continue;
    for (const word of part.split(WORD_SEPARATOR)) {
      const path = testPathOf(word);
      if (path !== null && isTestFile(path) && /\.[A-Za-z0-9]+$/.test(path))
        (i < run ? before : after).add(dir && !path.startsWith("/") ? posix.join(dir, path) : path);
    }
  }
  return { before: [...before], after: [...after] };
}

/** The test file a snapshot belongs to (`a/__snapshots__/b.test.ts.snap` to `a/b.test.ts`), or the file itself. */
function snapshotOwner(file) {
  return file.replace(/(^|\/)__snapshots__\/([^/]+)\.snap$/, "$1$2");
}

/**
 * The shell command of `command` that starts with a test runner ({@link RUNNER_AT_START}), as
 * {@link shellCommands} splits it, or undefined when none does.
 * @param {string} command
 */
export function runnerCommandOf(command) {
  return shellCommands(command).find((part) => runnerArguments(part) !== null);
}
