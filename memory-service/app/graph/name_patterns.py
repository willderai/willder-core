"""The patterns that find one person in the graph, for erasing them.

Cypher's `=~` takes a Java regular expression matched against a whole string, so each
pattern here is one: a name or address in text (`text_patterns`), a record's own name
(`record_name_patterns`), and the same name written without spaces (the `joined_`
pair). The character classes and rules mirror the app's
services/memory/person-name-characters.ts and person-erasure.ts, so both stores erase
the same person."""

import re
import unicodedata

from ..name_fold import case_literal


# A run of whitespace between a name's words: tab, NBSP and the other Unicode spaces too.
_SPACE = r"[\s\u00a0\u2000-\u200a\u202f\u205f\u3000]"

# Whitespace within a line: no tab, line break, vertical tab or form feed, which part two entries
# rather than two words of one name. The same as the app's (services/memory/person-name-characters.ts,
# NAME_INLINE_SPACE).
_INLINE_SPACE = r"[ \u00a0\u2000-\u200a\u202f\u205f\u3000]"

# A letter or digit, which continues a name's word into a longer one: the app's class, by code
# point (services/memory/person-name-characters.ts, NAME_LETTER), combining accents in and
# symbols such as the euro sign out, so both stores read the same characters as part of a word. The app
# lowercases text before it matches; here the match ignores case, so the lowercase ranges stand
# for their capitals too.
_LETTER = r"[0-9a-z\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u1fff\u2070-\u218f\u2c00-\u2dff\u2e80-\u2fff\u3040-\ud7ff\uf900-\ufdff\ufe70-\ufefe\uff10-\uff19\uff41-\uff5a\uff66-\uffdc]"

# Words that, after a hyphen, make a name into a modifier ("the Dana Whitfield-approved
# budget") rather than a longer surname. The same list as the app's
# (services/memory/person-name-characters.ts, NAME_MODIFIER_WORDS).
_MODIFIER_WORDS = (
    "approved",
    "authored",
    "backed",
    "based",
    "built",
    "designed",
    "endorsed",
    "era",
    "funded",
    "led",
    "managed",
    "owned",
    "related",
    "reviewed",
    "run",
    "signed",
    "specific",
    "sponsored",
    "style",
    "written",
)

# A hyphen between words: ASCII, and the Unicode hyphen and non-breaking hyphen; and the marks
# that join a name's words when it is written without spaces ("dana_whitfield"). The same as
# the app's (services/memory/person-name-characters.ts, NAME_HYPHEN and NAME_JOINER).
_HYPHEN = r"[-\u2010\u2011]"
_JOINER = r"[-\u2010\u2011_.]"

# A dash that continues a word into the next when nothing parts them: the hyphens, the figure
# and en dashes, the minus sign and the soft hyphen. The em dash and the horizontal bar are
# punctuation and part words. The same as the app's (services/memory/person-name-characters.ts,
# NAME_DASH).
_DASH = r"[-\u00ad\u2010-\u2013\u2212]"

# A dash run joining a name's word to another word: "-barnes", never "-approved".
_HYPHEN_JOIN = rf"{_DASH}+(?!(?:{'|'.join(_MODIFIER_WORDS)})(?!{_LETTER}))"

# Where a name may start and end in text: not inside a word, and not where a hyphen joins
# it to another ("Mary-Dana", "Whitfield-Barnes"). A bullet dash before it or a modifier
# after it ("-Dana Whitfield", "Whitfield-approved") is not a join.
_NAME_START = rf"(?<!{_LETTER})(?<!{_LETTER}{_DASH}+)"
_NAME_END = rf"(?!{_LETTER})(?!{_HYPHEN_JOIN}{_LETTER})"

# A lowercase letter and an uppercase one, by code point, between which camel case changes
# word ("DanaWhitfield"), and a digit after either ("DanaWhitfield2026"). The same classes as
# the app's (services/memory/person-name-characters.ts, CAMEL_LOWER and CAMEL_UPPER).
_CAMEL_LOWER = r"[a-z\u00df-\u00f6\u00f8-\u00ff\u03ac-\u03ce\u0430-\u045f]"
_CAMEL_UPPER = r"[A-Z\u00c0-\u00d6\u00d8-\u00de\u0386\u0388-\u038a\u038c\u038e\u038f\u0391-\u03a1\u03a3-\u03ab\u0400-\u042f]"

