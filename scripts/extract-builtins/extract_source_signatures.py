#!/usr/bin/env python3
"""
extract_source_signatures.py

Extracts name, argument counts, argument types and return type of every
built-in from the AddUDF calls in the CLIPS 6.4.2 core source:

    AddUDF(theEnv,"name","return-type",min-args,max-args,
           "arg-type-restriction",CFunction,"CFunction",NULL);

The restriction string is ';'-separated: segment 0 is the default (for
empty segments and for arguments past the last one), segment N is
argument N. For example "*;l;l;syn" is integer, integer, then
string|symbol|instance-name.

Type codes (PopulateRestriction in exprnpsr.c):
    l integer  d float  s string  y symbol  n instance-name  m multifield
    f fact-address  i instance-address  e external-address  v void
    b boolean  * any

Usage:
    python3 extract_source_signatures.py <clips_core_source_dir> <output.json> [<original_zip_path>]

With the release zip, the output's "meta" block has the CLIPS version
(from constant.h) and the zip's hashes.
"""

import sys
import re
import glob
import json
import os
import hashlib

ADDUDF_RE = re.compile(
    r'AddUDF\(theEnv,\s*"([^"]+)"\s*,\s*(?:"([^"]*)"|NULL)\s*,\s*'
    r'(\d+|UNBOUNDED)\s*,\s*(\d+|UNBOUNDED)\s*,\s*(?:"([^"]*)"|NULL)'
)

TYPE_LABEL = {
    "l": "integer", "d": "float", "s": "string", "y": "symbol",
    "n": "instance-name", "m": "multifield", "f": "fact-address",
    "i": "instance-address", "e": "external-address", "v": "void",
    "b": "boolean", "*": "expression",
}


def decode_type_chars(chars):
    """A restriction segment (unordered type codes) as a label, e.g. "ld" -> "numeric".

    Args:
        chars: The segment's type codes.

    Returns:
        The label; "expression" if empty.
    """
    if not chars:
        return "expression"
    letters = sorted(set(chars))
    if letters == ["d", "l"]:
        return "numeric"  # the extremely common integer-or-float case
    labels = [TYPE_LABEL.get(c, c) for c in letters]
    # de-duplicate while preserving order (e.g. "*" alone -> ["expression"])
    seen = []
    for l in labels:
        if l not in seen:
            seen.append(l)
    return "|".join(seen)


def make_token(label):
    """A syntax token for a label; 'expression' stays '<expression>'.

    Args:
        label: A type label.

    Returns:
        The token, e.g. '<integer-expression>'.
    """
    return "<expression>" if label == "expression" else f"<{label}-expression>"


def decode_restriction_string(restriction, position):
    """Type label of an argument.

    Args:
        restriction: The restriction string; None means any type.
        position: The argument position, 1-based.

    Returns:
        The label.
    """
    if restriction is None:
        return "expression"
    segments = restriction.split(";")
    default_seg = segments[0] if segments else ""
    if position < len(segments) and segments[position]:
        return decode_type_chars(segments[position])
    return decode_type_chars(default_seg)


def per_argument_types(min_args, max_args, restriction):
    """Types of the required arguments, and of the repeating last argument.

    Args:
        min_args: Minimum argument count, as in the source.
        max_args: Maximum argument count, or "UNBOUNDED".
        restriction: The restriction string, or None.

    Returns:
        (types, variadic_type); variadic_type is None if not variadic.
    """
    min_n = 0 if min_args == "UNBOUNDED" else int(min_args)
    is_variadic = (max_args == "UNBOUNDED") or (
        max_args != "UNBOUNDED" and int(max_args) > min_n
    )
    positions = []
    for pos in range(1, min_n + 1):
        positions.append(decode_restriction_string(restriction, pos))
    variadic_type = None
    if is_variadic:
        variadic_type = decode_restriction_string(restriction, min_n + 1)
    return positions, variadic_type


