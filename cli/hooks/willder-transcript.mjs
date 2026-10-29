// Transcript reading for the session-state capture (willder-capture.mjs). Claude Code writes a
// session's transcript as JSON lines; capture reads only its tail for the agent's last message
// and its head for whether the session did work before its state was made. Reads are bounded
// (TRANSCRIPT_TAIL_BYTES, TRANSCRIPT_SCAN_BYTES) and never throw: an unreadable transcript reads
// as empty.
//
// Zero dependencies on purpose, like the rest of the hook: `willder init` copies it into projects.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** The most of a transcript read for earlier tool use when a session's state is first made. */
const TRANSCRIPT_SCAN_BYTES = 8 * 1024 * 1024;
const TRANSCRIPT_SCAN_CHUNK = 64 * 1024;
/** The most of a transcript's end read for the agent's last message. */
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

/**
 * The agent's last message: Stop carries it; otherwise the last assistant text in the
 * tail of the transcript, which Claude Code writes as JSON lines.
 */
export function lastAssistantMessage(input) {
  if (typeof input.last_assistant_message === "string" && input.last_assistant_message.trim())
    return input.last_assistant_message;
  if (typeof input.transcript_path !== "string") return undefined;
  const lines = readTail(input.transcript_path).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const content = entry?.type === "assistant" ? entry.message?.content : undefined;
    const text = Array.isArray(content)
      ? content
          .filter((block) => block?.type === "text" && typeof block.text === "string")
          .map((block) => block.text)
          .join("\n")
          .trim()
      : "";
    if (text) return text;
  }
  return undefined;
}

/** The last TRANSCRIPT_TAIL_BYTES of a file, or "" when it cannot be read. */
export function readTail(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Whether the session's transcript already holds a tool call: the state is being made after the
 * session did work, so what it did before is in the baseline. That is a session resumed after it
 * ended (SessionEnd removes the state), a state file lost mid-session, or a hook installed late.
 * A new session's state is made at its first prompt, before any tool call.
 */
export function transcriptShowsEarlierWork(path) {
  if (typeof path !== "string") return false;
  const marker = '"type":"tool_use"';
  let fd;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(TRANSCRIPT_SCAN_CHUNK);
    let carry = "";
    for (let at = 0; at < TRANSCRIPT_SCAN_BYTES; at += TRANSCRIPT_SCAN_CHUNK) {
      const read = readSync(fd, buffer, 0, TRANSCRIPT_SCAN_CHUNK, at);
      if (read === 0) return false;
      const text = carry + buffer.toString("latin1", 0, read);
      if (text.includes(marker)) return true;
      carry = text.slice(-marker.length);
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
