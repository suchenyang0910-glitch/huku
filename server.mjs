import { createServer } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = dirname(fileURLToPath(import.meta.url));
loadEnv(resolve(ROOT, '.env'));

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
const adminPassword = required('HAKU_ADMIN_PASSWORD', 16);
if (/replace-with/i.test(sessionSecret) || /replace-with/i.test(adminPassword)) throw new Error('Replace the example session secret and admin password before starting');
const consentVersion = required('HAKU_CONSENT_VERSION', 1);
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
const allowedOrigins = new Set([publicOrigin, ...(process.env.HAKU_ALLOWED_ORIGINS || '').split(',').map((origin) => origin.trim())].filter(Boolean));
const secureCookie = process.env.NODE_ENV === 'production' || cookieSameSite === 'none';
const trustProxy = process.env.HAKU_TRUSTED_PROXY === 'true';
const sessions = new Map();
const attempts = new Map();
const SESSION_MS = 12 * 60 * 60 * 1000;
const ADMIN_SESSION_MS = 8 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 15 * 60 * 1000;

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
    if (index > 0) out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

function issueSession(res, { type, telegramId = null, botId = null }) {
  const id = randomBytes(32).toString('base64url');
  const csrf = randomBytes(24).toString('base64url');
  const now = Date.now();
  sessions.set(id, { type, telegramId, botId, csrf, expiresAt: now + (type === 'admin' ? ADMIN_SESSION_MS : SESSION_MS) });
  const value = `${id}.${signature(id)}`;
  const maxAge = type === 'admin' ? 8 * 60 * 60 : 12 * 60 * 60;
  const sameSite = cookieSameSite[0].toUpperCase() + cookieSameSite.slice(1);
  res.setHeader('Set-Cookie', `haku_session=${value}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}${secureCookie ? '; Secure' : ''}`);
  return csrf;
}

function clearSession(res, req) {
  const current = getSession(req);
  if (current) sessions.delete(current.id);
  res.setHeader('Set-Cookie', `haku_session=; Path=/; HttpOnly; SameSite=${cookieSameSite}; Max-Age=0${secureCookie ? '; Secure' : ''}`);
}

function getSession(req) {
  const value = parseCookies(req.headers.cookie).haku_session;
  if (!value) return null;
  const dot = value.lastIndexOf('.');
  if (dot < 1) return null;
  const id = value.slice(0, dot);
  const mac = value.slice(dot + 1);
  if (!safeEqual(mac, signature(id))) return null;
  const session = sessions.get(id);
  if (!session || session.expiresAt < Date.now()) { sessions.delete(id); return null; }
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

function rateLimit(req, key, maximum, windowMs = RATE_WINDOW_MS) {
  let address = req.socket.remoteAddress || 'unknown';
  if (trustProxy && typeof req.headers['x-forwarded-for'] === 'string') address = req.headers['x-forwarded-for'].split(',').at(-1).trim() || address;
  const bucketKey = `${key}:${address}`;
  const now = Date.now();
  const bucket = attempts.get(bucketKey);
  if (!bucket || bucket.resetAt <= now) { attempts.set(bucketKey, { count: 1, resetAt: now + windowMs }); return true; }
  bucket.count += 1;
  return bucket.count <= maximum;
}

function csrfValid(req, session) {
  const sent = req.headers['x-csrf-token'];
  return typeof sent === 'string' && safeEqual(sent, session.csrf);
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
  const session = getSession(req);
  if (!session || session.type !== 'admin') { json(res, 401, { error: 'admin_session_required' }); return null; }
  return session;
}

function overview() {
  const now = new Date();
  const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const totalUsers = Number(db.prepare('SELECT COUNT(*) AS n FROM users').get().n);
  const newUsers7d = Number(db.prepare('SELECT COUNT(*) AS n FROM users WHERE first_seen >= ?').get(cutoff).n);
  const consentedUsers = Number(db.prepare('SELECT COUNT(*) AS n FROM users WHERE consent_at IS NOT NULL').get().n);
  const consentRate = totalUsers ? Math.round(consentedUsers / totalUsers * 100) : 0;
  const daily = new Map(db.prepare("SELECT substr(first_seen, 1, 10) AS day, COUNT(*) AS n FROM users WHERE first_seen >= ? GROUP BY day").all(cutoff).map((row) => [row.day, Number(row.n)]));
  const dailyNewUsers = [];
  const dailyDates = [];
  for (let offset = 6; offset >= 0; offset--) {
    const date = new Date(now.getTime() - offset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    dailyDates.push(date);
    dailyNewUsers.push(daily.get(date) || 0);
  }
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
  if (!setCors(req, res)) return json(res, 403, { error: 'origin_not_allowed' });
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url || '/', 'http://localhost');
  const path = url.pathname;

  try {
    if (path === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true });

    if (path === '/api/telegram/auth' && req.method === 'POST') {
      if (!rateLimit(req, 'telegram-auth', 40, 5 * 60 * 1000)) return json(res, 429, { error: 'rate_limited' });
      const body = await readJson(req);
      const verified = verifyInitData(body.initData);
      if (!verified) return json(res, 401, { error: 'telegram_auth_invalid' });
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

    if (path === '/api/admin/login' && req.method === 'POST') {
      if (!rateLimit(req, 'admin-login', 8)) return json(res, 429, { error: 'rate_limited' });
      const body = await readJson(req, 4096);
      if (typeof body.password !== 'string' || !safeEqual(body.password, adminPassword)) return json(res, 401, { error: 'admin_login_invalid' });
      const csrfToken = issueSession(res, { type: 'admin' });
      return json(res, 200, { authenticated: true, csrfToken });
    }

    if (path === '/api/admin/logout' && req.method === 'POST') {
      const session = requireAdmin(req, res);
      if (!session) return;
      if (!csrfValid(req, session)) return json(res, 403, { error: 'csrf_invalid' });
      clearSession(res, req);
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
