const SCOPE = 'https://www.googleapis.com/auth/drive.file';

export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
    }

    try {
      const formData = await request.formData();
      const file = formData.get('file');
      const filename = formData.get('filename') || 'audit-report.pdf';

      if (!file) {
        return jsonResponse({ error: 'No file provided' }, 400, corsHeaders);
      }

      const accessToken = await getGoogleAccessToken(env.SA_EMAIL, env.SA_PRIVATE_KEY);
      const pdfBuffer = await file.arrayBuffer();
      const result = await uploadToDrive(accessToken, pdfBuffer, filename, env.FOLDER_ID);

      return jsonResponse({
        success: true,
        fileId: result.id,
        name: result.name,
        url: `https://drive.google.com/file/d/${result.id}/view`,
      }, 200, corsHeaders);
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

async function getGoogleAccessToken(email, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: email,
    scope: SCOPE,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  const toB64Url = s => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const headerB64 = toB64Url(JSON.stringify(header));
  const payloadB64 = toB64Url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const pem = privateKeyPem
    .replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----/g, '')
    .replace(/\\n/g, '')
    .replace(/\s/g, '');
  const keyDer = Uint8Array.from(atob(pem), c => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    'pkcs8',
    keyDer.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput)
  );

  const sigB64 = toB64Url(String.fromCharCode(...new Uint8Array(sig)));
  const jwt = `${signingInput}.${sigB64}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!tokenRes.ok) {
    throw new Error(`Google token request failed: ${await tokenRes.text()}`);
  }

  const { access_token } = await tokenRes.json();
  return access_token;
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