# A camel-case step, read case-sensitively inside a case-insensitive pattern.
_CAMEL_STEP = (
    rf"(?:(?<=(?-i:{_CAMEL_LOWER}))(?=(?-i:{_CAMEL_UPPER}))"
    rf"|(?<=(?-i:{_CAMEL_LOWER}|{_CAMEL_UPPER}))(?=[0-9]))"
)

# A dash run joining a word to the next in a name written without spaces, where a modifier word
# may also end at a camel-case step ("-ledTeam"), as the app marks one before it reads the word
# (services/memory/person-name-characters.ts, markWordSteps).
_JOINED_HYPHEN_JOIN = rf"{_DASH}+(?!(?:{'|'.join(_MODIFIER_WORDS)})(?:(?!{_LETTER})|{_CAMEL_STEP}))"

# A run of joining marks that is not hyphens alone, which may stand where her own name has
# whitespace: a hyphen there makes another name ("Mary-Ann Li" is not Mary Ann Li).
_NOT_HYPHENS_ALONE = rf"(?={_JOINER}*[_.]){_JOINER}+"

_JOINED_PART = re.compile(rf"{_LETTER}+(?:'{_LETTER}+)*")

# Whitespace and joining marks, where a name written without spaces is split into words.
_PART_BREAK = re.compile(r"([\s\u00a0\u2000-\u200a\u202f\u205f\u3000\-\u2010\u2011_.]+)")
_HAS_SPACE = re.compile(r"[\s\u00a0\u2000-\u200a\u202f\u205f\u3000]")


def _literal(text: str) -> str:
    """`text`, a folded name or address, for a Java regular expression (Cypher's `=~` under
    `(?iu)`): it matches the text that folds to it (app/name_fold.py, case_literal), but for the
    letters of services/memory/name-fold-newer-letters.json, which the graph folds by Python's and
    Java's own Unicode versions."""
    return case_literal(text)


def _spaced_name(name: str) -> str:
    """A name's words in order, separated by any run of whitespace."""
    return f"{_SPACE}+".join(_literal(w) for w in name.split())


def _joined_parts(name: str) -> tuple[list[str], list[bool]] | None:
    """A name's words as it is written without spaces, and for each pair of neighbours whether
    the name itself joins them by a mark rather than whitespace: "anne-marie dupont" is "anne",
    "marie", "dupont", joined by a mark and then a space. None when a word holds anything but
    the app's letters and an apostrophe inside, or there are fewer than two. The same rule as
    the app's (services/memory/person-name-characters.ts, joinedName)."""
    pieces = _PART_BREAK.split(name)
    words: list[str] = []
    marks: list[bool] = []
    for i in range(0, len(pieces), 2):
        if not pieces[i]:
            continue
        if words:
            marks.append(not _HAS_SPACE.search(pieces[i - 1]))
        words.append(pieces[i])
    if len(words) >= 2 and all(_JOINED_PART.fullmatch(w) for w in words):
        return words, marks
    return None


def _joined_words(words: list[str], marks: list[bool], spaces: bool) -> str:
    """Her words joined as a name written without spaces may join them: where her own name has
    a mark, by any joining marks or, when `spaces`, an inline space (never a tab or a line break,
    which part two entries); where it has whitespace, by marks that are not hyphens alone or,
    when `spaces`, any whitespace; and in either place by a camel-case step."""

    def joint(mark: bool) -> str:
        if mark:
            return rf"(?:{_JOINER}+{f'|{_INLINE_SPACE}+' if spaces else ''}|{_CAMEL_STEP})"
        return rf"(?:{_NOT_HYPHENS_ALONE}{f'|{_SPACE}+' if spaces else ''}|{_CAMEL_STEP})"

    return words[0] + "".join(joint(mark) + w for mark, w in zip(marks, words[1:], strict=False))


