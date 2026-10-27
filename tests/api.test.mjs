import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const secret = randomBytes(32).toString('base64url');
const ownerPassword = 'owner-' + randomBytes(24).toString('base64url');
const viewerPassword = 'viewer-' + randomBytes(24).toString('base64url');
const legacyPassword = 'legacy-' + randomBytes(24).toString('base64url');
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
  const parsed = text ? JSON.parse(text) : null;
  assert.doesNotMatch(JSON.stringify(parsed), /password_hash|scrypt\$/i, 'API responses never expose password hashes');
  return { status: response.status, headers: response.headers, body: parsed };
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

async function loginAdmin(username = 'owner', password = ownerPassword) {
  const login = await request('/api/admin/login', {
    method: 'POST',
    body: { username, password }
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
    HAKU_ADMIN_PASSWORD: legacyPassword,
    HAKU_DB_PATH: dbPath,
    HAKU_CONSENT_VERSION: consentVersion,
    HAKU_RETENTION_DAYS: '365',
    HAKU_STATS_TIMEZONE: 'Asia/Phnom_Penh',
    HAKU_BOTS_JSON: JSON.stringify(bots)
  };

  for (const [username, role, password] of [
    ['owner', 'owner', ownerPassword],
    ['viewer', 'viewer', viewerPassword]
  ]) {
    const created = spawnSync(process.execPath, [join(ROOT, 'server.mjs'), 'create-admin', username, role], {
      cwd: ROOT,
      env: childEnv,
      input: password + '\n',
      encoding: 'utf8'
    });
    assert.equal(created.status, 0, `create-admin creates ${role}: ${created.stderr}`);
    assert.equal(created.stdout.includes(password) || created.stderr.includes(password), false,
      'create-admin output never prints the password');
  }
  const storedAdmins = new DatabaseSync(dbPath);
  const adminRows = storedAdmins.prepare('SELECT username, password_hash, role FROM admins ORDER BY username').all();
  storedAdmins.close();
  assert.equal(adminRows.length, 2);
  assert.ok(adminRows.every((row) => /^scrypt\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/.test(row.password_hash)));
  assert.ok(adminRows.some((row) => row.username === 'owner' && row.role === 'owner'));
  assert.ok(adminRows.some((row) => row.username === 'viewer' && row.role === 'viewer'));
  assert.equal(adminRows.some((row) => [ownerPassword, viewerPassword].includes(row.password_hash)), false);

  await startServer();

  assert.equal((await request('/api/telegram/account', { cookie: 'haku_session=%E0%A4%A' })).status, 401,
    'malformed percent-encoded cookies are ignored instead of causing a 500');
  assert.equal((await request('/api/telegram/account/delete', { method: 'POST' })).status, 401,
    'delete without a user session returns 401');
  assert.equal((await request('/api/telegram/account')).status, 401,
    'export without a user session returns 401');

  const userSession = await createUserSession(userId);
  assert.match(userSession.cookie, /^haku_session=/, 'Telegram session uses the user cookie name');
  assert.equal((await request('/api/telegram/account', { cookie: userSession.cookie })).status, 404,
    'successful Telegram verification does not create a saved account');
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

  assert.equal((await request('/api/admin/login', {
    method: 'POST', body: { username: 'unknown-admin', password: ownerPassword }
  })).status, 401, 'unknown username is rejected');
  assert.equal((await request('/api/admin/login', {
    method: 'POST', body: { username: 'owner', password: viewerPassword }
  })).status, 401, 'wrong password is rejected');
  assert.equal((await request('/api/admin/login', {
    method: 'POST', body: { username: 'owner', password: legacyPassword }
  })).status, 401, 'legacy shared password is ignored once named admins exist');

  const ownerLogin = await request('/api/admin/login', {
    method: 'POST', body: { username: 'owner', password: ownerPassword }
  });
  assert.equal(ownerLogin.status, 200);
  assert.deepEqual(ownerLogin.body.admin.role, 'owner');
  const adminCookie = ownerLogin.headers.get('set-cookie')?.split(';')[0];
  assert.match(adminCookie, /^haku_admin_session=/, 'admin session uses a separate cookie name');
  assert.equal((await request('/api/telegram/account', { cookie: adminCookie })).status, 401,
    'admin cookie cannot authenticate a Telegram account request');
  const ownerCsrf = ownerLogin.body.csrfToken;
  const viewerLogin = await request('/api/admin/login', {
    method: 'POST', body: { username: 'viewer', password: viewerPassword }
  });
  assert.equal(viewerLogin.status, 200);
  assert.deepEqual(viewerLogin.body.admin.role, 'viewer');
  const viewerCookie = viewerLogin.headers.get('set-cookie')?.split(';')[0];
  const viewerCsrf = viewerLogin.body.csrfToken;
  assert.equal((await request('/api/admin/overview', { cookie: viewerCookie })).status, 200,
    'viewer can read overview');
  assert.equal((await request('/api/admin/overview', {
    method: 'POST', cookie: viewerCookie, csrf: viewerCsrf, body: {}
  })).status, 403, 'viewer cannot perform admin writes');

  const overviewBefore = await request('/api/admin/overview', { cookie: adminCookie });
  assert.equal(overviewBefore.status, 200);
  assert.ok(overviewBefore.body.users.some((user) => user.id === userId), 'saved user appears in overview before deletion');

  const utcDay = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const utc1730 = `${utcDay}T17:30:00.000Z`;
  const phnomPenhDay = new Date(Date.parse(utc1730) + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const statsUserId = String(900000000 + randomBytes(4).readUInt32BE(0));
  const statsDb = new DatabaseSync(dbPath);
  statsDb.prepare(`INSERT INTO users (telegram_id, locale, source_bot_id, first_seen, last_seen, consent_at, consent_version)
    VALUES (?, 'en', 'bot-test', ?, ?, ?, ?)`)
    .run(statsUserId, utc1730, utc1730, utc1730, consentVersion);
  statsDb.close();
  const timezoneStats = await request('/api/admin/overview', { cookie: adminCookie });
  assert.equal(timezoneStats.status, 200);
  assert.equal(timezoneStats.body.metrics.newUsers7d, overviewBefore.body.metrics.newUsers7d + 1,
    'UTC 17:30 record is included in the Phnom Penh seven-day count');
  const phnomPenhIndex = timezoneStats.body.dailyDates.indexOf(phnomPenhDay);
  assert.notEqual(phnomPenhIndex, -1, 'dailyDates uses the Phnom Penh local date');
  assert.equal(timezoneStats.body.dailyNewUsers[phnomPenhIndex], overviewBefore.body.dailyNewUsers[phnomPenhIndex] + 1,
    'UTC 17:30 is counted on the Phnom Penh calendar day (00:30)');
  const utcDayIndex = timezoneStats.body.dailyDates.indexOf(utcDay);
  if (utcDayIndex !== -1 && utcDayIndex !== phnomPenhIndex) {
    assert.equal(timezoneStats.body.dailyNewUsers[utcDayIndex], overviewBefore.body.dailyNewUsers[utcDayIndex],
      'the same user is not assigned to the UTC calendar day');
  }

  const deleted = await request('/api/telegram/account/delete', {
    method: 'POST', cookie: userSession.cookie, csrf: userSession.csrf
  });
  assert.deepEqual({ status: deleted.status, body: deleted.body }, { status: 200, body: { deleted: true } });
  const overviewAfter = await request('/api/admin/overview', { cookie: adminCookie });
  assert.equal(overviewAfter.status, 200);
  assert.equal(overviewAfter.body.users.some((user) => user.id === userId), false,
    'deleted user no longer appears in admin overview');

  const logout = await request('/api/admin/logout', {
    method: 'POST', cookie: adminCookie, csrf: ownerCsrf
  });
  assert.deepEqual({ status: logout.status, body: logout.body }, { status: 200, body: { loggedOut: true } });

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

  let limited = false;
  for (let i = 0; i < 10 && !limited; i++) {
    const attempt = await request('/api/admin/login', {
      method: 'POST', body: { username: 'owner', password: 'incorrect-' + i }
    });
    assert.ok(attempt.status === 401 || attempt.status === 429);
    limited = attempt.status === 429;
  }
  assert.equal(limited, true, 'admin login attempts remain rate limited');
  for (let i = 0; i < 5; i++) {
    const blocked = await request('/api/admin/login', {
      method: 'POST', body: { username: 'owner', password: 'still-incorrect-' + i }
    });
    assert.equal(blocked.status, 429);
  }

  const auditDb = new DatabaseSync(dbPath);
  const auditActions = auditDb.prepare('SELECT action, admin_id, target FROM audit_log').all();
  auditDb.close();
  assert.equal(auditActions.filter((entry) => entry.action === 'admin_login_rate_limited').length, 1,
    'repeated rate-limited logins write a single audit record per window');
  assert.ok(auditActions.some((entry) => entry.action === 'admin_login_success' && entry.admin_id));
  assert.ok(auditActions.some((entry) => entry.action === 'admin_login_failed'));
  assert.ok(auditActions.some((entry) => entry.action === 'admin_logout' && entry.admin_id));
  assert.ok(auditActions.some((entry) => entry.action === 'account_export' && entry.admin_id === null));
  assert.ok(auditActions.some((entry) => entry.action === 'account_export' && entry.target === 'self-service-account'));

  assert.equal(stdout.includes(secret) || stderr.includes(secret), false, 'logs do not contain the session secret');
  assert.equal(stdout.includes(botToken) || stderr.includes(botToken), false, 'logs do not contain the Bot token');
  assert.equal(stdout.includes(ownerPassword) || stderr.includes(ownerPassword), false, 'logs do not contain admin passwords');
  assert.equal(stdout.includes(viewerPassword) || stderr.includes(viewerPassword), false, 'logs do not contain admin passwords');

  await stopServer();
  const legacyDbPath = join(tempDir, 'legacy.sqlite');
  childEnv = { ...childEnv, PORT: String(await probePort()), HAKU_DB_PATH: legacyDbPath };
  await startServer();
  const legacyLogin = await request('/api/admin/login', {
    method: 'POST', body: { username: 'owner', password: legacyPassword }
  });
  assert.equal(legacyLogin.status, 200, 'legacy shared password can initialize the first owner');
  assert.equal(legacyLogin.body.admin.role, 'owner');
  const legacyDb = new DatabaseSync(legacyDbPath);
  const migratedHash = legacyDb.prepare('SELECT password_hash FROM admins WHERE username = ?').get('owner').password_hash;
  legacyDb.close();
  assert.match(migratedHash, /^scrypt\$/);
  assert.notEqual(migratedHash, legacyPassword, 'legacy password is migrated to a salted scrypt hash');

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
