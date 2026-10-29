"""Which passages of a source document are kept verbatim. Each case writes the
document and the extracted facts by hand, so the expected passages follow from
the inputs."""

from app.passages import numbers_in, passages, passages_with_dropped_numbers

README = """README of example-org/example-repo

# Example repo

- WebSocket server pushes live price ticks to the UI at up to 55 updates/min
- Built with Next.js and Postgres
1. Handles 3 exchanges

```
PORT=3000 npm run dev
```
"""


def test_numbers_ignore_identifiers_and_thousands_separators():
    assert numbers_in("Commit abc1234 on v1.2: raise the $50,000 cap to 1.5x for 55 users") == {
        "50000",
        "1.5",
        "55",
    }


def test_passages_drop_list_markers_and_code_blocks():
    assert passages(README) == [
        "README of example-org/example-repo",
        "Example repo",
        "WebSocket server pushes live price ticks to the UI at up to 55 updates/min",
        "Built with Next.js and Postgres",
        "Handles 3 exchanges",
    ]


def test_long_line_splits_into_sentences():
    line = "First claim holds 7 items. " + "x" * 400 + ". Last one."
    assert passages(line)[0] == "First claim holds 7 items."


def test_keeps_the_passage_whose_number_extraction_dropped():
    extracted = [
        "Example repo uses WebSocket for live price ticks",
        "Example repo handles 3 exchanges",
    ]
    assert passages_with_dropped_numbers(README, extracted) == [
        "WebSocket server pushes live price ticks to the UI at up to 55 updates/min",
    ]


def test_keeps_nothing_when_every_number_survived():
    extracted = [
        "The WebSocket server sends up to 55 updates per minute",
        "Example repo handles 3 exchanges",
    ]
    assert passages_with_dropped_numbers(README, extracted) == []


def test_a_passage_is_kept_once_even_when_repeated():
    assert passages_with_dropped_numbers("Limit is 10 rps\nLimit is 10 rps", []) == [
        "Limit is 10 rps"
    ]
