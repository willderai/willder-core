// A writer's label in a width-capped slot. The rule it enforces: CSS truncation may cut the
// name, never the marker (` (agent key "...")` or ` (agent token)`) that tells a custom
// agent from a product writer of the same name, and no bidi control reaches the screen.

import { displayWriterLabel, splitWriterLabel } from "./format";

/** A writer label whose name truncates with an ellipsis while its marker stays whole.
 * `maxChars` caps the slot's width in `ch` (take it from WRITER_SLOT_CHARS); `className`
 * sets the text style. */
export function WriterLabel({
  label,
  maxChars,
  className = "",
}: {
  label: string;
  maxChars?: number;
  className?: string;
}) {
  const { name, marker } = splitWriterLabel(displayWriterLabel(label));
  return (
    <span className={`flex min-w-0 ${className}`} style={maxChars ? { maxWidth: `${maxChars}ch` } : undefined}>
      <span className="truncate">{name}</span>
      {marker && <span className="shrink-0 whitespace-pre">{marker}</span>}
    </span>
  );
}
