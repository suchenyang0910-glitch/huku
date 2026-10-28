import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tempDir = await mkdtemp(join(tmpdir(), 'haku-hosts-test-'));
let serverProcess;

const port = await new Promise((resolvePort, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const value = probe.address().port;
    probe.close((error) => error ? reject(error) : resolvePort(value));
  });
});

function request(path, { host = 'mini.example.test', method = 'GET' } = {}) {
  return new Promise((resolveRequest, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers: { Host: host } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolveRequest({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.once('error', reject);
    req.end();
  });
}

try {
  serverProcess = spawn(process.execPath, [join(ROOT, 'server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      HAKU_PUBLIC_ORIGIN: 'https://mini.example.test',
      HAKU_ADMIN_ORIGIN: 'https://admin.example.test',
      HAKU_ALLOWED_ORIGINS: 'https://mini.example.test',
      HAKU_SESSION_SECRET: randomBytes(32).toString('base64url'),
      HAKU_CONSENT_VERSION: 'hosts-test',
      HAKU_DB_PATH: join(tempDir, 'haku.sqlite'),
      HAKU_BOTS_JSON: JSON.stringify([{ id: 'main', name: 'Haku', token: '123456:' + randomBytes(24).toString('base64url') }])
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });

  let stderr = '';
  serverProcess.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const started = Date.now();
  let ready = false;
  while (Date.now() - started < 8000) {
    if (serverProcess.exitCode !== null) throw new Error(`server.mjs exited during startup: ${stderr}`);
    try {
      if ((await request('/api/health')).status === 200) { ready = true; break; }
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  assert.ok(ready, `server.mjs did not become ready: ${stderr}`);

  assert.equal((await request('/api/admin/overview')).status, 404, 'admin API is hidden on the Mini App host');
  assert.equal((await request('/api/admin/users/42/profile')).status, 404, 'owner profile API is hidden on the Mini App host');
  assert.equal((await request('/api/admin/overview', { host: 'admin.example.test' })).status, 401, 'admin host reaches authentication');
  const sessionStatus = await request('/api/admin/session', { host: 'admin.example.test' });
  assert.equal(sessionStatus.status, 200);
  assert.deepEqual(JSON.parse(sessionStatus.body), { authenticated: false, admin: null });

  const logo = await request('/assets/logo-96.webp');
  assert.equal(logo.status, 200);
  assert.equal(logo.headers['content-type'], 'image/webp');
  assert.equal(logo.headers['cache-control'], 'public, max-age=604800');
  assert.ok(logo.body.length > 0);

  const iztro = await request('/assets/vendor/iztro-2.6.3.min.js');
  assert.equal(iztro.status, 200, 'the pinned iztro browser bundle is served');
  assert.equal(iztro.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(iztro.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.ok(iztro.body.length > 400000);

  for (const path of ['/assets/../server.mjs', '/assets/vendor/other.js', '/assets/iztro-2.6.3.min.js', '/assets/logo-96.svg', '/assets/LOGO.webp', '/assets/logo_96.webp']) {
    assert.equal((await request(path)).status, 404, `${path} is rejected`);
  }
  assert.equal((await request('/api/health', { method: 'HEAD' })).status, 200, 'HEAD health check succeeds');
  console.log('hosts.test.mjs: all assertions passed');
} finally {
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill('SIGTERM');
    await new Promise((resolveExit) => serverProcess.once('exit', resolveExit));
  }
  const resolvedTemp = resolve(tempDir);
  if (resolvedTemp.startsWith(resolve(tmpdir()) + sep) && basename(resolvedTemp).startsWith('haku-hosts-test-')) {
    await rm(resolvedTemp, { recursive: true, force: true });
  }
}
