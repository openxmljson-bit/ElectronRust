#!/usr/bin/env python3
"""Generate sample JSON / NDJSON / CSV / XML files for testing NARIKJSON.

Usage:
    python3 scripts/generate_samples.py [--rows 100000] [--out samples/]

--rows controls record count; ~1M rows produces roughly 250 MB of JSON.
"""
import argparse
import json
import os
import random
import string

WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"]


def rand_str(n=12):
    return "".join(random.choices(string.ascii_letters + string.digits, k=n))


def record(i):
    return {
        "id": i,
        "uuid": rand_str(24),
        "name": random.choice(WORDS) + "-" + rand_str(6),
        "active": random.random() > 0.5,
        "score": round(random.uniform(0, 1000), 3),
        "zip": f"{random.randint(0, 99999):05d}",
        "tags": random.sample(WORDS, 3),
        "nested": {
            "level1": {"level2": {"value": random.randint(0, 1_000_000)}},
            "notes": None,
            "unicode": "héllo wörld ✓ éè",
        },
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rows", type=int, default=100_000)
    ap.add_argument("--out", default="samples")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    random.seed(42)

    # JSON (single big array)
    p = os.path.join(args.out, "sample.json")
    with open(p, "w") as f:
        f.write('{"generated_by":"NARIKJSON sample","items":[\n')
        for i in range(args.rows):
            f.write(json.dumps(record(i)))
            f.write(",\n" if i + 1 < args.rows else "\n")
        f.write("]}\n")
    print(p, os.path.getsize(p), "bytes")

    # NDJSON
    p = os.path.join(args.out, "sample.ndjson")
    with open(p, "w") as f:
        for i in range(args.rows):
            f.write(json.dumps(record(i)) + "\n")
    print(p, os.path.getsize(p), "bytes")

    # CSV (quoted fields, embedded commas/quotes, leading zeros)
    p = os.path.join(args.out, "sample.csv")
    with open(p, "w") as f:
        f.write("id,name,zip,description,score\n")
        for i in range(args.rows):
            f.write(
                f'{i},"{random.choice(WORDS)}, {rand_str(5)}","{random.randint(0,99999):05d}",'
                f'"He said ""hi"" once",{round(random.uniform(0,100),2)}\n'
            )
    print(p, os.path.getsize(p), "bytes")

    # XML
    p = os.path.join(args.out, "sample.xml")
    with open(p, "w") as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\n')
        f.write("<!-- generated sample -->\n<catalog>\n")
        for i in range(args.rows):
            w = random.choice(WORDS)
            f.write(
                f'  <item id="{i}" cls="{w}">'
                f"<name>{w}-{rand_str(5)}</name>"
                f"<score>{round(random.uniform(0, 10), 2)}</score>"
                f"<desc>a &amp; b &lt;tag&gt; text</desc>"
                f"<![CDATA[raw <cdata> content {i}]]>"
                f"</item>\n"
            )
        f.write("</catalog>\n")
    print(p, os.path.getsize(p), "bytes")


if __name__ == "__main__":
    main()