# The fewest characters a name run together with nothing between its words must have to be
# read as hers ("tomlee" beside an "@"; "annli" is never Ann Li), and to be read anywhere
# ("danawhitfield"; "kitchen" for Kit Chen is read only beside an "@"). The same as the
# app's (services/memory/person-name-characters.ts, CONCATENATED_NAME_MIN_LENGTH and
# CONCATENATED_NAME_PROSE_MIN_LENGTH).
_CONCATENATED_NAME_MIN_LENGTH = 6
_CONCATENATED_NAME_PROSE_MIN_LENGTH = 8

# The one mark beside which a shorter run is read as hers in text, on either side ("@kitchen",
# "kitchen@x.com"; never "in the kitchen.", "window.location" or "window_start"). The same as the
# app's (services/memory/person-name-characters.ts, SHORT_RUN_MARK).
_SHORT_RUN_MARK = "@"


def _concatenated_forms(parts: tuple[list[str], list[bool]]) -> list[str]:
    """Her words run together, as written and without her apostrophe, each when long enough. The
    same rule as the app's (services/memory/person-name-characters.ts, concatenatedNames)."""
    run = "".join(parts[0])
    return [
        f
        for f in dict.fromkeys([run, run.replace("'", "")])
        if len(f) >= _CONCATENATED_NAME_MIN_LENGTH
    ]


_HYPHEN_RUN = re.compile(rf"{_HYPHEN}+")
_SPACE_RUN = re.compile(rf"{_SPACE}+")


def _joined_parts_all(name: str) -> list[tuple[tuple[list[str], list[bool]], bool]]:
    """_joined_parts, and, when the name has both whitespace and a hyphen of its own and no "_" or
    ".", it run together up to that hyphen, each read as a name of its own: her words run together
    where she has whitespace ("kimji-woo" for Kim Ji-woo) and her hyphenated words run together
    ("maria_lopezgarcia" for Maria Lopez-Garcia), when her whole name run together is long
    enough. Each with whether it is such a run, whose words whitespace never joins. Empty when
    _joined_parts is None. The same rule as the app's
    (services/memory/person-name-characters.ts, joinedNames and JoinedName.runTogether)."""
    parts = _joined_parts(name)
    if parts is None:
        return []
    forms = [(parts, False)]
    if (
        re.search(_HYPHEN, name)
        and _HAS_SPACE.search(name)
        and not re.search(r"[_.]", name)
        and _concatenated_forms(parts)
    ):
        for variant in (_SPACE_RUN.sub("", name), _HYPHEN_RUN.sub("", name)):
            if (run := _joined_parts(variant)) is not None:
                forms.append((run, True))
    return forms


# Letters with no decomposition that ASCII writes another way, and the Unicode hyphens. The same as the app's
# (services/memory/person-name-characters.ts, ASCII_LETTERS).
_ASCII_LETTERS = {
    "\u2010": "-",
    "\u2011": "-",
    "\u0127": "h",
    "\u0167": "t",
    "\u014b": "ng",
    "\u00df": "ss",
    "\u0131": "i",
    "\u00f8": "o",
    "\u0111": "d",
    "\u00f0": "d",
    "\u0142": "l",
    "\u00e6": "ae",
    "\u0153": "oe",
    "\u00fe": "th",
}


def _ascii_spelling(name: str) -> str | None:
    """`name` as a system that writes ASCII only spells it, accents left off ("Zoe Ferrand" for
    "Zoë Ferrand", "hans weiss" for "hans weiß"), or None when that changes nothing or leaves a
    letter outside ASCII. The erasure reads it as her name too. The same rule as the app's
    (services/memory/person-name-characters.ts, asciiSpelling)."""
    decomposed = unicodedata.normalize("NFD", name)
    ascii_form = "".join(
        _ASCII_LETTERS.get(c.lower(), c)
        for c in decomposed
        if not unicodedata.category(c).startswith("M")
    )
    if ascii_form != name and all(" " <= c <= "~" for c in ascii_form):
        return ascii_form
    return None


def with_ascii_spellings(names: list[str]) -> list[str]:
    """`names`, each followed by its _ascii_spelling when it has one that is not already listed and
    is long enough to erase by (two words, five characters: app/schemas.py, ErasePersonRequest)."""
    spellings = [
        a for n in names if (a := _ascii_spelling(n)) and len(a.split()) >= 2 and len(a) >= 5
    ]
    return list(dict.fromkeys([*names, *spellings]))


