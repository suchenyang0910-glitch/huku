import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const secret = randomBytes(32).toString('base64url');
const adminPassword = 'test-' + randomBytes(24).toString('base64url');
const botToken = '123456:' + randomBytes(24).toString('base64url');
const userId = String(700000000 + randomBytes(4).readUInt32BE(0));
const staleUserId = String(800000000 + randomBytes(4).readUInt32BE(0));
const consentVersion = 'api-test-v1';
const bots = [{ id: 'bot-test', name: 'Haku Test', token: botToken, active: true }];
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function probePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

function signedInitData(id) {
  const values = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AA' + randomBytes(12).toString('base64url'),
    user: JSON.stringify({ id: Number(id), first_name: 'Test User', language_code: 'en' })
  };
  const dataCheckString = Object.keys(values).sort().map((key) => `${key}=${values[key]}`).join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  return new URLSearchParams({ ...values, hash }).toString();
}

let tempDir;
let dbPath;
let appPort;
let childEnv;
let processHandle;
let stdout = '';
let stderr = '';

async function startServer() {
  appPort = Number(childEnv.PORT);
  processHandle = spawn(process.execPath, [join(ROOT, 'server.mjs')], {
    cwd: ROOT,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  processHandle.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  processHandle.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const startedAt = Date.now();
  while (Date.now() - startedAt < 8000) {
    if (processHandle.exitCode !== null) throw new Error('server.mjs exited during startup: ' + stderr);
    try {
      const response = await fetch(`http://127.0.0.1:${appPort}/api/health`);
      if (response.ok) return;
    } catch {}
    await sleep(50);
  }
  throw new Error('server.mjs did not become healthy: ' + stderr);
}

async function stopServer() {
  if (!processHandle || processHandle.exitCode !== null) return;
  const child = processHandle;
  await new Promise((resolveExit) => {
    child.once('exit', resolveExit);
    child.kill('SIGTERM');
  });
  processHandle = null;
}

async function request(path, { method = 'GET', body, cookie, csrf } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers['X-CSRF-Token'] = csrf;
  const response = await fetch(`http://127.0.0.1:${appPort}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
}

async function createUserSession(id) {
  const auth = await request('/api/telegram/auth', {
    method: 'POST',
    body: { initData: signedInitData(id) }
  });
  assert.equal(auth.status, 200, 'Telegram initData authenticates');
  const cookie = auth.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie, 'user session cookie is set');
  return { cookie, csrf: auth.body.csrfToken };
}

async function loginAdmin() {
  const login = await request('/api/admin/login', {
    method: 'POST',
    body: { password: adminPassword }
  });
  assert.equal(login.status, 200, 'admin login succeeds');
  return login.headers.get('set-cookie')?.split(';')[0];
}

try {
  tempDir = await mkdtemp(join(tmpdir(), 'haku-api-test-'));
  dbPath = join(tempDir, 'haku.sqlite');
  const port = await probePort();
  childEnv = {
    ...process.env,
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: String(port),
    HAKU_PUBLIC_ORIGIN: 'http://127.0.0.1:' + port,
    HAKU_ALLOWED_ORIGINS: 'http://127.0.0.1:' + port,
    HAKU_COOKIE_SAMESITE: 'lax',
    HAKU_TRUSTED_PROXY: 'false',
    HAKU_SESSION_SECRET: secret,
    HAKU_ADMIN_PASSWORD: adminPassword,
    HAKU_DB_PATH: dbPath,
    HAKU_CONSENT_VERSION: consentVersion,
    HAKU_RETENTION_DAYS: '365',
    HAKU_BOTS_JSON: JSON.stringify(bots)
  };
  await startServer();

  assert.equal((await request('/api/telegram/account/delete', { method: 'POST' })).status, 401,
    'delete without a user session returns 401');
  assert.equal((await request('/api/telegram/account')).status, 401,
    'export without a user session returns 401');

  const userSession = await createUserSession(userId);
  assert.equal((await request('/api/telegram/account/delete', {
    method: 'POST', cookie: userSession.cookie
  })).status, 403, 'delete without CSRF returns 403');

  const consent = await request('/api/telegram/consent', {
    method: 'POST', cookie: userSession.cookie, csrf: userSession.csrf,
    body: { accepted: true, locale: 'en' }
  });
  assert.equal(consent.status, 200, 'user consents to saving account');

  const exported = await request('/api/telegram/account', { cookie: userSession.cookie });
  assert.equal(exported.status, 200, 'consented user can export account data');
  assert.deepEqual(Object.keys(exported.body).sort(), [
    'consent_at', 'consent_version', 'first_seen', 'last_seen', 'locale', 'source_bot_id', 'telegram_id'
  ].sort(), 'export contains exactly the persisted account fields');
  assert.equal(exported.body.telegram_id, userId);
  assert.equal(exported.body.locale, 'en');
  assert.equal(exported.body.source_bot_id, 'bot-test');
  assert.equal(exported.body.consent_version, consentVersion);
  for (const field of ['first_seen', 'last_seen', 'consent_at']) {
    assert.ok(Number.isFinite(Date.parse(exported.body[field])), `${field} is an ISO timestamp`);
  }

  const adminCookie = await loginAdmin();
  const overviewBefore = await request('/api/admin/overview', { cookie: adminCookie });
  assert.equal(overviewBefore.status, 200);
  assert.ok(overviewBefore.body.users.some((user) => user.id === userId), 'saved user appears in overview before deletion');

  const deleted = await request('/api/telegram/account/delete', {
    method: 'POST', cookie: userSession.cookie, csrf: userSession.csrf
  });
  assert.deepEqual({ status: deleted.status, body: deleted.body }, { status: 200, body: { deleted: true } });
  const overviewAfter = await request('/api/admin/overview', { cookie: adminCookie });
  assert.equal(overviewAfter.status, 200);
  assert.equal(overviewAfter.body.users.some((user) => user.id === userId), false,
    'deleted user no longer appears in admin overview');

  const db = new DatabaseSync(dbPath);
  const expired = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`INSERT INTO users (telegram_id, locale, source_bot_id, first_seen, last_seen, consent_at, consent_version)
    VALUES (?, 'en', 'bot-test', ?, ?, ?, ?)`)
    .run(staleUserId, expired, expired, expired, consentVersion);
  db.close();

  await stopServer();
  await startServer();
  const adminAfterRestart = await loginAdmin();
  const afterRetentionCleanup = await request('/api/admin/overview', { cookie: adminAfterRestart });
  assert.equal(afterRetentionCleanup.status, 200);
  assert.equal(afterRetentionCleanup.body.users.some((user) => user.id === staleUserId), false,
    'record older than the configured retention period is cleaned at startup');

  assert.equal(stdout.includes(secret) || stderr.includes(secret), false, 'logs do not contain the session secret');
  assert.equal(stdout.includes(botToken) || stderr.includes(botToken), false, 'logs do not contain the Bot token');
  console.log('api.test.mjs: all assertions passed');
} finally {
  await stopServer();
  if (tempDir) {
    const resolvedTemp = resolve(tempDir);
    if (resolvedTemp.startsWith(resolve(tmpdir()) + sep) && basename(resolvedTemp).startsWith('haku-api-test-')) {
      await rm(resolvedTemp, { recursive: true, force: true });
    }
  }
}
