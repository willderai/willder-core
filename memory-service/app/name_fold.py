"""How a person erasure folds a name in the graph, so the graph reads names as the app does.

The rule this module enforces: the graph finds a name in exactly the text whose fold is that
name, under the app's fold (services/memory/person-name-characters.ts, foldName). Names are
folded here with `fold_name`. Text is not: Cypher has no such function, so the graph matches it
with Java's case-insensitive regular expressions (`=~` under `(?iu)`), and `case_literal` writes
each letter of a name so that Java's case folding finds the same letters the app's fold does.
services/memory/name-fold-spellings.json holds the spellings the app, Postgres and the graph are
all tested on.

One exception: the letters Unicode assigned after 15.0 that services/memory/name-fold-newer-letters.json
lists. The app and Postgres read those from that list, whatever Unicode version they know; this
module does not, so the graph folds them as Python's `unicodedata` and Neo4j's Java know them, and
may under-erase a name spelled with one.
"""

import unicodedata


def fold_name(text: str) -> str:
    """`text` as the app folds a name and the text it looks for it in: compatibility forms
    folded (NFKC), lowercased by Unicode's mapping, "i" and a combining dot above read as "i"
    (so the Turkish capital dotted "İ", which lowercases to that pair, is "i"), composed
    (NFC), the final sigma "ς" read as "σ", and a curly apostrophe
    read as a straight one. The dotless "ı" stays its own letter, as "ß" and "ë" do. The letters
    of services/memory/name-fold-newer-letters.json, which the app reads from that list first, are
    folded here by this Python's own Unicode version (see the module docstring)."""
    lowered = unicodedata.normalize("NFKC", text).lower().replace("i\u0307", "i")
    folded = unicodedata.normalize("NFC", lowered)
    return folded.replace("\u03c2", "\u03c3").replace("\u2019", "'")


# Letters Java's case-insensitive match folds otherwise than the app's fold does: for each
# folded letter, a case-sensitive pattern for every letter of text (once NFKC-normalized, as
# Cypher reads it) whose fold it is, "i" and a combining dot above included. Java also folds the dotless "ı" with "i", the combining ypogegrammeni U+0345 with
# "ι", and the Cyrillic letter variants U+1C80 to U+1C88 with the letters they are variants
# of, as each has that letter's capital as its own; and it does not fold the capital sharp s
# "ẞ" with "ß". Any other letter of the Basic Multilingual Plane that this Python's Unicode
# assigns, Java folds as the app does; memory-service/tests/test_person_erasure_integration.py
# checks each of those on Neo4j. Letters outside it, and the letters of
# services/memory/name-fold-newer-letters.json, are not checked (see the module docstring).
_FOLD_CLASSES = {
    "i": "i\u0307|[iI\u0130]",
    "\u00df": "[\u00df\u1e9e]",
    "\u0131": "[\u0131]",
    "\u03b9": "[\u03b9\u0399]",
    "\u0345": "[\u0345]",
    "\u0432": "[\u0432\u0412]",
    "\u0434": "[\u0434\u0414]",
    "\u043e": "[\u043e\u041e]",
    "\u0441": "[\u0441\u0421]",
    "\u0442": "[\u0442\u0422]",
    "\u044a": "[\u044a\u042a]",
    "\u0463": "[\u0463\u0462]",
    "\ua64b": "[\ua64b\ua64a]",
    **{chr(cp): chr(cp) for cp in range(0x1C80, 0x1C89)},
}


def _quoted(run: str) -> str:
    """`run` quoted for a Java regular expression, matching only itself (in any case under `(?i)`)."""
    return r"\Q" + run.replace(r"\E", r"\E\\E\Q") + r"\E"


def _letter(char: str) -> str:
    """One letter of a folded name, as Java should match it: its class, case-sensitive, when
    Java's case folding would add letters to it; otherwise the letter itself."""
    if char in _FOLD_CLASSES:
        return f"(?-i:{_FOLD_CLASSES[char]})"
    return _quoted(char)


def case_literal(folded: str) -> str:
    """A Java regular expression, read under `(?iu)` against NFKC text, that matches exactly the
    text whose fold (`fold_name`) is `folded`.

    Two kinds of letter need more than Java's case folding: those in _FOLD_CLASSES, and a
    lowercase letter whose capital has no precomposed form, as "ǰ" (j with caron) has none,
    so that text holds it as "J" and a combining caron, which the app composes once lowercased.
    Such a letter is matched either way."""
    pieces: list[str] = []
    run = ""
    for char in folded:
        capital = unicodedata.normalize("NFKC", char.upper())
        spelled_apart = len(capital) > 1 and fold_name(capital) == char
        if char not in _FOLD_CLASSES and not spelled_apart:
            run += char
            continue
        if run:
            pieces.append(_quoted(run))
            run = ""
        letter = _letter(char)
        apart = "".join(_letter(fold_name(c)) for c in capital)
        pieces.append(f"(?:{letter}|{apart})" if spelled_apart else letter)
    if run:
        pieces.append(_quoted(run))
    return "".join(pieces)
