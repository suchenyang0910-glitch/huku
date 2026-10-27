import { createServer } from 'node:http';
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { BOT_COPY } from './bot-copy.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
loadEnv(resolve(ROOT, '.env'));

function ensureAdminSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS admins (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('owner', 'viewer')),
      created_at TEXT NOT NULL,
      disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      admin_id TEXT REFERENCES admins(id),
      action TEXT NOT NULL,
      target TEXT,
      at TEXT NOT NULL,
      ip TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log(at DESC);
  `);
}

function hashAdminPassword(password) {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

function verifyAdminPassword(password, storedHash) {
  if (typeof password !== 'string' || typeof storedHash !== 'string') return false;
  const parts = storedHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  try {
    const salt = Buffer.from(parts[1], 'base64url');
    const expected = Buffer.from(parts[2], 'base64url');
    const actual = scryptSync(password, salt, expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch { return false; }
}

async function readAdminPassword() {
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
    return new Promise((resolvePassword, rejectPassword) => {
      const input = process.stdin;
      let bytes = [];
      const finish = (error, value) => {
        input.off('data', onData);
        input.setRawMode(false);
        process.stderr.write('\n');
        error ? rejectPassword(error) : resolvePassword(value);
      };
      const onData = (chunk) => {
        for (const byte of chunk) {
          if (byte === 3) return finish(new Error('Input cancelled'));
          if (byte === 10 || byte === 13) return finish(null, Buffer.from(bytes).toString('utf8'));
          if (byte === 8 || byte === 127) {
            if (bytes.length) {
              bytes.pop();
              while (bytes.length && (bytes[bytes.length - 1] & 0xc0) === 0x80) bytes.pop();
            }
          } else if (byte >= 32) bytes.push(byte);
        }
      };
      process.stderr.write('Password (input hidden): ');
      input.setRawMode(true);
      input.resume();
      input.on('data', onData);
    });
  }
  let value = '';
  for await (const chunk of process.stdin) value += chunk.toString('utf8');
  return value.replace(/\r?\n$/, '');
}

async function createAdminCommand(args) {
  if (args.length !== 2 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,31}$/.test(args[0]) || !['owner', 'viewer'].includes(args[1])) {
    throw new Error('Usage: node server.mjs create-admin <username> <owner|viewer>');
  }
  const [requestedUsername, role] = args;
  const username = requestedUsername.toLowerCase();
  const password = await readAdminPassword();
  if (Buffer.byteLength(password, 'utf8') < 16 || Buffer.byteLength(password, 'utf8') > 1024) {
    throw new Error('Password must contain 16 to 1024 bytes');
  }
  const dbPath = resolve(ROOT, process.env.HAKU_DB_PATH || './data/haku.sqlite');
  mkdirSync(dirname(dbPath), { recursive: true });
  const database = new DatabaseSync(dbPath);
  try {
    ensureAdminSchema(database);
    const id = randomBytes(16).toString('hex');
    database.prepare('INSERT INTO admins (id, username, password_hash, role, created_at, disabled) VALUES (?, ?, ?, ?, ?, 0)')
      .run(id, username, hashAdminPassword(password), role, new Date().toISOString());
  } finally {
    database.close();
  }
  process.stdout.write(`Created admin ${username} (${role})\n`);
}

if (process.argv[2] === 'create-admin') {
  try {
    await createAdminCommand(process.argv.slice(3));
    process.exit(0);
  } catch (error) {
    console.error(error.message || 'Could not create admin');
    process.exit(1);
  }
}
if (process.argv.length > 2) {
  console.error('Usage: node server.mjs [create-admin <username> <owner|viewer>]');
  process.exit(2);
}

function loadEnv(path) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch { return; }
  for (const line of raw.split(/\r?\n/)) {
    const entry = line.trim();
    if (!entry || entry.startsWith('#')) continue;
    const index = entry.indexOf('=');
    if (index < 1) continue;
    const key = entry.slice(0, index).trim();
    let value = entry.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function required(name, minimum = 1) {
  const value = process.env[name]?.trim();
  if (!value || value.length < minimum) throw new Error(`${name} must be set and contain at least ${minimum} characters`);
  return value;
}

const sessionSecret = required('HAKU_SESSION_SECRET', 32);
const legacyAdminPassword = process.env.HAKU_ADMIN_PASSWORD || '';
if (/replace-with/i.test(sessionSecret)) throw new Error('Replace the example session secret before starting');
const dummyAdminPasswordHash = hashAdminPassword(randomBytes(32).toString('base64url'));
const consentVersion = required('HAKU_CONSENT_VERSION', 1);
const retentionDays = Number(process.env.HAKU_RETENTION_DAYS || 365);
if (!Number.isSafeInteger(retentionDays) || retentionDays < 1) throw new Error('HAKU_RETENTION_DAYS must be a positive whole number');
const statsTimezone = (process.env.HAKU_STATS_TIMEZONE || 'Asia/Phnom_Penh').trim();
let statsDateFormatter;
let statsDateTimeFormatter;
try {
  statsDateFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: statsTimezone, calendar: 'gregory', numberingSystem: 'latn',
    year: 'numeric', month: '2-digit', day: '2-digit'
  });
  statsDateTimeFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: statsTimezone, calendar: 'gregory', numberingSystem: 'latn',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  });
} catch {
  throw new Error('HAKU_STATS_TIMEZONE must be a valid IANA timezone');
}
const maxAuthAge = Math.max(60, Math.min(Number(process.env.HAKU_MAX_AUTH_AGE_SECONDS) || 600, 3600));
const cookieSameSite = (process.env.HAKU_COOKIE_SAMESITE || 'lax').toLowerCase();
if (!['lax', 'strict', 'none'].includes(cookieSameSite)) throw new Error('HAKU_COOKIE_SAMESITE must be lax, strict, or none');

let bots;
try {
  bots = JSON.parse(required('HAKU_BOTS_JSON'));
} catch {
  throw new Error('HAKU_BOTS_JSON must be a JSON array of Bot configurations');
}
if (!Array.isArray(bots) || bots.length < 1) throw new Error('Configure at least one Bot in HAKU_BOTS_JSON');
const botIds = new Set();
bots = bots.map((bot) => {
  if (!bot || typeof bot.id !== 'string' || !/^[a-zA-Z0-9_-]{2,64}$/.test(bot.id) || botIds.has(bot.id)) throw new Error('Each Bot requires a unique safe id');
  if (typeof bot.token !== 'string' || !/^\d+:[A-Za-z0-9_-]{20,}$/.test(bot.token)) throw new Error(`Bot ${bot.id} has an invalid token format`);
  if (bot.token.includes('replace-with-real-bot-token')) throw new Error(`Replace the example token for Bot ${bot.id} before starting`);
  botIds.add(bot.id);
  return { id: bot.id, name: String(bot.name || bot.id), handle: String(bot.handle || ''), role: String(bot.role || ''), token: bot.token, active: bot.active !== false };
});

const publicOrigin = required('HAKU_PUBLIC_ORIGIN');
let publicOriginUrl;
try { publicOriginUrl = new URL(publicOrigin); } catch { throw new Error('HAKU_PUBLIC_ORIGIN must be a valid origin URL'); }
if (!['http:', 'https:'].includes(publicOriginUrl.protocol) || publicOriginUrl.origin !== publicOrigin) throw new Error('HAKU_PUBLIC_ORIGIN must not include a path, query, or fragment');
if (process.env.NODE_ENV === 'production' && publicOriginUrl.protocol !== 'https:') throw new Error('Production HAKU_PUBLIC_ORIGIN must use HTTPS');
const adminOrigin = process.env.HAKU_ADMIN_ORIGIN?.trim() || '';
let adminOriginUrl = null;
if (adminOrigin) {
  try { adminOriginUrl = new URL(adminOrigin); } catch { throw new Error('HAKU_ADMIN_ORIGIN must be a valid origin URL'); }
  if (!['http:', 'https:'].includes(adminOriginUrl.protocol) || adminOriginUrl.origin !== adminOrigin) throw new Error('HAKU_ADMIN_ORIGIN must not include a path, query, or fragment');
  if (process.env.NODE_ENV === 'production' && adminOriginUrl.protocol !== 'https:') throw new Error('Production HAKU_ADMIN_ORIGIN must use HTTPS');
}
const allowedOrigins = new Set([publicOrigin, adminOrigin, ...(process.env.HAKU_ALLOWED_ORIGINS || '').split(',').map((origin) => origin.trim())].filter(Boolean));
const telegramApiBase = (process.env.HAKU_TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
const secureCookie = process.env.NODE_ENV === 'production' || cookieSameSite === 'none';
const trustProxy = process.env.HAKU_TRUSTED_PROXY === 'true';
const sessions = new Map();
const attempts = new Map();
const webhookUpdateIds = new Set();
const webhookUpdateOrder = [];
const welcomeReplyTimes = new Map();
const webhookRateCleanup = setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [key, timestamps] of welcomeReplyTimes) {
    const recent = timestamps.filter((timestamp) => timestamp > cutoff);
    if (recent.length) welcomeReplyTimes.set(key, recent);
    else welcomeReplyTimes.delete(key);
  }
}, 60_000);
webhookRateCleanup.unref();
const SESSION_MS = 12 * 60 * 60 * 1000;
const ADMIN_SESSION_MS = 8 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const ADMIN_LOGIN_MAX_ATTEMPTS = 8;
const stateCleanup = setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) if (session.expiresAt <= now) sessions.delete(id);
  for (const [key, attempt] of attempts) if (attempt.resetAt <= now) attempts.delete(key);
}, 10 * 60 * 1000);
stateCleanup.unref();

const databasePath = resolve(ROOT, process.env.HAKU_DB_PATH || './data/haku.sqlite');
mkdirSync(dirname(databasePath), { recursive: true });
const db = new DatabaseSync(databasePath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    telegram_id TEXT PRIMARY KEY,
    locale TEXT NOT NULL CHECK (locale IN ('en','km','th','zh')),
    source_bot_id TEXT NOT NULL,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    consent_at TEXT NOT NULL,
    consent_version TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS users_first_seen_idx ON users(first_seen DESC);
  CREATE INDEX IF NOT EXISTS users_last_seen_idx ON users(last_seen DESC);
`);

