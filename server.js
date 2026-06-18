const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const ROOT_DIR = __dirname;
const HTML_PATH = path.join(ROOT_DIR, 'index.html');
const CSS_DIR = path.join(ROOT_DIR, 'css');
const APP_DIR = path.join(ROOT_DIR, 'app');
const ASSETS_DIR = path.join(ROOT_DIR, 'assets');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const SUBMISSIONS_PATH = path.join(DATA_DIR, 'submissions.json');
const PACKAGE_CONFIG_PATH = path.join(DATA_DIR, 'packages.json');
const CREDENTIALS_PATH = path.join(ROOT_DIR, 'admin.credentials.json');
const PORT = Number(process.env.PORT || 3000);
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

// ─── File Helpers ──────────────────────────────────────────────────────────
function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readFileSafe(filePath, fallback = '') {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return fallback;
  }
}

function readJson(filePath, fallbackValue) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallbackValue;
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) {
      return fallbackValue;
    }
    return JSON.parse(raw);
  } catch {
    return fallbackValue;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
    '.txt': 'text/plain; charset=utf-8',
    '.pdf': 'application/pdf'
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

function randomToken(byteLength) {
  return crypto.randomBytes(byteLength).toString('base64url');
}

// ─── Credentials ──────────────────────────────────────────────────────────
function ensureCredentials() {
  if (fs.existsSync(CREDENTIALS_PATH)) {
    const storedCredentials = readJson(CREDENTIALS_PATH, null);
    if (storedCredentials && storedCredentials.adminUsername && 
        storedCredentials.adminPassword && storedCredentials.sessionSecret) {
      return storedCredentials;
    }
  }

  const generatedCredentials = {
    adminUsername: 'admin',
    adminPassword: randomToken(10),
    sessionSecret: randomToken(32)
  };

  writeJson(CREDENTIALS_PATH, generatedCredentials);
  console.log('\n✅ Created admin credentials at %s', CREDENTIALS_PATH);
  console.log('📋 Admin username: %s', generatedCredentials.adminUsername);
  console.log('🔑 Admin password: %s', generatedCredentials.adminPassword);
  console.log('⚠️  Please save these credentials securely.\n');
  return generatedCredentials;
}

// ─── Submissions Store ────────────────────────────────────────────────────
function ensureSubmissionsStore() {
  ensureDirectory(DATA_DIR);
  if (!fs.existsSync(SUBMISSIONS_PATH)) {
    writeJson(SUBMISSIONS_PATH, []);
  }
}

function ensurePackageConfigStore() {
  ensureDirectory(DATA_DIR);
  if (!fs.existsSync(PACKAGE_CONFIG_PATH)) {
    writeJson(PACKAGE_CONFIG_PATH, { packages: [] });
  }
}

function readSubmissions() {
  const submissions = readJson(SUBMISSIONS_PATH, []);
  return Array.isArray(submissions) ? submissions : [];
}

function saveSubmissions(submissions) {
  writeJson(SUBMISSIONS_PATH, submissions);
}

function readPackageConfig() {
  const config = readJson(PACKAGE_CONFIG_PATH, { packages: [] });
  if (!config || !Array.isArray(config.packages)) {
    return { packages: [] };
  }
  return config;
}

function writePackageConfig(config) {
  writeJson(PACKAGE_CONFIG_PATH, config);
}

// ─── Session Management ──────────────────────────────────────────────────
function parseCookies(cookieHeader) {
  const cookieMap = {};
  if (!cookieHeader) {
    return cookieMap;
  }

  cookieHeader.split(';').forEach((part) => {
    const index = part.indexOf('=');
    if (index === -1) {
      return;
    }
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    cookieMap[key] = decodeURIComponent(value);
  });

  return cookieMap;
}

function createSessionToken(adminUsername, sessionSecret) {
  const payload = Buffer.from(JSON.stringify({
    username: adminUsername,
    exp: Date.now() + SESSION_TTL_MS
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', sessionSecret)
    .update(payload)
    .digest('base64url');
  return `${payload}.${signature}`;
}

function verifySessionToken(token, sessionSecret, expectedUsername) {
  if (!token || typeof token !== 'string') {
    return false;
  }

  const tokenParts = token.split('.');
  if (tokenParts.length !== 2) {
    return false;
  }

  const [payloadPart, signaturePart] = tokenParts;
  const expectedSignature = crypto.createHmac('sha256', sessionSecret)
    .update(payloadPart)
    .digest('base64url');
  
  const signatureBuffer = Buffer.from(signaturePart);
  const expectedSignatureBuffer = Buffer.from(expectedSignature);
  
  if (signatureBuffer.length !== expectedSignatureBuffer.length) {
    return false;
  }
  
  if (!crypto.timingSafeEqual(signatureBuffer, expectedSignatureBuffer)) {
    return false;
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
    if (payload.username !== expectedUsername) {
      return false;
    }
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ─── Request Helpers ──────────────────────────────────────────────────────
function getRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    request.on('data', (chunk) => {
      chunks.push(chunk);
    });

    request.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      if (!bodyText) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(bodyText));
      } catch {
        reject(new Error('Invalid JSON payload.'));
      }
    });

    request.on('error', reject);
  });
}

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    ...extraHeaders
  });
  response.end(JSON.stringify(payload));
}

