#!/usr/bin/env python3
"""
extract_hover_data.py

Extracts descriptions and syntax of the built-in functions from the CLIPS
Basic Programming Guide PDF.

The guide documents functions as a numbered heading, a description, a
"Syntax" block and an "Example" block. Function names come from the
syntax block, or from the description when there is none ("The gensym
function ..."). Examples are not kept.

Only names in Appendix H or in source_functions.json are accepted.
Appendix H alone is incomplete (it prints some names twice and omits
integerp), hence the source list. Every accepted name gets a record; names
the guide doesn't document get a placeholder description.

Usage:
    python3 extract_hover_data.py clipsbeginnersguide.pdf hover_data.json [source_functions.json]
"""

import sys
import re
import json
import pdfplumber

HEADING_RE = re.compile(r"^(\d+(?:\.\d+)+)\s+(.*\S)\s*$")
FUNC_NAME_RE = re.compile(r"\(([A-Za-z0-9_$*+\-/<>=!.?]+)")
# BNF productions like "<not-CE> ::= (not ...)" are rule syntax, not
# signatures. Without skipping them, the CE section would claim the
# functions not, and, or.
BNF_PRODUCTION_RE = re.compile(r"^\s*<[^>]+>\s*::=")
FOOTER_RE = re.compile(r"^\d*\s*(Section|Appendix) \d+:")
PAGE_NUM_FOOTER_RE = re.compile(r"^CLIPS Basic Programming Guide \d+$|^\d+\s+(Section|Appendix)")


def clean_lines(pdf):
    """Yield each content line of the PDF, without headers and footers.

    Args:
        pdf: An open pdfplumber PDF.

    Yields:
        (page_number, line) pairs; pages count from 1.
    """
    for page_no, page in enumerate(pdf.pages, start=1):
        text = page.extract_text() or ""
        for line in text.split("\n"):
            stripped = line.strip()
            if not stripped:
                continue
            if stripped == "CLIPS Reference Manual":
                continue
            if stripped.startswith("CLIPS Basic Programming Guide "):
                continue
            if PAGE_NUM_FOOTER_RE.match(stripped):
                continue
            yield page_no, line


def split_syntax_signature(syntax_lines):
    """Split a Syntax block into the signature and the prose that may follow
    it: the first balanced line that reads like a sentence starts the notes.

    Args:
        syntax_lines: The block's lines.

    Returns:
        (signature, notes), each a string, possibly empty.
    """
    signature, notes = [], []
    depth = 0
    in_signature = True
    for raw in syntax_lines:
        line = raw.strip()
        if not line:
            continue
        looks_code = line.startswith("(") or line.startswith("<") or depth > 0
        if in_signature and looks_code:
            signature.append(line)
            depth += line.count("(") - line.count(")")
        else:
            in_signature = False
            notes.append(line)
    return "\n".join(signature).strip(), " ".join(notes).strip()


def split_body(body_lines):
    """Split a heading's lines into description and syntax. The Example
    block only marks where the syntax ends.

    Args:
        body_lines: The lines after the heading.

    Returns:
        (description, signature); notes after the signature join the description.
    """
    description, syntax = [], []
    section = "description"
    for line in body_lines:
        s = line.strip()
        if s == "Syntax":
            section = "syntax"
            continue
        if s == "Example" or re.match(r"^Example \d+", s):
            break  # nothing after this point is kept
        if section == "description":
            description.append(line)
        else:
            syntax.append(line)

    signature, syntax_notes = split_syntax_signature(syntax)
    full_description = " ".join(description).strip()
    if syntax_notes:
        full_description = (full_description + " " + syntax_notes).strip()

    return full_description, signature


def extract_appendix_h_names(lines):
    """Names from Appendix H, used to drop junk matches such as BNF
    placeholders or shell flags.

    Args:
        lines: (page_number, line) pairs from clean_lines.

    Returns:
        The set of names.
    """
    started = False
    collected = []
    for _, line in lines:
        s = line.strip()
        if not started:
            if "Reserved Function Names" in s:
                started = True
            continue
        if s == "Index":
            break
        collected.append(s)

    text = " ".join(collected)
    # drop the intro paragraph ("This appendix lists all of the functions...")
    marker = "these names."
    if marker in text:
        text = text[text.index(marker) + len(marker):]

    names = {tok for tok in text.split() if not tok.isdigit()}
    return names


SENTENCE_END_RE = re.compile(r"(?<![A-Z])(?<!\betc)(?<!\be\.g)(?<!\bi\.e)\.(?=\s|$)")


UNDOCUMENTED_TEXT = "Undocumented in the CLIPS Basic Programming Guide."


def first_sentence(text):
    """First sentence of a description, not split at e.g., i.e. or etc.

    Args:
        text: The description.

    Returns:
        The sentence, or UNDOCUMENTED_TEXT if the text is empty.
    """
    if not text or not text.strip():
        return UNDOCUMENTED_TEXT
    m = SENTENCE_END_RE.search(text)
    if not m:
        return text.strip()
    return text[: m.end()].strip()


TRIG_ROW_RE = re.compile(
    r"^([a-z]+)\s+([a-z]+)\s+([a-z]+)\s+hyperbolic\s+\2$"
)