def _with_concatenated(joined: str, parts: tuple[list[str], list[bool]], in_text: bool) -> str:
    """`joined`, or her whole name run together with nothing between its words as well, as
    written and, when her words hold an apostrophe, without it, each when long enough
    ("danawhitfield", "DANAWHITFIELD", "siobhanobrien"). A camel-case step is zero-width here,
    so "RoryMcDonald2026" is found too. A word spelled the same as her whole name ("willpower" for
    Will Power) is erased with her, accepted as missing her is worse. In text (`in_text`), a run
    under _CONCATENATED_NAME_PROSE_MIN_LENGTH characters is read only beside an "@", so "Coffee
    is in the kitchen." and "window_start" are kept and "kitchen@x.com" is not. The same rule as the
    app's (services/memory/person-name-characters.ts, concatenatedNames and inTextRun)."""
    forms = _concatenated_forms(parts)
    if not forms:
        return joined

    def form(run: str) -> str:
        pattern = _literal(run)
        if not in_text or len(run) >= _CONCATENATED_NAME_PROSE_MIN_LENGTH:
            return pattern
        return f"(?:(?<={_SHORT_RUN_MARK}){pattern}|{pattern}(?={_SHORT_RUN_MARK}))"

    return "(?:" + "|".join([joined, *(form(f) for f in forms)]) + ")"


def _joined_name(parts: tuple[list[str], list[bool]], run_together: bool = False) -> str:
    """A name with its words joined by `_`, `.`, hyphens, whitespace or a camel-case step, with
    no letter or digit on either side ("Dana_Whitfield_offer.pdf", "DanaWhitfield offer.pdf",
    "Dana Whitfield2.pdf"). Three rules keep other people out: it may end at a camel-case step
    but never start at one, though it may start right after a digit ("JoAnnLi" is not Ann Li,
    "2026danawhitfield" is Dana Whitfield); a dash on either side continues a word
    ("Dana_Whitfield-Barnes"); and hyphens alone never stand where her own name has whitespace,
    as another person's double surname or compound given name is written so
    ("dana-whitfield.pdf", "jean-pierre dupont"). The same rule as the app's
    (services/memory/person-name-characters.ts, joinedNamePattern), matched against _marked.
    It opens with her first word, so a long run of marks is not searched back at every place."""
    words, marks = [_literal(p) for p in parts[0]], parts[1]
    start = rf"(?:(?<!{_LETTER})|(?<=[0-9]))(?<!{_LETTER}{_DASH}+)"
    end = rf"(?:(?!{_LETTER})|{_CAMEL_STEP})(?!{_JOINED_HYPHEN_JOIN}{_LETTER})"
    return rf"(?={words[0]}){start}{_with_concatenated(_joined_words(words, marks, spaces=not run_together), parts, in_text=True)}{end}"


def _joined_record_name(parts: tuple[list[str], list[bool]]) -> str:
    """A record's whole name written without spaces: her words joined as in text, by marks or a
    camel-case step ("dana_whitfield", "DanaWhitfield"), never by hyphens alone where her own name
    has whitespace (a login "dana-whitfield" is spelled as another person's double surname is).
    The same rule as the app's (services/memory/person-name-characters.ts,
    joinedRecordNamePattern)."""
    return _with_concatenated(
        _joined_words([_literal(p) for p in parts[0]], parts[1], spaces=False), parts, in_text=False
    )


def _record_name_forms(name: str) -> list[str]:
    """A name as a record's whole name may hold it: in order, and a two-word name also
    surname first, with or without a comma ("Whitfield, Dana"). Text is never read
    surname first: "Wei Li, Ann Chen" is two people, not "Ann Li"."""
    words = name.split()
    forms = [_spaced_name(name)]
    if len(words) == 2:
        forms.append(f"{_literal(words[1])}(?:,{_SPACE}*|{_SPACE}+){_literal(words[0])}")
    return forms


