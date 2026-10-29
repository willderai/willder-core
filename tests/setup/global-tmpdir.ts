// Vitest global setup: gives this run its own temporary directory and removes it
// when the run ends (tests/setup/run-tmpdir.ts).
import { createRunTmpdir } from "./run-tmpdir";

export default function setup(): () => void {
  return createRunTmpdir(process.env);
}