ensureAdminSchema(db);

const auditInsert = db.prepare('INSERT INTO audit_log (id, admin_id, action, target, at, ip) VALUES (?, ?, ?, ?, ?, ?)');
function writeAudit(adminId, action, target, ip) {
  auditInsert.run(randomBytes(16).toString('hex'), adminId || null, action, target || null, new Date().toISOString(), ip || 'unknown');
}

function cleanExpiredUsers() {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('DELETE FROM users WHERE last_seen < ?').run(cutoff);
}

cleanExpiredUsers();
const retentionCleanup = setInterval(cleanExpiredUsers, 24 * 60 * 60 * 1000);
retentionCleanup.unref();

const userUpsert = db.prepare(`
  INSERT INTO users (telegram_id, locale, source_bot_id, first_seen, last_seen, consent_at, consent_version)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(telegram_id) DO UPDATE SET
    locale = excluded.locale,
    source_bot_id = excluded.source_bot_id,
    last_seen = excluded.last_seen,
    consent_at = excluded.consent_at,
    consent_version = excluded.consent_version
`);

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function signature(value) {
  return createHmac('sha256', sessionSecret).update(value).digest('base64url');
}

function parseCookies(header = '') {
  const out = Object.create(null);
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0) {
      try { out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim()); }
      catch { continue; }
    }
  }
  return out;
}

