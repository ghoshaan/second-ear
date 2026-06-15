const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// Path to the client secrets file
const clientSecretPath = 'C:\\Users\\ghosh\\Desktop\\atc-search\\client_secret_697795334437-924nrj22oraatg0doejdb29ajk24ucqn.apps.googleusercontent.com.json';

const PORT = 3000;
const REDIRECT_URI = `http://localhost:${PORT}`;

function getOAuthCredentials() {
  if (!fs.existsSync(clientSecretPath)) {
    console.error(`Error: Client secret JSON file not found at: ${clientSecretPath}`);
    process.exit(1);
  }

  try {
    const data = JSON.parse(fs.readFileSync(clientSecretPath, 'utf8'));
    const web = data.web;
    if (!web || !web.client_id || !web.client_secret) {
      throw new Error('Invalid client_secret JSON structure. Missing web.client_id or web.client_secret.');
    }
    return {
      clientId: web.client_id,
      clientSecret: web.client_secret
    };
  } catch (err) {
    console.error('Failed to parse client secret JSON:', err.message);
    process.exit(1);
  }
}

function exchangeCodeForTokens(clientId, clientSecret, code) {
  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }).toString();

    const options = {
      hostname: 'oauth2.googleapis.com',
      port: 443,
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            reject(new Error(`Google API Error (Status ${res.statusCode}): ${JSON.stringify(parsed)}`));
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function main() {
  const credentials = getOAuthCredentials();
  const { clientId, clientSecret } = credentials;

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` + new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/drive',
    access_type: 'offline',
    prompt: 'consent'
  }).toString();

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url, `http://${req.headers.host}`);
    
    if (reqUrl.pathname === '/') {
      const code = reqUrl.searchParams.get('code');
      const error = reqUrl.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<h1>Authentication Failed</h1><p>Error: ${error}</p>`);
        console.error(`\n[Error] Authorization failed: ${error}`);
        server.close();
        process.exit(1);
      }

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html>
            <head><style>body { font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f4f7f6; color: #333; } .card { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); text-align: center; }</style></head>
            <body>
              <div class="card">
                <h1 style="color: #2ecc71;">Success!</h1>
                <p>Authentication complete. You can close this tab and return to the terminal.</p>
              </div>
            </body>
          </html>
        `);
        
        console.log('\n[Status] Received authorization code. Exchanging for tokens...');
        
        try {
          const tokens = await exchangeCodeForTokens(clientId, clientSecret, code);
          console.log('\n=========================================');
          console.log('SUCCESS: TOKENS ACQUIRED');
          console.log('=========================================');
          console.log(`GOOGLE_CLIENT_ID: ${clientId}`);
          console.log(`GOOGLE_CLIENT_SECRET: ${clientSecret}`);
          console.log(`GOOGLE_REFRESH_TOKEN: ${tokens.refresh_token}`);
          console.log('=========================================');
          console.log('\nSave these as Wrangler secrets using:\n');
          console.log(`npx wrangler secret put GOOGLE_CLIENT_ID (paste value above)`);
          console.log(`npx wrangler secret put GOOGLE_CLIENT_SECRET (paste value above)`);
          console.log(`npx wrangler secret put GOOGLE_REFRESH_TOKEN (paste value above)\n`);
        } catch (err) {
          console.error('\n[Error] Failed to exchange token:', err.message);
        } finally {
          server.close();
          process.exit(0);
        }
      } else {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<h1>Bad Request</h1><p>Missing authorization code.</p>');
      }
    }
  });

  server.listen(PORT, () => {
    console.log(`\n======================================================================`);
    console.log(`OAuth Helper Server listening on ${REDIRECT_URI}`);
    console.log(`======================================================================`);
    console.log(`\nPlease open the following URL in your browser to authorize Google Drive access:`);
    console.log(`\n\x1b[36m%s\x1b[0m\n`, authUrl);
    console.log(`======================================================================`);
    console.log(`Note: If you get a 'redirect_uri_mismatch' error in your browser, ensure that`);
    console.log(`'${REDIRECT_URI}' is added as an Authorized Redirect URI for Client ID`);
    console.log(`in your Google Cloud Console (under APIs & Services > Credentials).`);
  });
}

main();
