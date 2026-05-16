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

      const accessToken = await refreshAccessToken(
        env.GOOGLE_CLIENT_ID,
        env.GOOGLE_CLIENT_SECRET,
        env.GOOGLE_REFRESH_TOKEN
      );
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
