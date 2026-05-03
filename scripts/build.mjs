#!/usr/bin/env node
// Build script: reads NDJSON, flattens each row, dedupes transcripts,
// parses facets out of global_key, builds a MiniSearch index, and writes
// AES-GCM-encrypted blobs to public/.
//
// Usage:  node scripts/build.mjs path/to/your.ndjson
// Default input: ./input.ndjson
// Password:      env var SEARCH_PASSWORD (required)

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';
import MiniSearch from 'minisearch';

const INPUT = process.argv[2] || 'input.ndjson';
const OUT_DIR = 'public';
const DATA_PATH = path.join(OUT_DIR, 'data.enc');
const INDEX_PATH = path.join(OUT_DIR, 'index.enc');
const META_PATH = path.join(OUT_DIR, 'meta.json'); // public; carries facet lists & KDF params

const PASSWORD = process.env.SEARCH_PASSWORD;
if (!PASSWORD) {
  console.error('✗ SEARCH_PASSWORD env var is required.');
  console.error('  Local:   SEARCH_PASSWORD="your-password" npm run build');
  console.error('  CI:      set SEARCH_PASSWORD as a repo secret (see README).');
  process.exit(1);
}
if (PASSWORD.length < 8) {
  console.error('✗ Password must be at least 8 characters. 12+ recommended.');
  process.exit(1);
}

