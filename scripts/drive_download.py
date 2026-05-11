#!/usr/bin/env python3
"""Download Google Drive files by ID into a target directory.

Reads DRIVE_NDJSON_IDS (comma-separated) from the environment. For each
ID, follows the standard "anyone with the link" download flow, including
the virus-scan interstitial that Drive shows for files larger than ~25
MB. The original Drive filename is preserved via Content-Disposition so
existing manifest.json glob patterns still match.

Uses a local .drive_cache.json to skip network requests entirely for
files already present in the cache.

Stdlib-only — no third-party deps to install on the runner.
"""
import http.cookiejar
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser

UA = "Mozilla/5.0 (compatible; ATCSearchBot/1.0)"
DOWNLOAD_URL = "https://docs.google.com/uc?export=download"
USERCONTENT_URL = "https://drive.usercontent.google.com/download"
CACHE_FILE = ".drive_cache.json"


class FormFieldParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.fields = {}
        self.action = None

    def handle_starttag(self, tag, attrs):
        d = dict(attrs)
        if tag == "form" and d.get("action"):
            self.action = d["action"]
        elif tag == "input":
            name, value = d.get("name"), d.get("value")
            if name and value is not None:
                self.fields[name] = value


def parse_filename(content_disposition):
    if not content_disposition:
        return None
    m = re.search(r"filename\*=UTF-8''([^;]+)", content_disposition)
    if m:
        return urllib.parse.unquote(m.group(1).strip().strip('"'))
    m = re.search(r'filename="([^"]+)"', content_disposition)
    if m:
        return m.group(1).strip()
    return None


def save_response(response, path):
    print(f"  → writing to {path}")
    with open(path, "wb") as f:
        while True:
            chunk = response.read(64 * 1024)
            if not chunk:
                break
            f.write(chunk)
    size = os.path.getsize(path)
    print(f"  ✓ {size:,} bytes")
    if size < 1024:
        with open(path, "rb") as f:
            head = f.read(512)
        if b"<html" in head.lower() or b"<!doctype" in head.lower():
            raise RuntimeError(f"got HTML instead of file (size={size}); auth/permission probably wrong")


def _try_download(opener, url, file_id, dest_dir, cache):
    print(f"  · GET {url}")
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with opener.open(req) as r:
        ctype = r.headers.get("Content-Type", "")
        cd = r.headers.get("Content-Disposition", "")
        
        # If we got a filename from CD, check if it already exists to skip
        fname = parse_filename(cd)
        if fname:
            cache[file_id] = fname # Update cache with name found from headers
            if os.path.exists(os.path.join(dest_dir, fname)) and os.path.getsize(os.path.join(dest_dir, fname)) > 0:
                print(f"  ✓ {fname} already exists, skipping")
                return True

        if "text/html" in ctype:
            html = r.read().decode("utf-8", errors="ignore")
            parser = FormFieldParser()
            parser.feed(html)
            if not parser.fields:
                return False
            params = dict(parser.fields)
            params.setdefault("id", file_id)
            params.setdefault("export", "download")
            params.setdefault("confirm", "t")
            target = parser.action or USERCONTENT_URL
            full_url = target if target.startswith("http") else USERCONTENT_URL
            full_url = f"{full_url}?{urllib.parse.urlencode(params)}"
            print(f"  · GET {full_url}")
            req2 = urllib.request.Request(full_url, headers={"User-Agent": UA})
            with opener.open(req2) as r2:
                cd2 = r2.headers.get("Content-Disposition", "")
                fname = parse_filename(cd2) or f"drive_{file_id}.ndjson"
                cache[file_id] = fname
                if os.path.exists(os.path.join(dest_dir, fname)) and os.path.getsize(os.path.join(dest_dir, fname)) > 0:
                    print(f"  ✓ {fname} already exists, skipping")
                    return True
                save_response(r2, os.path.join(dest_dir, fname))
        else:
            fname = fname or f"drive_{file_id}.ndjson"
            cache[file_id] = fname
            save_response(r, os.path.join(dest_dir, fname))
        return True


def download(file_id, dest_dir, cache):
    # FIRST: Check local cache to see if we already know the filename for this ID
    if file_id in cache:
        fname = cache[file_id]
        if os.path.exists(os.path.join(dest_dir, fname)) and os.path.getsize(os.path.join(dest_dir, fname)) > 0:
            print(f"  ✓ {fname} found in local cache, skipping network")
            return

    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    quoted = urllib.parse.quote(file_id)
    candidate_urls = [
        f"{DOWNLOAD_URL}&id={quoted}&confirm=t",
        f"{USERCONTENT_URL}?id={quoted}&export=download&confirm=t",
    ]
    last_err = None
    for url in candidate_urls:
        try:
            if _try_download(opener, url, file_id, dest_dir, cache):
                return
        except urllib.error.HTTPError as e:
            print(f"  · HTTP {e.code} {e.reason}")
            last_err = e
    raise RuntimeError(f"all endpoints failed for id={file_id} (last error: {last_err}). "
                       f"Verify in incognito: https://drive.google.com/file/d/{file_id}/view")


def main():
    ids_str = os.environ.get("DRIVE_NDJSON_IDS", "")
    dest = sys.argv[1] if len(sys.argv) > 1 else "ndjson"
    os.makedirs(dest, exist_ok=True)
    
    # Load the ID -> Filename cache
    cache_path = os.path.join(dest, CACHE_FILE)
    cache = {}
    if os.path.exists(cache_path):
        try:
            with open(cache_path, "r") as f:
                cache = json.load(f)
        except:
            pass

    ids = [s.strip() for s in ids_str.split(",") if s.strip()]
    if not ids:
        print("→ DRIVE_NDJSON_IDS empty — nothing to download")
        return 0
    failures = 0
    for fid in ids:
        print(f"→ Processing Drive ID: {fid}")
        try:
            download(fid, dest, cache)
        except Exception as e:
            print(f"  ✗ failed: {e}", file=sys.stderr)
            failures += 1
            
    # Save the updated cache
    with open(cache_path, "w") as f:
        json.dump(cache, f, indent=2)
        
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