function issueSession(res, { type, telegramId = null, botId = null, adminId = null, username = null, role = null }) {
  const id = randomBytes(32).toString('base64url');
  const csrf = randomBytes(24).toString('base64url');
  const now = Date.now();
  sessions.set(id, { type, telegramId, botId, adminId, username, role, csrf, expiresAt: now + (type === 'admin' ? ADMIN_SESSION_MS : SESSION_MS) });
  const value = `${id}.${signature(id)}`;
  const maxAge = type === 'admin' ? 8 * 60 * 60 : 12 * 60 * 60;
  const sameSite = cookieSameSite[0].toUpperCase() + cookieSameSite.slice(1);
  const cookieName = type === 'admin' ? 'haku_admin_session' : 'haku_session';
  res.setHeader('Set-Cookie', `${cookieName}=${value}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}${secureCookie ? '; Secure' : ''}`);
  return csrf;
}

function clearSession(res, req, type = 'user') {
  const current = getSession(req, type);
  if (current) sessions.delete(current.id);
  const cookieName = type === 'admin' ? 'haku_admin_session' : 'haku_session';
  res.setHeader('Set-Cookie', `${cookieName}=; Path=/; HttpOnly; SameSite=${cookieSameSite}; Max-Age=0${secureCookie ? '; Secure' : ''}`);
}

