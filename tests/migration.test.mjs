import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const secret = randomBytes(32).toString('base64url');
const botToken = '123456:' + randomBytes(24).toString('base64url');
const bot = { id: 'bot-test', name: 'Haku Test', token: botToken, active: true };
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function freePort() {
  return new Promise((done, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close((error) => error ? reject(error) : done(port));
    });
  });
}

function signedInitData(id) {
  const values = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: randomBytes(12).toString('base64url'),
    user: JSON.stringify({ id, first_name: 'Migration Test', language_code: 'vi-VN' })
  };
  const data = Object.keys(values).sort().map((key) => `${key}=${values[key]}`).join('\n');
  const key = createHmac('sha256', 'WebAppData').update(botToken).digest();
  return new URLSearchParams({ ...values, hash: createHmac('sha256', key).update(data).digest('hex') }).toString();
}

let tempDir;
let child;
let stderr = '';
try {
  tempDir = await mkdtemp(join(tmpdir(), 'haku-migration-test-'));
  const dbPath = join(tempDir, 'haku.sqlite');
  const timestamp = new Date().toISOString();
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE users (
      telegram_id TEXT PRIMARY KEY,
      locale TEXT NOT NULL CHECK (locale IN ('en','km','th','zh')),
      source_bot_id TEXT NOT NULL,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      consent_at TEXT NOT NULL,
      consent_version TEXT NOT NULL
    ) STRICT;
    CREATE INDEX users_first_seen_idx ON users(first_seen DESC);
    CREATE INDEX users_last_seen_idx ON users(last_seen DESC);
    CREATE TABLE reading_profiles (
      telegram_id TEXT PRIMARY KEY REFERENCES users(telegram_id),
      birth_date TEXT NOT NULL,
      birth_time TEXT,
      unknown_time INTEGER NOT NULL,
      term_side TEXT NOT NULL,
      place TEXT NOT NULL,
      relationship INTEGER NOT NULL,
      concern INTEGER NOT NULL,
      duration INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
  `);
  const insert = legacy.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const [index, locale] of ['en', 'km', 'th', 'zh'].entries()) {
    insert.run(String(910000000 + index), locale, 'legacy-bot', timestamp, timestamp, timestamp, 'legacy-v1');
  }
  legacy.prepare(`INSERT INTO reading_profiles
    (telegram_id, birth_date, birth_time, unknown_time, term_side, place, relationship, concern, duration, updated_at)
    VALUES ('910000000', '1990-05-15', '12:00', 0, '', 'cn', 1, 2, 3, ?)`)
    .run(timestamp);
  legacy.close();

  const port = await freePort();
  const env = {
    ...process.env,
    NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port),
    HAKU_PUBLIC_ORIGIN: 'https://mini.example.test', HAKU_ALLOWED_ORIGINS: 'https://mini.example.test',
    HAKU_COOKIE_SAMESITE: 'lax', HAKU_SESSION_SECRET: secret,
    HAKU_ADMIN_PASSWORD: 'test-' + randomBytes(18).toString('base64url'),
    HAKU_DB_PATH: dbPath, HAKU_CONSENT_VERSION: 'migration-v2', HAKU_BOTS_JSON: JSON.stringify([bot])
  };

  async function start() {
    stderr = '';
    child = spawn(process.execPath, [join(ROOT, 'server.mjs')], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const began = Date.now();
    while (Date.now() - began < 8000) {
      if (child.exitCode !== null) throw new Error('server exited during migration: ' + stderr);
      try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch {}
      await sleep(50);
    }
    throw new Error('server did not become healthy: ' + stderr);
  }

  async function stop() {
    if (!child || child.exitCode !== null) return;
    await new Promise((done) => { child.once('exit', done); child.kill('SIGTERM'); });
    child = null;
  }

  await start();
  for (const [index, locale] of ['en', 'vi', 'zh', 'km', 'th'].entries()) {
    const auth = await fetch(`http://127.0.0.1:${port}/api/telegram/auth`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData: signedInitData(920000000 + index) })
    });
    assert.equal(auth.status, 200, `${locale} test user authenticates`);
    const session = await auth.json();
    const consent = await fetch(`http://127.0.0.1:${port}/api/telegram/consent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: auth.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': session.csrfToken },
      body: JSON.stringify({ accepted: true, locale })
    });
    assert.equal(consent.status, 200, `${locale} remains an accepted consent locale`);
  }
  await stop();

  const afterFirst = new DatabaseSync(dbPath);
  const firstTable = afterFirst.prepare("SELECT sql, rootpage FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
  const firstProfileTable = afterFirst.prepare("SELECT sql, rootpage FROM sqlite_master WHERE type = 'table' AND name = 'reading_profiles'").get();
  const rows = afterFirst.prepare('SELECT telegram_id, locale, source_bot_id, consent_version FROM users ORDER BY telegram_id').all();
  assert.equal(rows.length, 9, 'migration preserves four rows and accepts five new locale rows');
  assert.deepEqual(rows.slice(0, 4).map((row) => ({ ...row })), ['en', 'km', 'th', 'zh'].map((locale, index) => ({ telegram_id: String(910000000 + index), locale, source_bot_id: 'legacy-bot', consent_version: 'legacy-v1' })), 'legacy rows are unchanged');
  assert.match(firstTable.sql, /['"]vi['"]/, 'migrated CHECK constraint includes vi');
  assert.throws(() => afterFirst.prepare('UPDATE users SET locale = ? WHERE telegram_id = ?').run('fr', '910000000'), /CHECK constraint failed/, 'unknown locales remain rejected');
  assert.match(firstProfileTable.sql, /STRICT/i, 'reading_profiles is created as a STRICT table');
  assert.match(firstProfileTable.sql, /gender\s+TEXT/i, 'reading_profiles migration adds gender');
  assert.match(firstProfileTable.sql, /male.*female.*undisclosed/i, 'reading_profiles migration constrains gender values');
  assert.match(firstProfileTable.sql, /theme\s+TEXT/i, 'reading_profiles migration adds theme');
  assert.match(firstProfileTable.sql, /love.*wealth.*career.*social/i, 'reading_profiles migration constrains theme values');
  assert.deepEqual({ ...afterFirst.prepare("SELECT gender, theme FROM reading_profiles WHERE telegram_id = '910000000'").get() },
    { gender: null, theme: 'love' }, 'legacy reading profiles keep their data and receive gender/theme defaults');
  assert.throws(() => afterFirst.prepare("UPDATE reading_profiles SET theme = 'health' WHERE telegram_id = '910000000'").run(), /CHECK constraint failed/,
    'unknown themes remain rejected');
  afterFirst.prepare(`INSERT INTO reading_profiles
    (telegram_id, birth_date, birth_time, unknown_time, term_side, place, relationship, concern, duration, updated_at)
    VALUES ('920000000', '1990-05-15', '12:00', 0, '', 'vn', 1, 2, 3, ?)`)
    .run(timestamp);
  const firstProfileSnapshot = JSON.stringify(afterFirst.prepare('SELECT * FROM reading_profiles').all());
  const firstSnapshot = JSON.stringify(rows);
  afterFirst.close();

  await start();
  await stop();
  const afterSecond = new DatabaseSync(dbPath);
  const secondTable = afterSecond.prepare("SELECT sql, rootpage FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
  const secondProfileTable = afterSecond.prepare("SELECT sql, rootpage FROM sqlite_master WHERE type = 'table' AND name = 'reading_profiles'").get();
  assert.deepEqual(secondTable, firstTable, 'second startup does not rebuild the migrated table');
  assert.deepEqual(secondProfileTable, firstProfileTable, 'second startup does not rebuild reading_profiles');
  assert.equal(JSON.stringify(afterSecond.prepare('SELECT telegram_id, locale, source_bot_id, consent_version FROM users ORDER BY telegram_id').all()), firstSnapshot, 'second startup does not alter data');
  assert.equal(JSON.stringify(afterSecond.prepare('SELECT * FROM reading_profiles').all()), firstProfileSnapshot,
    'second startup preserves reading profile data');
  afterSecond.close();

  console.log('migration.test.mjs: legacy data preserved with love theme, five locales accepted, migration is idempotent.');
} finally {
  if (child && child.exitCode === null) await new Promise((done) => { child.once('exit', done); child.kill('SIGTERM'); });
  if (tempDir) {
    const root = resolve(tmpdir()), target = resolve(tempDir);
    if (target.startsWith(root + sep) && basename(target).startsWith('haku-migration-test-')) {
      for (let attempt = 0; attempt < 5; attempt++) {
        try { await rm(target, { recursive: true, force: true }); break; }
        catch (error) { if (error.code !== 'EBUSY') throw error; if (attempt < 4) await sleep(100); }
      }
    }
  }
}
