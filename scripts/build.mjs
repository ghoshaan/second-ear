#!/usr/bin/env node
// Build script: reads one or more NDJSONs, flattens each row, dedupes
// transcripts, parses facets out of global_key + annotator from
// label.label_details.created_by, builds a MiniSearch index, encrypts
// outputs.
//
// Usage:
//   node scripts/build.mjs FILE[:BATCH] [FILE[:BATCH] ...]
//
//   FILE  — path to NDJSON
//   BATCH — optional name for this batch. Defaults to the filename
//           minus extension (e.g. "input.ndjson" -> "input").
//
// Examples:
//   node scripts/build.mjs input.ndjson
//   node scripts/build.mjs jan.ndjson:january feb.ndjson:february
//
// Password env var SEARCH_PASSWORD is required.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';
import MiniSearch from 'minisearch';

// ---------------------------------------------------------------------------
// Args & env
// ---------------------------------------------------------------------------
const inputs = process.argv.slice(2);
if (inputs.length === 0) inputs.push('input.ndjson'); // default

const PASSWORD = process.env.SEARCH_PASSWORD;
if (!PASSWORD) {
  console.error('✗ SEARCH_PASSWORD env var is required.');
  process.exit(1);
}
if (PASSWORD.length < 8) {
  console.error('✗ Password must be at least 8 characters. 12+ recommended.');
  process.exit(1);
}

const OUT_DIR = 'public';
const DATA_PATH = path.join(OUT_DIR, 'data.enc');
const INDEX_PATH = path.join(OUT_DIR, 'index.enc');
const META_PATH = path.join(OUT_DIR, 'meta.json');
fs.mkdirSync(OUT_DIR, { recursive: true });