function getSession(req, type = 'user') {
  const cookieName = type === 'admin' ? 'haku_admin_session' : 'haku_session';
  const value = parseCookies(req.headers.cookie)[cookieName];
  if (!value) return null;
  const dot = value.lastIndexOf('.');
  if (dot < 1) return null;
  const id = value.slice(0, dot);
  const mac = value.slice(dot + 1);
  if (!safeEqual(mac, signature(id))) return null;
  const session = sessions.get(id);
  if (!session || session.type !== type || session.expiresAt < Date.now()) { sessions.delete(id); return null; }
  return { id, ...session };
}

function setCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const allowed = allowedOrigins.has(origin);
  if (!allowed) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  return true;
}

function json(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extraHeaders });
  res.end(body);
}

async function readJson(req, maxBytes = 32_768) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('Request too large'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON body'), { status: 400 }); }
}

function clientIp(req) {
  let address = req.socket.remoteAddress || 'unknown';
  if (trustProxy && typeof req.headers['x-forwarded-for'] === 'string') address = req.headers['x-forwarded-for'].split(',').at(-1).trim() || address;
  return address;
}

function rateLimit(req, key, maximum, windowMs = RATE_WINDOW_MS) {
  const address = clientIp(req);
  const bucketKey = `${key}:${address}`;
  const now = Date.now();
  const bucket = attempts.get(bucketKey);
  if (!bucket || bucket.resetAt <= now) { attempts.set(bucketKey, { count: 1, resetAt: now + windowMs }); return true; }
  bucket.count += 1;
  return bucket.count <= maximum;
}

function rateLimitCount(req, key) {
  return attempts.get(`${key}:${clientIp(req)}`)?.count || 0;
}

function csrfValid(req, session) {
  const sent = req.headers['x-csrf-token'];
  return typeof sent === 'string' && safeEqual(sent, session.csrf);
}

function rememberWebhookUpdate(updateId) {
  if (webhookUpdateIds.has(updateId)) return false;
  webhookUpdateIds.add(updateId);
  webhookUpdateOrder.push(updateId);
  if (webhookUpdateOrder.length > 1000) webhookUpdateIds.delete(webhookUpdateOrder.shift());
  return true;
}

function allowWelcomeReply(chatId) {
  const now = Date.now();
  const key = createHmac('sha256', sessionSecret).update('welcome-rate:' + String(chatId)).digest('base64url');
  const recent = (welcomeReplyTimes.get(key) || []).filter((timestamp) => now - timestamp < 60_000);
  if (recent.length >= 5) { welcomeReplyTimes.set(key, recent); return false; }
  recent.push(now);
  welcomeReplyTimes.set(key, recent);
  return true;
}

async function sendWelcomeReply(bot, chatId, locale) {
  try {
    const response = await fetch(telegramApiBase + '/bot' + bot.token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: BOT_COPY[locale].welcome,
        reply_markup: {
          inline_keyboard: [[{ text: BOT_COPY[locale].button, web_app: { url: publicOrigin } }]]
        }
      }),
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) {
      const error = new Error();
      error.name = 'TelegramApiError';
      throw error;
    }
    const result = await response.json();
    if (result?.ok !== true) {
      const error = new Error();
      error.name = 'TelegramApiError';
      throw error;
    }
  } catch (error) {
    console.warn('Telegram welcome reply failed', bot.id, error?.name || 'Error');
  }
}

function verifyInitData(initData) {
  if (typeof initData !== 'string' || initData.length < 20 || initData.length > 16_384) return null;
  const params = new URLSearchParams(initData);
  const entries = [...params.entries()];
  if (new Set(entries.map(([key]) => key)).size !== entries.length) return null;
  const hash = params.get('hash');
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) return null;
  const authDate = Number(params.get('auth_date'));
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(authDate) || authDate > now + 30 || now - authDate > maxAuthAge) return null;
  const dataCheckString = entries.filter(([key]) => key !== 'hash').sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join('\n');
  const received = Buffer.from(hash, 'hex');
  const matches = [];
  for (const bot of bots) {
    if (!bot.active) continue;
    const secretKey = createHmac('sha256', 'WebAppData').update(bot.token).digest();
    const expected = createHmac('sha256', secretKey).update(dataCheckString).digest();
    if (received.length === expected.length && timingSafeEqual(received, expected)) matches.push(bot);
  }
  if (matches.length !== 1) return null;
  let user;
  try { user = JSON.parse(params.get('user') || 'null'); } catch { return null; }
  if (!user || !Number.isSafeInteger(user.id) || user.id < 1) return null;
  return { userId: String(user.id), bot: matches[0] };
}

