const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const GH_OWNER = 'ghoshaan';
const GH_REPO = 'lazy-detective';
const DIRECTORY_PATH = 'public/directory.json';

export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    if (url.pathname.startsWith('/github')) {
      return handleGithubProxy(request, env, url, corsHeaders);
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
    }

    try {
      const formData = await request.formData();
      const file = formData.get('file');
      const filename = formData.get('filename') || 'audit-report.pdf';
      const preparedBy = formData.get('preparedBy') || '';

      if (!file) {
        return jsonResponse({ error: 'No file provided' }, 400, corsHeaders);
      }

      const accessToken = await refreshAccessToken(
        env.GOOGLE_CLIENT_ID,
        env.GOOGLE_CLIENT_SECRET,
        env.GOOGLE_REFRESH_TOKEN
      );
      const pdfBuffer = await file.arrayBuffer();
      const result = await uploadToDrive(accessToken, pdfBuffer, filename, env.FOLDER_ID);

      const driveUrl = `https://drive.google.com/file/d/${result.id}/view`;

      const nameMatch = filename.match(/^(.*?)\s+(\d{4}-\d{2}-\d{2})\.pdf$/i);
      const entry = {
        filename,
        id: nameMatch ? nameMatch[1] : filename.replace(/\.pdf$/i, ''),
        date: nameMatch ? nameMatch[2] : new Date().toISOString().slice(0, 10),
        driveUrl,
        fileId: result.id,
        uploadedAt: new Date().toISOString(),
        ...(preparedBy ? { preparedBy } : {}),
      };

      // Non-fatal — use waitUntil so the update isn't killed when the response returns
      ctx.waitUntil(updateDirectory(env, entry).catch(err => console.error('directory update failed:', err)));

      return jsonResponse({ success: true, fileId: result.id, name: result.name, url: driveUrl }, 200, corsHeaders);
    } catch (err) {
      console.error(err.stack || err.message);
      return jsonResponse({ error: err.message }, 500, corsHeaders);
    }
  },
};

function jsonResponse(data, status, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

async function refreshAccessToken(clientId, clientSecret, refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    throw new Error(`Failed to refresh access token: ${await res.text()}`);
  }

  const data = await res.json();
  return data.access_token;
}

async function uploadToDrive(accessToken, pdfBuffer, filename, folderId) {
  const metadata = { name: filename, mimeType: 'application/pdf' };
  if (folderId) metadata.parents = [folderId];

  const boundary = 'atc_pdf_upload_boundary';
  const enc = new TextEncoder();

  const metaPart = enc.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`
  );
  const filePart = enc.encode(`--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`);
  const fileBytes = new Uint8Array(pdfBuffer);
  const closePart = enc.encode(`\r\n--${boundary}--`);

  const total = metaPart.length + filePart.length + fileBytes.length + closePart.length;
  const body = new Uint8Array(total);
  let offset = 0;
  for (const part of [metaPart, filePart, fileBytes, closePart]) {
    body.set(part, offset);
    offset += part.length;
  }

  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    }
  );

  if (!res.ok) {
    throw new Error(`Drive upload failed (${res.status}): ${await res.text()}`);
  }

  return res.json();
}

async function updateDirectory(env, entry) {
  if (!env.GH_TOKEN) return;

  const apiUrl = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${DIRECTORY_PATH}`;
  const headers = {
    Authorization: `Bearer ${env.GH_TOKEN}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'atc-pdf-worker',
  };

  let sha = null;
  let entries = [];

  const getRes = await fetch(apiUrl, { headers });
  if (getRes.ok) {
    const data = await getRes.json();
    sha = data.sha;
    try {
      entries = JSON.parse(atob(data.content.replace(/\n/g, '')));
    } catch {}
  } else if (getRes.status !== 404) {
    throw new Error(`GitHub GET failed: ${getRes.status}`);
  }

  entries.unshift(entry);

  const content = toBase64(JSON.stringify(entries, null, 2));
  const putBody = { message: `audit: ${entry.filename}`, content, ...(sha ? { sha } : {}) };

  const putRes = await fetch(apiUrl, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(putBody),
  });

  if (!putRes.ok) {
    throw new Error(`GitHub PUT failed (${putRes.status}): ${await putRes.text()}`);
  }
}

async function handleGithubProxy(request, env, url, corsHeaders) {
  const ghPath = url.pathname.replace(/^\/github/, '') + url.search;
  const ghUrl = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}${ghPath}`;

  const headers = {
    Authorization: `Bearer ${env.GH_TOKEN}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'atc-pdf-worker',
    'Content-Type': 'application/json',
  };

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const body = hasBody ? await request.text() : undefined;

  const res = await fetch(ghUrl, { method: request.method, headers, body });
  const text = await res.text();

  return new Response(text, {
    status: res.status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