const DATE_RE = /^\d{4}-\d{2}-\d{2}(-\d{2})?$/; // YYYY-MM-DD or YYYY-MM-DD-HH
const jobs = inputs.map(spec => {
  // Spec formats: "FILE", "FILE:BATCH", or "FILE:BATCH:YYYY-MM-DD".
  // Windows paths have "C:" — handle by checking if the trailing piece
  // looks like a batch/date rather than a path fragment.
  //
  // Strategy: split on all colons, then peel off date and batch from
  // the right if they look right.
  const parts = spec.split(':');
  let snapshotDate = null;
  let batch = null;
  let file = spec;

  if (parts.length >= 2) {
    const last = parts[parts.length - 1];
    if (DATE_RE.test(last)) {
      // Last piece is a date. Second-to-last is batch.
      snapshotDate = last;
      if (parts.length >= 3) {
        batch = parts[parts.length - 2];
        file = parts.slice(0, -2).join(':');
      }
    } else if (!last.includes('/') && !last.includes('\\') && !last.includes('.')) {
      // Last piece looks like a batch name (no slashes, no dots).
      batch = last;
      file = parts.slice(0, -1).join(':');
    }
  }

  // Default batch = basename without extension.
  if (!batch) batch = path.basename(file).replace(/\.ndjson$/i, '');

  return { file, batch, snapshotDate };
});
for (const job of jobs) {
  if (!fs.existsSync(job.file)) {
    console.error(`✗ Input not found: ${job.file}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

// Filename: YPJT2-Center-Jan-25-2026-0100Z_25_VAD_v2.wav
const KEY_RE = /^([A-Z0-9]+)-([A-Za-z]+)-([A-Za-z]+-\d+-\d+)-(\d+Z)_/;
function parseKey(key) {
  if (!key) return {};
  const m = key.match(KEY_RE);
  if (!m) return { airport: null, position: null, date: null, time: null };
  return { airport: m[1], position: m[2], date: m[3], time: m[4] };
}

// created_by: "usr.email.cmnpwy74k0xdt07080m2ca04e@internal.labelbox.com"
//                       \________________________/
//                                annotator id
const ANNOTATOR_RE = /^usr\.email\.([^@]+)@/;
function parseAnnotator(createdBy) {
  if (!createdBy) return null;
  const m = String(createdBy).match(ANNOTATOR_RE);
  return m ? m[1] : String(createdBy); // fallback: use whole string
}
// workflow_history: array of {action, created_at, created_by, ...}.
// A row is "reviewed" if it has at least one Approve action.
// We grab the most recent Approve and pull reviewer + timestamp.
function parseReview(workflowHistory) {
  if (!Array.isArray(workflowHistory)) {
    return { reviewed: false, reviewedBy: null, reviewedAt: null };
  }
  const approvals = workflowHistory
    .filter(e => e?.action === 'Approve')
    .sort((a, b) => String(b?.created_at).localeCompare(String(a?.created_at)));
  if (approvals.length === 0) {
    return { reviewed: false, reviewedBy: null, reviewedAt: null };
  }
  const latest = approvals[0];
  return {
    reviewed: true,
    reviewedBy: parseAnnotator(latest.created_by) ?? latest.created_by ?? null,
    reviewedAt: latest.created_at ?? null,
  };
}
// ---------------------------------------------------------------------------
// Row flattening
// ---------------------------------------------------------------------------

function flatten(row, batchName, snapshotDate) {
  const id = row?.data_row?.id;
  const key = row?.data_row?.global_key;
  const duration = row?.media_attributes?.duration ?? null;

  const projects = row?.projects ?? {};
  const projectEntries = Object.entries(projects);
  const projectId = projectEntries[0]?.[0] ?? null;
  const firstProject = projectEntries[0]?.[1];
  const label = firstProject?.labels?.[0];
  const review = parseReview(firstProject?.project_details?.workflow_history);
  const facets = parseKey(key);
  const annotator = parseAnnotator(label?.label_details?.created_by);

  if (!label) {
    return {
      id, key, duration, projectId, ...facets,
      batch: batchName, snapshotDate, annotator, ...review,
      speakers: 0, roles: [], segments: [], transcript: '',
    };
  }

  // "Speaker 1" -> "pilot"
  const speakerRoles = {};
  for (const c of label?.annotations?.classifications ?? []) {
    if (c?.value === 'how_many_speakers_are_there') {
      for (const sub of c?.radio_answer?.classifications ?? []) {
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

  const featureToSpeaker = {};
  for (const tsEntry of Object.values(timestampBlock)) {
    for (const cls of tsEntry?.classifications ?? []) {
      const fid = cls?.feature_id;
      const sp = cls?.name;
      if (fid && sp && !featureToSpeaker[fid]) featureToSpeaker[fid] = sp;
    }
  }

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
    id, key, duration, projectId, ...facets,
    batch: batchName, snapshotDate, annotator, ...review,
    speakers: roles.length,
    roles, segments: dedupedSegments, transcript,
  };
}

// ---------------------------------------------------------------------------
// Stream all input files
// ---------------------------------------------------------------------------
const allOccurrences = []; // all transcripted rows, including cross-batch duplicates
let totalLines = 0;
let totalSkipped = 0;

for (const job of jobs) {
  console.log(`→ Reading ${job.file}  (batch="${job.batch}"${job.snapshotDate ? `, date=${job.snapshotDate}` : ''})`);
  let lineNum = 0;
  let kept = 0;
  let skipped = 0;

  const rl = readline.createInterface({
    input: fs.createReadStream(job.file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    lineNum++;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const flat = flatten(JSON.parse(trimmed), job.batch, job.snapshotDate);
      if (!flat.transcript) { skipped++; continue; }
      allOccurrences.push(flat);
      kept++;
    } catch (e) {
      console.warn(`  ! line ${lineNum} parse error: ${e.message}`);
      skipped++;
    }
    if (lineNum % 1000 === 0) process.stdout.write(`  ${lineNum} lines\r`);
  }
  console.log(`  ${lineNum} lines · kept ${kept} · skipped ${skipped}`);
  totalLines += lineNum; totalSkipped += skipped;
}
console.log(`→ Total: ${totalLines} lines read, ${allOccurrences.length} occurrences, ${totalSkipped} skipped`);

// ---------------------------------------------------------------------------
// Group occurrences by id, build version history per row
// ---------------------------------------------------------------------------
const rows = [];
const grouped = new Map();

for (const occ of allOccurrences) {
  if (!occ.id) { rows.push({ ...occ, drId: null, versions: [] }); continue; }
  if (!grouped.has(occ.id)) grouped.set(occ.id, []);
  grouped.get(occ.id).push(occ);
}

for (const occurrences of grouped.values()) {
  // Sort chronologically so we can walk the transition sequence
  occurrences.sort((a, b) => String(a.snapshotDate ?? '').localeCompare(String(b.snapshotDate ?? '')));

  const primary = occurrences[occurrences.length - 1];
  const versions = [];
  let prevStateKey = null;
  let prevContentKey = null;

  // Walk every snapshot EXCEPT the last (which becomes the primary)
  for (let i = 0; i < occurrences.length - 1; i++) {
    const occ = occurrences[i];
    const stateKey = JSON.stringify([occ.reviewed, occ.reviewedBy, occ.annotator]);
    const contentKey = occ.transcript;

    if (prevStateKey === null) {
      versions.push({ snapshotDate: occ.snapshotDate, reviewed: occ.reviewed, reviewedBy: occ.reviewedBy, reviewedAt: occ.reviewedAt, annotator: occ.annotator, transcript: occ.transcript, segments: occ.segments, changeType: 'initial' });
    } else {
      const sc = stateKey !== prevStateKey;
      const cc = contentKey !== prevContentKey;
      if (sc || cc) {
        const changeType = sc && cc ? 'state-and-content' : sc ? 'state-only' : 'content-only';
        versions.push({ snapshotDate: occ.snapshotDate, reviewed: occ.reviewed, reviewedBy: occ.reviewedBy, reviewedAt: occ.reviewedAt, annotator: occ.annotator, transcript: occ.transcript, segments: occ.segments, changeType });
      }
    }

    prevStateKey = stateKey;
    prevContentKey = contentKey;
  }

  rows.push({ ...primary, drId: primary.id, versions });
}

const reviewedCount = rows.filter(r => r.reviewed).length;
const withHistory = rows.filter(r => r.versions.length > 0).length;
console.log(`✓ ${rows.length} unique rows · ${reviewedCount} reviewed · ${withHistory} with history · ${totalSkipped} skipped`);
// ---------------------------------------------------------------------------
// Facets
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
  airport:   collectFacet('airport'),
  position:  collectFacet('position'),
  date:      collectFacet('date'),
  batch:     collectFacet('batch'),
  annotator: collectFacet('annotator'),
  reviewer:  collectFacet('reviewedBy'),
};

// ---------------------------------------------------------------------------
// MiniSearch index
// ---------------------------------------------------------------------------
const ms = new MiniSearch({
  fields: ['transcript', 'key', 'drId'],
  storeFields: ['id', 'projectId', 'key', 'duration', 'speakers', 'roles', 'segments', 'transcript',
    'airport', 'position', 'date', 'time', 'batch', 'snapshotDate', 'annotator',
    'reviewed', 'reviewedBy', 'reviewedAt', 'drId', 'versions'],
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
// Encrypt
// ---------------------------------------------------------------------------
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
  return Buffer.concat([iv, tag, enc]);
}

console.log(`→ Deriving key (PBKDF2, ${ITERATIONS.toLocaleString()} iterations)`);
const key = deriveKey(PASSWORD, SALT);

console.log(`→ Encrypting blobs (AES-256-GCM)`);
fs.writeFileSync(DATA_PATH, encrypt(Buffer.from(JSON.stringify(rows)), key));
fs.writeFileSync(INDEX_PATH, encrypt(Buffer.from(JSON.stringify(ms.toJSON())), key));

const meta = {
  version: 2,
  kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt: SALT.toString('base64') },
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
console.log(`  Batches: ${facets.batch.map(b => `${b.value}(${b.count})`).join(', ')}`);
console.log(`  Annotators: ${facets.annotator.length} distinct`);