def extract_trig_table(body_lines):
    """Section 12.5.11 lists the trig functions as a table, e.g.
    'acos arccosine acosh hyperbolic arccosine'. All take one number.

    Args:
        body_lines: The section's lines.

    Returns:
        {name: {"description", "syntax"}} for the plain and hyperbolic functions.
    """
    results = {}
    for line in body_lines:
        m = TRIG_ROW_RE.match(line.strip())
        if not m:
            continue
        plain_name, word, hyp_name = m.groups()
        results[plain_name] = {
            "description": f"The {plain_name} function returns the {word} of its argument.",
            "syntax": f"({plain_name} <numeric-expression>)",
        }
        results[hyp_name] = {
            "description": f"The {hyp_name} function returns the hyperbolic {word} of its argument.",
            "syntax": f"({hyp_name} <numeric-expression>)",
        }
    return results


def guess_name_from_description(description):
    """Function names from a description without a Syntax block, e.g.
    'The gensym function returns ...'.

    Args:
        description: The description.

    Returns:
        A list with the name, or an empty list.
    """
    m = re.search(r"\bThe\s+([A-Za-z0-9_$*+\-/<>=!.?]+)\s+(?:function|command)\b",
                   description)
    if m:
        return [m.group(1)]
    return []


def is_reference_section(number):
    """Whether a heading is in Section 12 or 13, the function reference.

    Args:
        number: The heading number, e.g. "12.5.11", or None.
    """
    return bool(number) and number.split(".")[0] in ("12", "13")


def extract(pdf_path, extra_allowed_names=None):
    """Extract one record per documented or allowed function name.

    Args:
        pdf_path: Path of the Basic Programming Guide PDF.
        extra_allowed_names: Names accepted besides Appendix H, or None.

    Returns:
        {name: record}; a record has name, section, title, page, description
        and syntax.
    """
    records = {}  # function_name -> record (first occurrence wins)

    with pdfplumber.open(pdf_path) as pdf:
        lines = list(clean_lines(pdf))

    allowed_names = extract_appendix_h_names(lines)
    if extra_allowed_names:
        allowed_names = allowed_names | set(extra_allowed_names)

    # Locate every heading line and slice the document into heading-bodies.
    headings = []
    for idx, (page_no, line) in enumerate(lines):
        m = HEADING_RE.match(line.strip())
        if m:
            headings.append((idx, page_no, m.group(1), m.group(2)))

    for h_i, (idx, page_no, number, title) in enumerate(headings):
        end_idx = headings[h_i + 1][0] if h_i + 1 < len(headings) else len(lines)
        body_lines = [l for (_, l) in lines[idx + 1:end_idx]]

        if number == "12.5.11":  # Trigonometric Functions -- table, not Syntax/Example
            for name, info in extract_trig_table(body_lines).items():
                if name in records:
                    continue
                records[name] = {
                    "name": name,
                    "section": number,
                    "title": title,
                    "page": page_no,
                    "description": info["description"],
                    "syntax": info["syntax"],
                }
            continue

        description, syntax = split_body(body_lines)

        raw_names = [
            name
            for line in (syntax.split("\n") if syntax else [])
            if not BNF_PRODUCTION_RE.match(line)
            for name in FUNC_NAME_RE.findall(line)
        ]
        syntax_names = [n for n in raw_names if not allowed_names or n in allowed_names]
        fallback_names = guess_name_from_description(description)
        fallback_names = [n for n in fallback_names if not allowed_names or n in allowed_names]

        # The description can name a function the Syntax line doesn't: 12.1.10
        # describes external-addressp but its syntax still says pointerp.
        # Add such names too, with the syntax rewritten to that name (only if
        # there is exactly one syntax name to replace).
        entries = {n: syntax for n in syntax_names}
        for name in fallback_names:
            if name in entries:
                continue
            if syntax and len(raw_names) == 1 and raw_names[0] != name:
                entries[name] = syntax.replace(raw_names[0], name)
            elif not syntax:
                entries[name] = None
            # several syntax names: don't guess which to rewrite

        if not entries:
            continue  # this heading isn't a function/command entry at all

        for name, name_syntax in entries.items():
            # First definition wins, except that Sections 12/13 win over
            # earlier partial mentions (e.g. bind in 9.6.4).
            if name in records and not (
                is_reference_section(number) and not is_reference_section(records[name]["section"])
            ):
                continue
            records[name] = {
                "name": name,
                "section": number,
                "title": title,
                "page": page_no,
                "description": first_sentence(description),
                "syntax": name_syntax,
            }

    # Every allowed name gets an entry, documented or not.
    for name in sorted(allowed_names - records.keys()):
        records[name] = {
            "name": name,
            "section": None,
            "title": None,
            "page": None,
            "description": UNDOCUMENTED_TEXT,
            "syntax": None,
        }

    return records


def load_source_names(path):
    """Names from source_functions.json ({"meta", "functions"} or a flat dict).

    Args:
        path: Path of the file.

    Returns:
        The set of names.
    """
    data = json.load(open(path))
    functions = data.get("functions", data)
    return set(functions.keys())


def main():
    """Parse the command line, extract the records and write them as JSON."""
    if len(sys.argv) not in (3, 4):
        print("Usage: python3 extract_hover_data.py <input.pdf> <output.json> [source_functions.json]")
        sys.exit(1)

    pdf_path, out_path = sys.argv[1], sys.argv[2]
    extra_names = load_source_names(sys.argv[3]) if len(sys.argv) == 4 else None

    records = extract(pdf_path, extra_allowed_names=extra_names)

    with open(out_path, "w") as f:
        json.dump(records, f, indent=2)

    documented = sum(1 for r in records.values() if r["description"] != UNDOCUMENTED_TEXT)
    print(f"Extracted {len(records)} built-in(s) -> {out_path}")
    print(f"  {documented} with a real description, "
          f"{len(records) - documented} marked undocumented")


if __name__ == "__main__":
    main()