function sendText(response, statusCode, text, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(statusCode, {
    'Content-Type': contentType
  });
  response.end(text);
}

function sendHtml(response, statusCode, html) {
  response.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8'
  });
  response.end(html);
}

function sendFile(response, filePath) {
  try {
    const content = fs.readFileSync(filePath);
    const mimeType = getMimeType(filePath);

    response.writeHead(200, {
      'Content-Type': mimeType,
      'Cache-Control': 'public, max-age=86400' // 24h cache
    });
    response.end(content);
  } catch {
    sendText(response, 404, 'File not found.');
  }
}

// ─── Authentication Middleware ────────────────────────────────────────────
function requireAuth(request, response, callback) {
  const cookies = parseCookies(request.headers.cookie || '');
  const isAuthenticated = verifySessionToken(
    cookies.admin_session,
    credentials.sessionSecret,
    credentials.adminUsername
  );

  if (!isAuthenticated) {
    sendJson(response, 401, { ok: false, error: 'Unauthorized.' });
    return;
  }

  callback();
}

// ─── Initialize ──────────────────────────────────────────────────────────
const credentials = ensureCredentials();
ensureSubmissionsStore();
ensurePackageConfigStore();

// ─── Create Server ────────────────────────────────────────────────────────
const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const pathname = requestUrl.pathname;

  // ── Serve main HTML ──
  if (pathname === '/' || pathname === '/index.html') {
    const html = readFileSafe(HTML_PATH);
    sendHtml(response, 200, html);
    return;
  }

  // ── Serve static assets ──
  if (pathname.startsWith('/css/')) {
    const filePath = path.join(CSS_DIR, pathname.replace('/css/', ''));
    sendFile(response, filePath);
    return;
  }

  if (pathname.startsWith('/app/')) {
    const filePath = path.join(APP_DIR, pathname.replace('/app/', ''));
    sendFile(response, filePath);
    return;
  }

  if (pathname.startsWith('/js/')) {
    const filePath = path.join(APP_DIR, pathname.replace('/js/', ''));
    sendFile(response, filePath);
    return;
  }

  if (pathname.startsWith('/assets/')) {
    const filePath = path.join(ASSETS_DIR, pathname.replace('/assets/', ''));
    sendFile(response, filePath);
    return;
  }

  // ── Admin redirect ──
  if (pathname === '/admin') {
    response.writeHead(302, {
      Location: '/?view=admin'
    });
    response.end();
    return;
  }

  // ── Admin packages management page ──
  if (pathname === '/admin/packages' || pathname === '/admin/packages/') {
    const packagesPagePath = path.join(ROOT_DIR, 'admin-packages.html');
    sendFile(response, packagesPagePath);
    return;
  }

  // ── Admin package edit page ──
  if (pathname.startsWith('/admin/packages/')) {
    const packageId = pathname.replace('/admin/packages/', '').split('?')[0];
    if (packageId) {
      const editPagePath = path.join(ROOT_DIR, 'admin-package-edit.html');
      const html = readFileSafe(editPagePath);
      const htmlWithId = html.replace('new URLSearchParams(window.location.search).get(\'id\')', `'${packageId}'`);
      sendHtml(response, 200, htmlWithId);
      return;
    }
  }

  // ── API: Login ──
  if (pathname === '/api/admin/login' && request.method === 'POST') {
    try {
      const body = await getRequestBody(request);
      const username = String(body.username || '').trim();
      const password = String(body.password || '');

      if (username !== credentials.adminUsername || password !== credentials.adminPassword) {
        sendJson(response, 401, { ok: false, error: 'Invalid credentials.' });
        return;
      }

      const token = createSessionToken(credentials.adminUsername, credentials.sessionSecret);
      sendJson(response, 200, { ok: true }, {
        'Set-Cookie': `admin_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
      });
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error.message || 'Unable to process login.' });
    }
    return;
  }

  // ── API: Logout ──
  if (pathname === '/api/admin/logout' && request.method === 'POST') {
    sendJson(response, 200, { ok: true }, {
      'Set-Cookie': 'admin_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'
    });
    return;
  }

  // ── API: Get Submissions ──
  if (pathname === '/api/submissions' && request.method === 'GET') {
    requireAuth(request, response, () => {
      sendJson(response, 200, {
        ok: true,
        entries: readSubmissions()
      });
    });
    return;
  }

  // ── API: Create Submission ──
  if (pathname === '/api/submissions' && request.method === 'POST') {
    try {
      const body = await getRequestBody(request);
      const submissions = readSubmissions();
      
      const submission = {
        id: crypto.randomUUID(),
        createdAt: body.createdAt || new Date().toISOString(),
        name: body.name || '',
        dateOfBirth: body.dateOfBirth || '',
        mobileNumber: body.mobileNumber || '',
        nameCompatibility: body.nameCompatibility || '',
        mobileCompatibility: body.mobileCompatibility || '',
        mobileCompatibilityDetail: body.mobileCompatibilityDetail || '',
        nameRoot: body.nameRoot ?? null,
        firstNameRoot: body.firstNameRoot ?? null,
        mobileRoot: body.mobileRoot ?? null
      };

      submissions.push(submission);
      saveSubmissions(submissions);

      sendJson(response, 200, {
        ok: true,
        submission
      });
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error.message || 'Unable to save submission.' });
    }
    return;
  }

  if (pathname === '/api/packages' && request.method === 'GET') {
    try {
      const packageConfig = readPackageConfig();
      sendJson(response, 200, {
        ok: true,
        packageConfig
      });
    } catch (error) {
      sendJson(response, 500, { ok: false, error: 'Unable to read package configuration.' });
    }
    return;
  }

  if (pathname === '/api/packages' && request.method === 'PUT') {
    requireAuth(request, response, async () => {
      try {
        const body = await getRequestBody(request);
        if (!body || typeof body !== 'object' || !Array.isArray(body.packages)) {
          sendJson(response, 400, { ok: false, error: 'Invalid package configuration payload.' });
          return;
        }

        const packageConfig = {
          packages: body.packages.map(function(pkg) {
            return {
              id: String(pkg.id || '').trim(),
              title: String(pkg.title || '').trim(),
              subtitle: String(pkg.subtitle || '').trim(),
              price: String(pkg.price || '').trim(),
              items: Array.isArray(pkg.items) ? pkg.items.map(function(item) { return String(item || '').trim(); }).filter(Boolean) : [],
              note: pkg.note ? String(pkg.note).trim() : ''
            };
          }),
          footer: body.footer ? String(body.footer).trim() : ''
        };

        writePackageConfig(packageConfig);
        sendJson(response, 200, { ok: true, packageConfig });
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error.message || 'Unable to save package configuration.' });
      }
    });
    return;
  }

  // ── Health Check ──
  if (pathname === '/health') {
    sendJson(response, 200, { ok: true, timestamp: new Date().toISOString() });
    return;
  }

  // ── 404 ──
  sendText(response, 404, 'Not found.');
});

// ─── Start Server ────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log('\n🚀 Numerology Compatibility Studio');
  console.log('═══════════════════════════════════════');
  console.log(`📡 Server running on http://localhost:${PORT}`);
  console.log(`🔐 Admin panel: http://localhost:${PORT}/?view=admin`);
  console.log(`📊 API endpoint: http://localhost:${PORT}/api/submissions`);
  console.log(`💚 Health check: http://localhost:${PORT}/health`);
  console.log('═══════════════════════════════════════\n');
});