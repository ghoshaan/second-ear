#!/usr/bin/env python3
"""Export NDJSON from Labelbox projects into the ndjson/ snapshot store.

Reads env vars:
  LABELBOX_API_KEY   — Labelbox API key
  LABELBOX_PROJECTS  — comma-separated PROJECT_ID:BATCH_NAME[:YYYY-MM-DD[-HH]]
  NDJSON_DIR         — output directory (default: ndjson)
"""
import labelbox as lb
import json, os, sys
from datetime import datetime, timezone


def main():
    api_key  = os.environ.get('LABELBOX_API_KEY', '')
    spec     = os.environ.get('LABELBOX_PROJECTS', '')
    out_dir  = os.environ.get('NDJSON_DIR', 'ndjson')

    if not api_key:
        print('✗ LABELBOX_API_KEY is not set.', file=sys.stderr)
        sys.exit(1)
    if not spec:
        print('✗ LABELBOX_PROJECTS is not set.', file=sys.stderr)
        sys.exit(1)

    os.makedirs(out_dir, exist_ok=True)
    client = lb.Client(api_key=api_key)

    for raw in spec.split(','):
        entry = raw.strip()
        if not entry:
            continue
        parts = entry.split(':')
        if len(parts) < 2:
            print(f"✗ '{entry}': expected PROJECT_ID:BATCH_NAME[:YYYY-MM-DD[-HH]]", file=sys.stderr)
            sys.exit(1)
        project_id = parts[0]
        batch      = parts[1]
        date = parts[2] if len(parts) > 2 else datetime.now(timezone.utc).strftime('%Y-%m-%d-%H')

        outfile = os.path.join(out_dir, f"batch-{batch}-{date}.ndjson")

        if os.path.exists(outfile):
            print(f"→ {outfile} already exists, skipping re-export")
            continue

        print(f"→ Exporting '{batch}' from project {project_id}…")
        project = client.get_project(project_id)
        task = project.export_v2(params={
            'performance_details': True,
            'label_details': True,
        })
        task.wait_till_done(timeout_seconds=300)

        if task.errors:
            print(f"✗ Export errors: {task.errors}", file=sys.stderr)
            sys.exit(1)

        count = 0
        with open(outfile, 'w', encoding='utf-8') as f:
            for row in task.get_buffered_stream():
                line = getattr(row, 'json_str', None) or json.dumps(row.json)
                f.write(line.rstrip('\n') + '\n')
                count += 1

        size = os.path.getsize(outfile)
        if size < 100:
            print(f"✗ {outfile}: too small ({size} bytes) — export may have failed", file=sys.stderr)
            sys.exit(1)

        with open(outfile, encoding='utf-8') as check:
            first = check.readline().strip()
        if first.startswith('<'):
            print(f"✗ {outfile}: looks like HTML, not NDJSON:\n  {first[:120]}", file=sys.stderr)
            sys.exit(1)
        try:
            json.loads(first)
        except json.JSONDecodeError as e:
            print(f"✗ {outfile}: first line is not valid JSON: {e}", file=sys.stderr)
            sys.exit(1)

        print(f"✓ {outfile}: {count} rows · {size:,} bytes")


if __name__ == '__main__':
    main()