function requireAdmin(req, res) {
  const session = getSession(req, 'admin');
  if (!session || session.type !== 'admin') { json(res, 401, { error: 'admin_session_required' }); return null; }
  return session;
}

function statsDateParts(date, formatter = statsDateFormatter) {
  return Object.fromEntries(formatter.formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}

function statsDateKey(date) {
  const parts = statsDateParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addDaysToDateKey(dateKey, days) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function statsDateStartUtc(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const targetLocalAsUtc = Date.UTC(year, month - 1, day);
  let guess = targetLocalAsUtc;
  for (let i = 0; i < 4; i++) {
    const parts = statsDateParts(new Date(guess), statsDateTimeFormatter);
    const observedLocalAsUtc = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second)
    );
    const adjustment = targetLocalAsUtc - observedLocalAsUtc;
    if (!adjustment) break;
    guess += adjustment;
  }
  return new Date(guess).toISOString();
}

function overview() {
  const now = new Date();
  const today = statsDateKey(now);
  const dailyDates = Array.from({ length: 7 }, (_, index) => addDaysToDateKey(today, index - 6));
  const start = statsDateStartUtc(dailyDates[0]);
  const end = statsDateStartUtc(addDaysToDateKey(today, 1));
  const totalUsers = Number(db.prepare('SELECT COUNT(*) AS n FROM users').get().n);
  const recentUsers = db.prepare('SELECT first_seen FROM users WHERE first_seen >= ? AND first_seen < ?').all(start, end);
  const newUsers7d = recentUsers.length;
  const consentedUsers = Number(db.prepare('SELECT COUNT(*) AS n FROM users WHERE consent_at IS NOT NULL').get().n);
  const consentRate = totalUsers ? Math.round(consentedUsers / totalUsers * 100) : 0;
  const daily = new Map(dailyDates.map((date) => [date, 0]));
  for (const row of recentUsers) {
    const date = statsDateKey(new Date(row.first_seen));
    if (daily.has(date)) daily.set(date, daily.get(date) + 1);
  }
  const dailyNewUsers = dailyDates.map((date) => daily.get(date) || 0);
  const userRows = db.prepare('SELECT telegram_id, locale, source_bot_id, first_seen, consent_at FROM users ORDER BY first_seen DESC LIMIT 200').all();
  const botById = new Map(bots.map((bot) => [bot.id, bot]));
  const users = userRows.map((row) => ({
    id: row.telegram_id,
    bot: botById.get(row.source_bot_id)?.name || row.source_bot_id,
    locale: row.locale,
    date: row.first_seen.slice(0, 10),
    consent: Boolean(row.consent_at)
  }));
  return {
    metrics: { totalUsers, newUsers7d, consentRate },
    dailyNewUsers,
    dailyDates,
    users,
    bots: bots.map(({ id, name, handle, role, active }) => ({ id, name, handle, role, active })),
    csrfToken: null
  };
}

