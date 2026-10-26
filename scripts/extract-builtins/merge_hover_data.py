#!/usr/bin/env python3
"""
merge_hover_data.py

Merges hover_data.json (from the manual) and source_functions.json (from
the C source) into one dataset, by name:

* The manual's syntax is kept when present; otherwise the syntax built
  from the source is used.
* Names only in the source are added as undocumented records.
* Records with source data also get arg_types (one per required argument)
  and variadic_type (the repeating last argument, or null).

The source file's "meta" block is copied into the output.

Usage:
    python3 merge_hover_data.py hover_data.json source_functions.json merged_hover_data.json
"""

import sys
import json

UNDOCUMENTED_TEXT = "Undocumented in the CLIPS Basic Programming Guide."

# Fields copied straight from a source_functions.json record onto the
# merged record whenever that name exists in source.
SOURCE_PASSTHROUGH_FIELDS = (
    "min_args", "max_args", "return_types", "source_file",
    "arg_types", "variadic_type",
)


def merge(hover_data, source_data):
    """Merge the manual's records with the source's, by name.

    Args:
        hover_data: {name: record} from extract_hover_data.py.
        source_data: {name: record} from extract_source_signatures.py.

    Returns:
        {name: merged record}.
    """
    merged = {}

    for name, entry in hover_data.items():
        record = dict(entry)
        src = source_data.get(name)

        if src:
            for field in SOURCE_PASSTHROUGH_FIELDS:
                record[field] = src.get(field)
            if record.get("syntax") is None:
                record["syntax"] = src["syntax"]
                record["syntax_source"] = "synthesized-from-source"
            else:
                record["syntax_source"] = "manual"
        else:
            for field in SOURCE_PASSTHROUGH_FIELDS:
                record.setdefault(field, None)
            record["syntax_source"] = "manual" if record.get("syntax") else None

        merged[name] = record

    # names present in source but never in the PDF's Appendix H at all
    for name, src in source_data.items():
        if name in merged:
            continue
        record = {
            "name": name,
            "section": None,
            "title": None,
            "page": None,
            "description": UNDOCUMENTED_TEXT,
            "syntax": src["syntax"],
            "syntax_source": "synthesized-from-source",
        }
        for field in SOURCE_PASSTHROUGH_FIELDS:
            record[field] = src.get(field)
        merged[name] = record

    return merged


def main():
    """Parse the command line, merge the two files and write the result as JSON."""
    if len(sys.argv) != 4:
        print("Usage: python3 merge_hover_data.py <hover_data.json> <source_functions.json> <output.json>")
        sys.exit(1)

    hover_path, source_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
    hover_data = json.load(open(hover_path))
    source_json = json.load(open(source_path))
    source_meta = source_json.get("meta", {})
    source_data = source_json.get("functions", source_json)

    merged = merge(hover_data, source_data)
    output = {"meta": source_meta, "functions": merged}

    with open(out_path, "w") as f:
        json.dump(output, f, indent=2)

    upgraded = sum(
        1 for r in merged.values()
        if r.get("syntax_source") == "synthesized-from-source"
    )
    still_no_syntax = sum(1 for r in merged.values() if not r.get("syntax"))
    with_arg_types = sum(1 for r in merged.values() if r.get("arg_types") is not None)
    print(f"Merged {len(merged)} total built-in(s) -> {out_path}")
    print(f"  CLIPS version: {source_meta.get('clips_version')}")
    if source_meta.get("source_archive"):
        print(f"  Source archive SHA-256: {source_meta['source_archive']['sha256']}")
    print(f"  {upgraded} got a syntax line filled in from source")
    print(f"  {still_no_syntax} still have no syntax at all")
    print(f"  {with_arg_types} now carry structured arg_types")


if __name__ == "__main__":
    main()