if (!fs.existsSync(INPUT)) {
  console.error(`✗ Input file not found: ${INPUT}`);
  process.exit(1);
}
fs.mkdirSync(OUT_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Global key parsing
// ---------------------------------------------------------------------------
//
// Filenames look like:  YPJT2-Center-Jan-25-2026-0100Z_25_VAD_v2.wav
//                       \___/ \____/ \__________/ \__/
//                       airport position    date     time
//
// We parse defensively: anything that doesn't match the pattern still works,
// it just gets fewer facet values populated.

const KEY_RE = /^([A-Z0-9]+)-([A-Za-z]+)-([A-Za-z]+-\d+-\d+)-(\d+Z)_/;

function parseKey(key) {
  if (!key) return {};
  const m = key.match(KEY_RE);
  if (!m) return { airport: null, position: null, date: null, time: null };
  return { airport: m[1], position: m[2], date: m[3], time: m[4] };
}

// ---------------------------------------------------------------------------
// Row flattening
// ---------------------------------------------------------------------------

function flatten(row) {
  const id = row?.data_row?.id;
  const key = row?.data_row?.global_key;
  const duration = row?.media_attributes?.duration ?? null;

  const projects = row?.projects ?? {};
  const firstProject = Object.values(projects)[0];
  const label = firstProject?.labels?.[0];

  const facets = parseKey(key);

  if (!label) {
    return { id, key, duration, ...facets, speakers: 0, roles: [], segments: [], transcript: '' };
  }

  // Build "Speaker 1" -> "pilot" map from top-level classifications.
  const speakerRoles = {};
  const topClassifications = label?.annotations?.classifications ?? [];
  for (const c of topClassifications) {
    if (c?.value === 'how_many_speakers_are_there') {
      const inner = c?.radio_answer?.classifications ?? [];
      for (const sub of inner) {
        const m = sub?.value?.match(/speaker_(\d+)$/);
        if (!m) continue;
        const speakerLabel = `Speaker ${m[1]}`;
        const role = sub?.radio_answer?.value ?? sub?.radio_answer?.name ?? 'unknown';
        speakerRoles[speakerLabel] = String(role).toLowerCase();
      }
    }
  }

  const segmentsBlock = label?.annotations?.segments ?? {};
  const timestampBlock = label?.annotations?.timestamp ?? {};

  // feature_id -> "Speaker N", scraped from any timestamp entry.
  const featureToSpeaker = {};
  for (const tsEntry of Object.values(timestampBlock)) {
    for (const cls of tsEntry?.classifications ?? []) {
      const fid = cls?.feature_id;
      const sp = cls?.name;
      if (fid && sp && !featureToSpeaker[fid]) featureToSpeaker[fid] = sp;
    }
  }

  // feature_id -> { startMs -> text }
  const featureTextByStart = {};
  for (const [tsKey, tsEntry] of Object.entries(timestampBlock)) {
    const startMs = Number(tsKey);
    for (const cls of tsEntry?.classifications ?? []) {
      const fid = cls?.feature_id;
      const text = cls?.text_answer?.content;
      if (!fid || text == null) continue;
      featureTextByStart[fid] ??= {};
      if (featureTextByStart[fid][startMs] == null) {
        featureTextByStart[fid][startMs] = text;
      }
    }
  }

  // Assemble segments.
  const segments = [];
  for (const [fid, ranges] of Object.entries(segmentsBlock)) {
    const speakerLabel = featureToSpeaker[fid] ?? 'Speaker ?';
    const role = speakerRoles[speakerLabel] ?? 'unknown';
    for (const [start, end] of ranges) {
      const texts = featureTextByStart[fid] ?? {};
      let text = texts[start] ?? texts[end];
      if (text == null) {
        const uniq = [...new Set(Object.values(texts))];
        text = uniq[0] ?? '';
      }
      segments.push({ role, start, end, text: String(text).trim() });
    }
  }
  segments.sort((a, b) => a.start - b.start);

  const dedupedSegments = [];
  for (const s of segments) {
    const prev = dedupedSegments[dedupedSegments.length - 1];
    if (prev && prev.text === s.text && prev.role === s.role) continue;
    dedupedSegments.push(s);
  }

  const transcript = dedupedSegments.map(s => s.text).filter(Boolean).join(' \u2022 ');

  const roles = Object.keys(speakerRoles).sort().map(k => speakerRoles[k]);

  return {
    id,
    key,
    duration,
    ...facets,
    speakers: roles.length,
    roles,
    segments: dedupedSegments,
    transcript,
  };
}

// ---------------------------------------------------------------------------
// Stream NDJSON
// ---------------------------------------------------------------------------
const rows = [];
let lineNum = 0;
let skipped = 0;

console.log(`→ Reading ${INPUT}`);
const rl = readline.createInterface({
  input: fs.createReadStream(INPUT, { encoding: 'utf8' }),
  crlfDelay: Infinity,
});

for await (const line of rl) {
  lineNum++;
  const trimmed = line.trim();
  if (!trimmed) continue;
  try {
    const flat = flatten(JSON.parse(trimmed));
    if (!flat.transcript) { skipped++; continue; }
    rows.push(flat);
  } catch (e) {
    console.warn(`  ! line ${lineNum} parse error: ${e.message}`);
    skipped++;
  }
  if (lineNum % 1000 === 0) process.stdout.write(`  ${lineNum} lines\r`);
}
console.log(`✓ Parsed ${lineNum} lines, kept ${rows.length}, skipped ${skipped}`);

// ---------------------------------------------------------------------------
// Collect facets (sorted, with counts)
// ---------------------------------------------------------------------------
function collectFacet(field) {
  const counts = new Map();
  for (const r of rows) {
    const v = r[field];
    if (v == null) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([value, count]) => ({ value, count }));
}

const facets = {
  airport: collectFacet('airport'),
  position: collectFacet('position'),
  date: collectFacet('date'),
};

// ---------------------------------------------------------------------------
// MiniSearch index
// ---------------------------------------------------------------------------
const ms = new MiniSearch({
  fields: ['transcript', 'key'],
  storeFields: ['key', 'duration', 'speakers', 'roles', 'segments', 'transcript',
                'airport', 'position', 'date', 'time'],
  searchOptions: {
    boost: { key: 2 },
    fuzzy: 0.2,
    prefix: true,
  },
  tokenize: (text) => text.split(/[\s,.;:!?()[\]{}"<>|/\\-]+/).filter(Boolean),
});

console.log(`→ Building MiniSearch index (${rows.length} docs)`);
ms.addAll(rows);

// ---------------------------------------------------------------------------
// Encrypt and write
// ---------------------------------------------------------------------------
//
// Crypto: PBKDF2-SHA256 (600k iterations, OWASP 2023 minimum) -> 256-bit key
//         -> AES-256-GCM with random 12-byte IV per blob.
// Salt is shared across blobs (committed in meta.json), so the password only
// derives the key once on the client.

const ITERATIONS = 600_000;
const SALT = crypto.randomBytes(16);

function deriveKey(password, salt) {
  return crypto.pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256');
}

function encrypt(plaintextBuffer, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintextBuffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Output format: [12-byte IV][16-byte tag][ciphertext]
  return Buffer.concat([iv, tag, enc]);
}

console.log(`→ Deriving key (PBKDF2, ${ITERATIONS.toLocaleString()} iterations)`);
const key = deriveKey(PASSWORD, SALT);

const dataBuf = Buffer.from(JSON.stringify(rows));
const indexBuf = Buffer.from(JSON.stringify(ms.toJSON()));

console.log(`→ Encrypting blobs (AES-256-GCM)`);
fs.writeFileSync(DATA_PATH, encrypt(dataBuf, key));
fs.writeFileSync(INDEX_PATH, encrypt(indexBuf, key));

// Public meta — KDF params + facet lists. Facet values aren't sensitive on
// their own (they're airport codes, sector names, dates) and we need them to
// populate dropdowns BEFORE the user enters the password. If you consider
// even the facet list sensitive, move this into the encrypted blob.
const meta = {
  version: 1,
  kdf: {
    name: 'PBKDF2',
    hash: 'SHA-256',
    iterations: ITERATIONS,
    salt: SALT.toString('base64'),
  },
  cipher: 'AES-256-GCM',
  count: rows.length,
  totalSeconds: rows.reduce((a, r) => a + (r.duration || 0), 0),
  facets,
};
fs.writeFileSync(META_PATH, JSON.stringify(meta));

const dataKB = (fs.statSync(DATA_PATH).size / 1024).toFixed(0);
const indexKB = (fs.statSync(INDEX_PATH).size / 1024).toFixed(0);
console.log(`✓ Wrote ${DATA_PATH} (${dataKB} KB)`);
console.log(`✓ Wrote ${INDEX_PATH} (${indexKB} KB)`);
console.log(`✓ Wrote ${META_PATH}`);
console.log(`  Password set. Anyone with the URL but not the password sees only ciphertext.`);