const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  const url = new URL(req.url || '/', 'http://localhost');
  const path = url.pathname;
  if (adminOriginUrl && path.startsWith('/api/admin/') && String(req.headers.host || '').toLowerCase() !== adminOriginUrl.host.toLowerCase()) {
    return json(res, 404, { error: 'not_found' });
  }
  if (!setCors(req, res)) return json(res, 403, { error: 'origin_not_allowed' });
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (path.startsWith('/api/admin/') && !['GET', 'HEAD'].includes(req.method) &&
      path !== '/api/admin/login' && path !== '/api/admin/logout') {
    const session = requireAdmin(req, res);
    if (!session) return;
    if (session.role !== 'owner') return json(res, 403, { error: 'owner_role_required' });
    if (!csrfValid(req, session)) return json(res, 403, { error: 'csrf_invalid' });
  }

  try {
    if (path === '/api/health' && ['GET', 'HEAD'].includes(req.method)) return json(res, 200, { ok: true });

    const assetRoute = path.match(/^\/assets\/([a-z0-9-]+\.(?:webp|png))$/);
    if (assetRoute && ['GET', 'HEAD'].includes(req.method)) {
      let asset;
      try { asset = readFileSync(resolve(ROOT, 'public', 'assets', assetRoute[1])); }
      catch { return json(res, 404, { error: 'not_found' }); }
      const contentType = assetRoute[1].endsWith('.webp') ? 'image/webp' : 'image/png';
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=604800' });
      return res.end(req.method === 'HEAD' ? undefined : asset);
    }

    const webhookRoute = path.match(/^\/api\/telegram\/webhook\/([a-zA-Z0-9_-]{2,64})$/);
    if (webhookRoute && req.method === 'POST') {
      const botId = webhookRoute[1];
      const bot = bots.find((item) => item.id === botId && item.active);
      if (!bot) return json(res, 404, { error: 'bot_not_found' });
      const suppliedSecret = req.headers['x-telegram-bot-api-secret-token'];
      if (typeof suppliedSecret !== 'string' || !safeEqual(suppliedSecret, signature('webhook:' + botId))) {
        return json(res, 401, { error: 'webhook_secret_invalid' });
      }
      const update = await readJson(req, 64 * 1024);
      if (!update || !Number.isSafeInteger(update.update_id)) return json(res, 200, { ok: true });
      if (!rememberWebhookUpdate(update.update_id)) return json(res, 200, { ok: true });
      const message = update.message;
      const text = typeof message?.text === 'string' ? message.text : '';
      if (message?.chat?.type !== 'private' || !message.chat.id ||
          !(text === '/start' || text.startsWith('/start ') || text.startsWith('/start@'))) {
        return json(res, 200, { ok: true });
      }
      if (!allowWelcomeReply(message.chat.id)) return json(res, 200, { ok: true });
      const language = typeof message.from?.language_code === 'string'
        ? message.from.language_code.toLowerCase().split(/[-_]/)[0]
        : 'en';
      const locale = Object.hasOwn(BOT_COPY, language) ? language : 'en';
      json(res, 200, { ok: true });
      setImmediate(() => { void sendWelcomeReply(bot, message.chat.id, locale); });
      return;
    }

    if (path === '/api/telegram/auth' && req.method === 'POST') {
      if (!rateLimit(req, 'telegram-auth', 40, 5 * 60 * 1000)) return json(res, 429, { error: 'rate_limited' });
      const body = await readJson(req);
      const verified = verifyInitData(body.initData);
      if (!verified) return json(res, 401, { error: 'telegram_auth_invalid' });
      db.prepare('UPDATE users SET last_seen = ? WHERE telegram_id = ?').run(new Date().toISOString(), verified.userId);
      const csrfToken = issueSession(res, { type: 'user', telegramId: verified.userId, botId: verified.bot.id });
      return json(res, 200, {
        user: { id: verified.userId },
        botName: verified.bot.name,
        csrfToken
      });
    }

    if (path === '/api/telegram/consent' && req.method === 'POST') {
      const session = getSession(req);
      if (!session || session.type !== 'user') return json(res, 401, { error: 'telegram_session_required' });
      if (!csrfValid(req, session)) return json(res, 403, { error: 'csrf_invalid' });
      const body = await readJson(req, 4096);
      if (body.accepted !== true) return json(res, 400, { error: 'consent_required' });
      if (!['en', 'km', 'th', 'zh'].includes(body.locale)) return json(res, 400, { error: 'locale_invalid' });
      const timestamp = new Date().toISOString();
      userUpsert.run(session.telegramId, body.locale, session.botId, timestamp, timestamp, timestamp, consentVersion);
      return json(res, 200, { saved: true, botName: bots.find((bot) => bot.id === session.botId)?.name || session.botId });
    }

    if (path === '/api/telegram/account' && req.method === 'GET') {
      const session = getSession(req);
      if (!session || session.type !== 'user') return json(res, 401, { error: 'telegram_session_required' });
      const account = db.prepare(`SELECT telegram_id, locale, source_bot_id, first_seen, last_seen, consent_at, consent_version
        FROM users WHERE telegram_id = ?`).get(session.telegramId);
      if (!account) return json(res, 404, { error: 'account_not_found' });
      writeAudit(null, 'account_export', 'self-service-account', clientIp(req));
      return json(res, 200, account);
    }

    if (path === '/api/telegram/account/delete' && req.method === 'POST') {
      const session = getSession(req);
      if (!session || session.type !== 'user') return json(res, 401, { error: 'telegram_session_required' });
      if (!csrfValid(req, session)) return json(res, 403, { error: 'csrf_invalid' });
      db.prepare('DELETE FROM users WHERE telegram_id = ?').run(session.telegramId);
      return json(res, 200, { deleted: true });
    }

    if (path === '/api/admin/session' && req.method === 'GET') {
      return json(res, 200, { authenticated: Boolean(getSession(req, 'admin')) });
    }

    if (path === '/api/admin/login' && req.method === 'POST') {
      if (!rateLimit(req, 'admin-login', ADMIN_LOGIN_MAX_ATTEMPTS)) {
        // Record only the first blocked attempt per address and window so a flood cannot grow audit_log.
        if (rateLimitCount(req, 'admin-login') === ADMIN_LOGIN_MAX_ATTEMPTS + 1) {
          writeAudit(null, 'admin_login_rate_limited', null, clientIp(req));
        }
        return json(res, 429, { error: 'rate_limited' });
      }
      const body = await readJson(req, 4096);
      const usernameInput = typeof body?.username === 'string' ? body.username.trim() : '';
      const username = /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,31}$/.test(usernameInput) ? usernameInput.toLowerCase() : '';
      const password = typeof body?.password === 'string' ? body.password : '';
      const admin = db.prepare('SELECT id, username, password_hash, role, disabled FROM admins WHERE username = ? COLLATE NOCASE').get(username);
      const passwordValid = verifyAdminPassword(password, admin?.password_hash || dummyAdminPasswordHash);
      let authenticatedAdmin = admin;
      if (!admin && username === 'owner' && db.prepare('SELECT COUNT(*) AS count FROM admins').get().count === 0 &&
          legacyAdminPassword.length >= 16 && !/replace-with/i.test(legacyAdminPassword) && safeEqual(password, legacyAdminPassword)) {
        const migrated = { id: randomBytes(16).toString('hex'), username: 'owner', role: 'owner' };
        db.prepare('INSERT INTO admins (id, username, password_hash, role, created_at, disabled) VALUES (?, ?, ?, ?, ?, 0)')
          .run(migrated.id, migrated.username, hashAdminPassword(password), migrated.role, new Date().toISOString());
        authenticatedAdmin = migrated;
      }
      if (!authenticatedAdmin || authenticatedAdmin.disabled || (!passwordValid && authenticatedAdmin === admin)) {
        writeAudit(admin?.id || null, 'admin_login_failed', username || null, clientIp(req));
        return json(res, 401, { error: 'admin_login_invalid' });
      }
      const csrfToken = issueSession(res, {
        type: 'admin', adminId: authenticatedAdmin.id,
        username: authenticatedAdmin.username, role: authenticatedAdmin.role
      });
      writeAudit(authenticatedAdmin.id, 'admin_login_success', authenticatedAdmin.username, clientIp(req));
      return json(res, 200, {
        authenticated: true,
        csrfToken,
        admin: { id: authenticatedAdmin.id, username: authenticatedAdmin.username, role: authenticatedAdmin.role }
      });
    }

    if (path === '/api/admin/logout' && req.method === 'POST') {
      const session = requireAdmin(req, res);
      if (!session) return;
      if (!csrfValid(req, session)) return json(res, 403, { error: 'csrf_invalid' });
      writeAudit(session.adminId, 'admin_logout', session.username, clientIp(req));
      clearSession(res, req, 'admin');
      return json(res, 200, { loggedOut: true });
    }

    if (path === '/api/admin/overview' && req.method === 'GET') {
      const session = requireAdmin(req, res);
      if (!session) return;
      const data = overview();
      data.csrfToken = session.csrf;
      return json(res, 200, data);
    }

    if (path === '/' && req.method === 'GET') {
      const html = readFileSync(resolve(ROOT, 'haku.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }
    return json(res, 404, { error: 'not_found' });
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 500;
    if (status >= 500) console.error('Request failed:', req.method, path, error.message);
    return json(res, status, { error: status >= 500 ? 'server_error' : error.message });
  }
});

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 4173);
server.listen(port, host, () => {
  console.log(`Haku listening on http://${host}:${port}`);
  console.log(`Configured active Bots: ${bots.filter((bot) => bot.active).length}/${bots.length}`);
});

function close() {
  server.close(() => { db.close(); process.exit(0); });
}
process.on('SIGINT', close);
process.on('SIGTERM', close);
