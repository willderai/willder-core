"""Find the passages of a source document whose numbers extraction dropped.

The extractor paraphrases, and a paraphrase loses numeric qualifiers: a README
bullet "WebSocket server pushes live price ticks to the UI at up to 55
updates/min" came back as "Example repo uses WebSocket for live price ticks", so a
question about the rate had nothing to find. The rule this module enforces: a
passage carrying a number that no fact extracted from the same document states
is kept in its own words. Passages whose numbers survived, and passages with no
number at all, are left to extraction, so the graph does not grow a verbatim
copy of every document.
"""

import re

# A number as a reader would quote it: "55", "1.5", "50,000". Digits glued to a
# preceding letter or dot ("abc1234" in a commit sha, "v1.2") are identifiers,
# not quantities, and are skipped.
_NUMBER = re.compile(r"(?<![\w.])\d+(?:[.,]\d+)*")
# Markdown list, heading and quote markers, including "1." list numbering, which
# would otherwise count as a number the passage states.
_LINE_MARKER = re.compile(r"^\s*(?:[-*+>]|#+|\d+[.)])\s+")
_SENTENCE_END = re.compile(r"(?<=[.!?])\s+")
_CODE_FENCE = re.compile(r"^\s*(```|~~~)")

# A line longer than this is split into sentences, so one stored passage stays
# close to one claim.
_MAX_LINE_CHARS = 400

# Upper bound on passages kept per document, so a numbers-heavy document cannot
# flood its scope's graph. The ingest logs when a document reaches it.
MAX_VERBATIM_PASSAGES = 20


def numbers_in(text: str) -> set[str]:
    """The numbers `text` states, with thousands separators removed."""
    return {match.replace(",", "") for match in _NUMBER.findall(text)}


def passages(document: str) -> list[str]:
    """Split a document into one passage per line, or per sentence of a long
    line, without list markers. Fenced code blocks are skipped: their numbers
    are code, not claims extraction is expected to state."""
    out: list[str] = []
    in_code = False
    for raw in document.splitlines():
        if _CODE_FENCE.match(raw):
            in_code = not in_code
            continue
        if in_code:
            continue
        line = _LINE_MARKER.sub("", raw).strip()
        if not line:
            continue
        pieces = _SENTENCE_END.split(line) if len(line) > _MAX_LINE_CHARS else [line]
        out.extend(piece.strip() for piece in pieces if piece.strip())
    return out


def passages_with_dropped_numbers(document: str, extracted_facts: list[str]) -> list[str]:
    """The document's passages that state a number none of `extracted_facts`
    states, in document order, without duplicates."""
    kept_numbers = set().union(*(numbers_in(fact) for fact in extracted_facts))
    dropped: list[str] = []
    for passage in passages(document):
        numbers = numbers_in(passage)
        if numbers and not numbers <= kept_numbers and passage not in dropped:
            dropped.append(passage)
    return dropped
