/**
 * Stored text as one line of a served read: runs of whitespace closed up, and the separators a
 * served line uses replaced, so stored text cannot pass for one of its fields.
 */
export function inlineText(text: string): string {
  return text.replace(/\s+/g, " ").trim().replaceAll(" — ", " – ").replaceAll(" · ", " - ");
}