def composed(prop: str) -> str:
    """Cypher: `prop` as the patterns read it: compatibility forms folded (NFKC, which composes
    too, so an accent stored as a combining mark matches the precomposed one, and "I" with a
    combining dot above is "\u0130"), and a curly apostrophe straight. Case is left to the
    patterns, which match under `(?iu)` as the app's fold does, but for the letters of
    services/memory/name-fold-newer-letters.json (app/name_fold.py)."""
    return f"replace(normalize(coalesce({prop}, ''), NFKC), '\\u2019', \"'\")"


def _marked(prop: str) -> str:
    """Cypher: `prop` as a name written without spaces is looked for in it, as the app reads it
    (services/memory/person-name-characters.ts, markWordSteps): composed, without any U+0001,
    each "%20" of a link a space and each "%27" and "%E2%80%99" an apostrophe. Camel-case steps are
    read by case in the patterns."""
    spaced = f"replace(replace({composed(prop)}, '\\u0001', ''), '%20', ' ')"
    return (
        f"replace(replace(replace({spaced}, '%27', \"'\"), '%E2%80%99', \"'\"), '%e2%80%99', \"'\")"
    )


def names_person(prop: str, patterns: str, joined: str) -> str:
    """Cypher: whether `prop` names the person: a pattern of `$patterns` against it composed,
    or one of `$joined` (a name written without spaces) against it _marked."""
    return (
        f"(any(p IN ${patterns} WHERE {composed(prop)} =~ p)"
        f" OR any(p IN ${joined} WHERE {_marked(prop)} =~ p))"
    )


def text_patterns(emails: list[str], names: list[str]) -> list[str]:
    """Case-insensitive patterns for `=~`, which matches a whole string, that find the
    person in TEXT (an episode's body, a fact node's text, an edge's fact, a summary) as
    a whole identifier, never inside a longer one: erasing "Al Li" leaves "Sal Lin" and
    "Al Liú", erasing dan@acme.com leaves jordan@acme.com. A name has no letter or digit
    on either side, and no hyphen joining it to another word ("Dana Whitfield-Barnes" is
    another person, "the Dana Whitfield-approved budget" and a "-Dana Whitfield" bullet
    name her); an address has
    nothing on its left that can belong to an address and nothing on its right that would
    continue its domain, so a full stop ending a sentence is fine but al@acme.example.org
    is another address. A name is found only given name first: "Wei Li, Ann Chen" is
    two people, not "Ann Li". A name written without spaces is found by joined_text_patterns.
    The same rule as the app's own erasure (services/memory/person-erasure.ts, textPatterns)."""
    address = [
        rf"(?isu).*(?<![a-z0-9._%+-]){_literal(e)}(?![a-z0-9-])(?!\.[a-z0-9-]).*" for e in emails
    ]
    name = [
        rf"(?isu).*(?={_literal(n.split()[0])}){_NAME_START}(?:{_spaced_name(n)}){_NAME_END}.*"
        for n in names
    ]
    return address + name


def joined_text_patterns(names: list[str]) -> list[str]:
    """Patterns for `=~` that find the person's name written without spaces in TEXT, matched
    against it _marked (_joined_name)."""
    return [
        rf"(?isu).*(?:{_joined_name(parts, run)}).*"
        for n in names
        for parts, run in _joined_parts_all(n)
    ]


def record_name_patterns(emails: list[str], names: list[str]) -> list[str]:
    """Patterns for a record's own NAME (an entity's, an episode's): the person's whole
    name and nothing else, however its words are spaced or ordered, or their whole
    address. "Mary Ann Li", "Ann Li Wei" and "Dana Whitfield Foundation" are other
    records, erased only if their own text names the person. The same rule as the app's
    (services/memory/person-erasure.ts, recordNamePatterns)."""
    forms = [_literal(e) for e in emails] + [form for n in names for form in _record_name_forms(n)]
    return [rf"(?isu){_SPACE}*(?:{form}){_SPACE}*" for form in forms]


def joined_record_name_patterns(names: list[str]) -> list[str]:
    """Patterns for a record's own NAME written without spaces, matched against it _marked
    (_joined_record_name)."""
    return [
        rf"(?isu){_SPACE}*(?:{_joined_record_name(parts)}){_SPACE}*"
        for n in names
        for parts, _ in _joined_parts_all(n)
    ]
