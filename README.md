# ATC Transcript Search

Static, password-gated, full-text search over ATC transcript NDJSON.

- **Search**: [MiniSearch](https://lucaong.github.io/minisearch/) with fuzzy + prefix matching
- **Facets**: airport / position / date, parsed from `global_key` filenames
- **Privacy**: AES-256-GCM with PBKDF2-SHA256 (600k iterations) — the data files
  on the public web are unreadable without the passphrase
- **Hosting**: GitHub Pages (free), built and deployed by GitHub Actions

## How privacy works

There is no server. The flow is:

1. **Build time** — `scripts/build.mjs` reads NDJSON, flattens rows, builds the
   MiniSearch index, then encrypts `data.json` and `index.json` with a key
   derived from your passphrase (PBKDF2 / 600k iters / SHA-256). It writes
   three files into `public/`:
   - `data.enc` — encrypted records
   - `index.enc` — encrypted MiniSearch index
   - `meta.json` — public: KDF salt + iterations + facet lists + counts
2. **Page load** — visitor sees a passphrase prompt. The browser derives the
   AES key from the passphrase (using the salt from `meta.json`), fetches the
   `.enc` blobs, and decrypts them in-memory using the WebCrypto API.
3. **Wrong passphrase** — AES-GCM authentication fails and the browser shows
   "wrong passphrase". No way to distinguish "wrong passphrase" from
   "tampered ciphertext" — both fail identically.

The passphrase is cached in `sessionStorage` for the tab's lifetime so reloads
don't re-prompt. Closing the tab clears it.

### What this protects against

- Search engines, scrapers, anyone who finds the URL but doesn't know the
  passphrase
- Casual snooping — the data is real ciphertext, not a `if (password === ...)`
  check
- Brute force, given a strong passphrase. 600k iterations means each guess
  takes ~half a second on a fast CPU.

### What it does not protect against

- Anyone you share the passphrase with leaking it. To "revoke" you re-encrypt
  with a new passphrase and redeploy.
- Weak passphrases. Use 12+ characters, mixed. A dictionary word will be
  cracked.
- The facet lists in `meta.json` are public (airport codes, position names,
  dates with counts). If those alone are sensitive, see "tightening" below.

## Setup

```bash
# 1. Install
npm install

# 2. Drop your NDJSON in the repo root
cp /path/to/your.ndjson input.ndjson

# 3. Build (passphrase via env var)
SEARCH_PASSWORD="your-strong-passphrase" npm run build

# 4. Preview
npx serve public
# → open http://localhost:3000
```

## Deploying

1. Push this repo to GitHub. **It can be a public repo** — only the encrypted
   blobs are deployed, and the source NDJSON is gitignored. (Private repo is
   fine too.)
2. **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `SEARCH_PASSWORD`
   - Value: your passphrase (12+ chars recommended)
3. **Settings → Pages → Source: GitHub Actions**
4. Push your `input.ndjson` and trigger the workflow.

To rotate the passphrase, change the secret and re-run the workflow.

## NDJSON source: Google Drive

The included workflow downloads `input.ndjson` from Google Drive at build
time, so the source data never goes into git. To set this up:

1. Upload `input.ndjson` to Drive
2. Right-click → Share → set to "Anyone with the link" (Viewer)
3. Copy the link, extract the file ID — the part between `/d/` and `/view`:
   `https://drive.google.com/file/d/THIS_PART_HERE/view?usp=sharing`
4. Add it to **Settings → Secrets and variables → Actions** as
   `GDRIVE_FILE_ID`

The workflow handles Drive's "scan for viruses" interstitial that triggers
on files over ~100 MB. If Drive ever changes that markup the build will fail
loudly with the first 200 bytes of what it actually got.

### Using a different host?

To use S3, R2, Dropbox, etc. instead, replace the "Fetch NDJSON from Google
Drive" step in `.github/workflows/deploy.yml` with a single curl line:

```yaml
- name: Fetch NDJSON
  run: curl -fsSL -o input.ndjson "$NDJSON_URL"
  env:
    NDJSON_URL: ${{ secrets.NDJSON_URL }}
```

…and add `NDJSON_URL` as a secret instead of `GDRIVE_FILE_ID`.

## Tunable knobs

The MiniSearch options live in two places and **must match**:

| Knob | In | Effect |
|------|-----|--------|
| `fuzzy: 0.2` | `scripts/build.mjs`, `index.html` | typo tolerance — `0.3` is more forgiving, `0.1` stricter |
| `prefix: true` | both | `"depart"` matches `"departure"` |
| `boost: { key: 2 }` | both | filename matches rank above transcript-only |
| `combineWith: 'AND'` | `index.html` | multi-word queries require all terms; `'OR'` is broader |
| `ITERATIONS = 600_000` | `build.mjs` | PBKDF2 cost. Higher = slower brute force *and* slower unlock. |

## Filename parsing

Filenames like `YPJT2-Center-Jan-25-2026-0100Z_25_VAD_v2.wav` get parsed into:
- `airport` → `YPJT2`
- `position` → `Center`
- `date` → `Jan-25-2026`
- `time` → `0100Z`

The regex is in `scripts/build.mjs` (`KEY_RE`). Adjust if your filename
convention differs. Files that don't match still work — they just don't
populate facets.

## Tightening (if you want to)

The default leaves `meta.json` (with facet lists and counts) on the public
web. To hide even that:

1. In `build.mjs`, move `facets` into the encrypted `data` blob and out of
   `meta.json`.
2. In `index.html`, populate the `<select>` dropdowns *after* decryption
   instead of from `meta.json`.

You'd lose the ability to show "X recordings · Y hours" on the lock screen,
but the lockscreen would reveal nothing about the corpus.

## File layout

```
.
├── .github/workflows/deploy.yml   # build + deploy to Pages
├── scripts/build.mjs              # NDJSON → encrypted blobs + meta
├── public/
│   ├── index.html                 # search UI + decryption
│   ├── data.enc                   # generated, encrypted
│   ├── index.enc                  # generated, encrypted
│   └── meta.json                  # generated, public
├── package.json
└── README.md
```
