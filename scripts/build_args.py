#!/usr/bin/env python3
"""Collect NDJSON snapshots from ndjson/ and print build args for build.mjs.

Two sources are merged:
  1. ndjson/batch-{BATCH}-{DATE}.ndjson  — automated Labelbox exports
  2. ndjson/manifest.json                — manually uploaded files
       Format: { "pattern": "NicknameBatch", ... }
       Patterns can be exact filenames or globs, e.g.:
         "202_hours_atc_AU_CH_IE_NL_*.ndjson": "LuckyTulip"
       Date is auto-extracted from any ISO timestamp in the filename
       (e.g. 20260427T204919Z → 2026-04-27-20).
       When the same export is re-downloaded, the OS appends " (1)", " (2)"
       etc. before the extension. The download number is appended to the date
       (e.g. 2026-04-27-20-1) so snapshots sort in the correct order for
       version history without discarding any files.
"""
import fnmatch, glob, json, os, re, sys

_NUMBERED_RE = re.compile(r'^(.*?) \((\d+)\)(\.ndjson)$', re.IGNORECASE)

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
            nm = _NUMBERED_RE.match(filename)
            dl_num = int(nm.group(2)) if nm else 0
            # Extract ISO timestamp from the base name (strip " (N)" before searching)
            base_name = nm.group(1) + nm.group(3) if nm else filename
            m = re.search(r'(\d{4})(\d{2})(\d{2})T(\d{2})\d{4}Z', base_name)
            date = f"{m.group(1)}-{m.group(2)}-{m.group(3)}-{m.group(4)}" if m else None
            if date and dl_num:
                date = f"{date}-{dl_num}"
            args.append(f"{path}:{batch}:{date}" if date else f"{path}:{batch}")
            seen.add(filename)

if not args:
    print(f"✗ No NDJSON files found in {DIR}/ — add files or check manifest.json", file=sys.stderr)
    sys.exit(1)

print(' '.join(args))
