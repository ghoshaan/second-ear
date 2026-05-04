# ATC Transcript Search

Static, password-gated, full-text search over ATC transcript NDJSON.

- **Search**: [MiniSearch](https://lucaong.github.io/minisearch/) with fuzzy + prefix matching
- **Filters**: role, review status, edit history, batch, airport, position, date, annotator
- **Privacy**: AES-256-GCM with PBKDF2-SHA256 (600k iterations)
- **Hosting**: GitHub Pages, deployed by GitHub Actions

---

## Data sources

Pulls data directly from Labelbox on a schedule.
#### Secrets

| Secret | Value |
|---|---|
| `LABELBOX_API_KEY` | Labelbox API token — Account → API Keys |
| `LABELBOX_PROJECTS` | Comma-separated project entries (see format below) |
| `SEARCH_PASSWORD` | Search passphrase |

#### `LABELBOX_PROJECTS` format

```
PROJECT_ID:BATCH_NAME, PROJECT_ID:BATCH_NAME, ...
```

- **PROJECT_ID** — from the Labelbox URL: `app.labelbox.com/projects/<PROJECT_ID>/...`
- **BATCH_NAME** — short label shown in the UI (e.g. AdequateLasagna)


#### How it works

1. `scripts/lb_export.py` exports each project via Labelbox Export v2
2. `performance_details: true` is set — required so `workflow_history` (review status) is included
3. Polls until the export is complete (up to 5 minutes per project)
4. Writes NDJSON to `batch-{BATCH}-{DATE}.ndjson` and feeds it to `npm run build`

#### Adding a new batch

1. Copy the project ID from `app.labelbox.com/projects/<PROJECT_ID>/...`
2. Append to `LABELBOX_PROJECTS`: `..., NEW_PROJECT_ID:NewBatchName`
3. Push or run the workflow manually

#### Automated schedule

The workflow runs **every hour** (`0 * * * *` UTC). Scheduled runs are skipped automatically if `LABELBOX_PROJECTS` is not set.

To change the frequency, edit the `cron` line in `.github/workflows/deploy.yml`.


## Local development

```bash
npm ci
pip install labelbox   # only needed for lb_export.py / lb_verify.py

# Verify Labelbox key
LABELBOX_API_KEY=<key> python3 scripts/lb_verify.py

# Build from existing snapshots in ndjson/
SEARCH_PASSWORD="..." bash scripts/build.sh

# Preview
npx serve public
```

---

## How privacy works

There is no server. The flow is:

1. **Build time** — `scripts/build.mjs` reads NDJSONs, flattens rows, builds the MiniSearch index, then encrypts `data.json` and `index.json` with a key derived from your passphrase (PBKDF2 / 600k iters / SHA-256). It writes three files into `public/`:
   - `data.enc` — encrypted records
   - `index.enc` — encrypted MiniSearch index
   - `meta.json` — public: KDF salt + iterations + facet lists + counts
2. **Page load** — visitor sees a passphrase prompt. The browser derives the AES key, fetches the `.enc` blobs, decrypts them in-memory using WebCrypto.
3. **Wrong passphrase** — AES-GCM authentication fails and the page shows "wrong passphrase".

The passphrase is cached in `sessionStorage` for the tab, so reloads don't re-prompt. The "lock" button or closing the tab clears it.

### What this protects against

- Search engines, scrapers, anyone without the passphrase
- Casual snooping — real ciphertext, not a `if (password === ...)` check
- Brute force, given a strong passphrase (~0.5s per guess on a fast CPU)

### What it does not protect against

- Passphrase leaks. To rotate, change the GitHub secret + re-run the workflow.
- Weak passphrases.
- The facet lists in `meta.json` are public (airport codes, batch names, annotator IDs). If those are sensitive, move `facets` into the encrypted blob and populate the filter UI after decryption.

---

## Filename parsing

Filenames like `YPJT2-Center-Jan-25-2026-0100Z_25_VAD_v2.wav` are parsed into:

| Field | Example |
|---|---|
| `airport` | `YPJT2` |
| `position` | `Center` |
| `date` | `Jan-25-2026` |
| `time` | `0100Z` |

The regex is `KEY_RE` in `scripts/build.mjs`. Adjust if your filename convention differs.

## Annotator parsing

`label.label_details.created_by` looks like:
`usr.email.cmnpwy74k0xdt07080m2ca04e@internal.labelbox.com`

The segment between `usr.email.` and `@` is extracted as the `annotator` field. Regex is `ANNOTATOR_RE` in the build script.

---

## Tunable knobs

| Knob | Location | Effect |
|---|---|---|
| `fuzzy: 0.2` | `build.mjs` + `index.html` | Typo tolerance — higher = more forgiving |
| `prefix: true` | `build.mjs` + `index.html` | "depart" matches "departure" |
| `boost: { key: 2 }` | `build.mjs` + `index.html` | Filename matches rank above transcript-only |
| `combineWith: 'AND'` | `index.html` | Multi-word queries require all terms |
| `ITERATIONS = 600_000` | `build.mjs` | PBKDF2 cost — higher = slower brute force and slower unlock |

The MiniSearch options in `build.mjs` and `index.html` **must match**.

---

## File layout

```
.
├── .github/workflows/deploy.yml   # build + deploy pipeline
├── scripts/
│   ├── build.mjs                  # index builder + encryptor
│   └── lb_export.py               # Labelbox API exporter
├── public/
│   ├── index.html                 # search UI
│   ├── data.enc                   (generated, encrypted)
│   ├── index.enc                  (generated, encrypted)
│   └── meta.json                  (generated, public)
├── package.json
└── README.md
```
