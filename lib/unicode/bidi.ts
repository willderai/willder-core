// Bidirectional formatting controls (Unicode property Bidi_Control): the twelve invisible
// characters that tell a renderer to reorder the text around them. U+202E RIGHT-TO-LEFT
// OVERRIDE turns "metsyS" into "System" on screen while the stored string still reads
// "metsyS" to every comparison.
//
// The rule this module enforces: text a person reads to decide who did something never
// reaches the screen with a live bidi control in it. Code that compares such text asks
// containsBidiControl; code that renders it shows the controls escaped.

// Built at runtime: the project's compile target predates regex property escapes.
const BIDI_CONTROL_SOURCE = "\\p{Bidi_Control}";

/** True when `text` contains any Bidi_Control character (U+061C, U+200E, U+200F,
 *  U+202A to U+202E, U+2066 to U+2069). */
export function containsBidiControl(text: string): boolean {
  return new RegExp(BIDI_CONTROL_SOURCE, "u").test(text);
}

/** `text` with every Bidi_Control character replaced by a visible `[U+XXXX]`, so the
 *  renderer shows the characters in their stored order and the reader sees the control. */
export function escapeBidiControls(text: string): string {
  return text.replace(
    new RegExp(BIDI_CONTROL_SOURCE, "gu"),
    (control) => `[U+${control.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}]`,
  );
}
