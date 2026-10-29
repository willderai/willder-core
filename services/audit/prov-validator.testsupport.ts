// Runs scripts/prov/validate_prov_json.py, the PROV validator the PROV-JSON tests use: the
// W3C PROV-JSON schema plus the reference `prov` Python package. Needs PROV_PYTHON, a
// Python 3.13 or newer with scripts/prov/requirements.txt installed.
//
// The one rule this file enforces: in CI the validator always runs. A developer without
// Python skips the tests that need it; CI fails instead, because a skipped validator would
// leave every exported document unchecked behind a green build.
import { spawnSync } from "node:child_process";
import { join } from "node:path";

/** The Python the validator runs under; tests that need it skip when it is unset, outside CI. */
export const PROV_PYTHON = process.env.PROV_PYTHON;

if (process.env.CI && !PROV_PYTHON) {
  throw new Error(
    "PROV_PYTHON is unset in CI, so the PROV-JSON tests would skip. Install the validator " +
      "under Python 3.13 or newer (pip install --no-deps -r scripts/prov/requirements.txt) and " +
      "set PROV_PYTHON, as .github/workflows/ci.yml does for the test shards.",
  );
}

const VALIDATOR = join(__dirname, "../../scripts/prov/validate_prov_json.py");

/** Validates `doc`; returns the four answers as the validator parsed them, or why it refused. */
export function validateProv(doc: unknown): { ok: true; answers: unknown } | { ok: false; error: string } {
  if (!PROV_PYTHON) throw new Error("PROV_PYTHON is not set");
  const run = spawnSync(PROV_PYTHON, [VALIDATOR], { input: JSON.stringify(doc), encoding: "utf8" });
  if (run.status !== 0) return { ok: false, error: `${run.stderr}${run.error ?? ""}` };
  return { ok: true, answers: JSON.parse(run.stdout) };
}
