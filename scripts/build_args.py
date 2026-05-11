#!/usr/bin/env python3
"""Collect NDJSON snapshots from ndjson/ and print build args for build.mjs.

Two sources are merged:
  1. ndjson/batch-{BATCH}-{DATE}.ndjson  — automated Labelbox exports
  2. ndjson/manifest.json                — manually uploaded files
       Format: { "pattern": "NicknameBatch", ... }
       Patterns can be exact filenames or globs, e.g.:
         "Export  project - 13_hours_earwave_*": "CoastalLatency"
         "202_hours_atc_AU_CH_IE_NL_*.ndjson": "LuckyTulip"

Snapshot date extraction (first match wins):
  1. Trailing M_D_YYYY before .ndjson  — pull date, unique per re-export
       e.g. "- 5_3_2026.ndjson" → 2026-05-03
  2. ISO timestamp YYYYMMDDTHHMMSSZ    — upload timestamp (same across re-exports)
       e.g. "20260427T204919Z" → 2026-04-27-20
"""
import fnmatch, glob, json, os, re, sys

def _extract_date(filename):
    # (N) re-download suffix, e.g. "foo (2).ndjson"
    nm = re.search(r' \((\d+)\)\.ndjson$', filename, re.IGNORECASE)
    dl_num = int(nm.group(1)) if nm else 0

    # Trailing pull-date like "- 5_3_2026.ndjson" or "- 5_3_2026 (1).ndjson"
    m = re.search(r'- (\d{1,2})_(\d{1,2})_(\d{4})(?:\s+\(\d+\))?\.ndjson$', filename, re.IGNORECASE)
    if m:
        base = f"{m.group(3)}-{int(m.group(1)):02d}-{int(m.group(2)):02d}"
        return f"{base}-{dl_num:03d}" if dl_num else base

    # ISO timestamp fallback (for files without a trailing pull-date)
    m = re.search(r'(\d{4})(\d{2})(\d{2})T(\d{2})\d{4}Z', filename)
    if m:
        base = f"{m.group(1)}-{m.group(2)}-{m.group(3)}-{m.group(4)}"
        return f"{base}-{dl_num:03d}" if dl_num else base

    return None

DIR = 'ndjson'
args = []
seen = set()

# --- automated exports: batch-{BATCH}-{DATE}.ndjson ---
for path in sorted(glob.glob(os.path.join(DIR, 'batch-*.ndjson'))):
    name  = os.path.basename(path).removesuffix('.ndjson')
    rest  = name.removeprefix('batch-')
    m     = re.search(r'\d{4}-\d{2}-\d{2}(?:-\d{2})?$', rest)
    date  = m.group(0) if m else None
    batch = rest[:-(len(date) + 1)] if date else rest
    args.append(f"{path}:{batch}:{date}" if date else f"{path}:{batch}")
    seen.add(os.path.basename(path))

# --- manifest entries: exact filenames or glob patterns ---
manifest_path = os.path.join(DIR, 'manifest.json')
if os.path.exists(manifest_path):
    with open(manifest_path, encoding='utf-8') as f:
        manifest = json.load(f)
    all_ndjson = sorted(f for f in os.listdir(DIR) if f.endswith('.ndjson'))
    for pattern, batch in manifest.items():
        matches = [f for f in all_ndjson if fnmatch.fnmatch(f, pattern) and f not in seen]
        if not matches and '*' not in pattern and '?' not in pattern:
            print(f"✗ manifest: '{pattern}' not found in {DIR}/", file=sys.stderr)
            sys.exit(1)
        for filename in matches:
            path = os.path.join(DIR, filename)
            date = _extract_date(filename)
            args.append(f"{path}:{batch}:{date}" if date else f"{path}:{batch}")
            seen.add(filename)

if not args:
    print(f"✗ No NDJSON files found in {DIR}/ — add files or check manifest.json", file=sys.stderr)
    sys.exit(1)

print('\n'.join(args))