def synthesize_syntax(name, min_args, max_args, restriction):
    """A syntax line in the manual's style, e.g.
    (+ <numeric-expression> <numeric-expression>+).

    Args:
        name: The function name.
        min_args: Minimum argument count, as in the source.
        max_args: Maximum argument count, or "UNBOUNDED".
        restriction: The restriction string, or None.

    Returns:
        The line.
    """
    min_n = 0 if min_args == "UNBOUNDED" else int(min_args)
    is_variadic = (max_args == "UNBOUNDED") or (
        max_args != "UNBOUNDED" and int(max_args) > min_n
    )

    tokens = []
    for pos in range(1, min_n + 1):
        label = decode_restriction_string(restriction, pos)
        tokens.append(make_token(label))

    if is_variadic:
        tail_label = decode_restriction_string(restriction, min_n + 1)
        if min_n == 0:
            # nothing required yet -- a standalone "zero or more" token
            tokens.append(make_token(tail_label) + "*")
        else:
            # at least one already required -- mark the last one repeatable
            tokens[-1] = tokens[-1] + "+"

    if not tokens:
        return f"({name})"
    return f"({name} " + " ".join(tokens) + ")"


VERSION_RE = re.compile(r'#define\s+VERSION_STRING\s+"([^"]+)"')


def read_clips_version(source_dir):
    """The CLIPS version from constant.h.

    Args:
        source_dir: The core source directory.

    Returns:
        The version string, or None if not found.
    """
    path = os.path.join(source_dir, "constant.h")
    if not os.path.exists(path):
        return None
    text = open(path, encoding="utf-8", errors="ignore").read()
    m = VERSION_RE.search(text)
    return m.group(1) if m else None


def hash_file(path):
    """SHA-256, SHA-1 and MD5 of the release zip.

    Args:
        path: Path of the zip.

    Returns:
        {"filename", "sha256", "sha1", "md5"}.
    """
    sha256, sha1, md5 = hashlib.sha256(), hashlib.sha1(), hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            sha256.update(chunk)
            sha1.update(chunk)
            md5.update(chunk)
    return {
        "filename": os.path.basename(path),
        "sha256": sha256.hexdigest(),
        "sha1": sha1.hexdigest(),
        "md5": md5.hexdigest(),
    }


def extract(source_dir):
    """Read every AddUDF call in the source directory's .c files.

    Args:
        source_dir: The core source directory.

    Returns:
        {name: record}; the first registration of a name wins.
    """
    records = {}
    for path in glob.glob(os.path.join(source_dir, "*.c")):
        text = open(path, encoding="utf-8", errors="ignore").read()
        for m in ADDUDF_RE.finditer(text):
            name, ret, min_args, max_args, restriction = m.groups()
            if name.startswith("("):
                continue  # internal pseudo-functions, not real built-ins
            if name in records:
                continue  # keep first registration if a name repeats
            arg_types, variadic_type = per_argument_types(min_args, max_args, restriction)
            records[name] = {
                "name": name,
                "return_types": [TYPE_LABEL.get(c, c) for c in (ret or "")],
                "min_args": min_args,
                "max_args": max_args,
                "raw_restriction": restriction,
                "arg_types": arg_types,
                "variadic_type": variadic_type,
                "syntax": synthesize_syntax(name, min_args, max_args, restriction),
                "source_file": os.path.basename(path),
            }
    return records


def main():
    """Parse the command line, extract the signatures and write them as JSON."""
    if len(sys.argv) not in (3, 4):
        print("Usage: python3 extract_source_signatures.py <clips_core_source_dir> <output.json> [<original_zip_path>]")
        sys.exit(1)

    source_dir, out_path = sys.argv[1], sys.argv[2]
    zip_path = sys.argv[3] if len(sys.argv) == 4 else None

    records = extract(source_dir)

    meta = {"clips_version": read_clips_version(source_dir)}
    if zip_path:
        meta["source_archive"] = hash_file(zip_path)

    output = {"meta": meta, "functions": records}

    with open(out_path, "w") as f:
        json.dump(output, f, indent=2)

    print(f"Extracted {len(records)} built-in signature(s) -> {out_path}")
    print(f"  CLIPS version: {meta['clips_version']}")
    if zip_path:
        print(f"  Source archive SHA-256: {meta['source_archive']['sha256']}")


if __name__ == "__main__":
    main()
