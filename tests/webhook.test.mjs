import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { BOT_COPY } from '../bot-copy.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const secret = randomBytes(32).toString('base64url');
const tokens = {
  'bot-main': '123456:' + randomBytes(24).toString('base64url'),
  'bot-khmer': '654321:' + randomBytes(24).toString('base64url'),
  'bot-paused': '777777:' + randomBytes(24).toString('base64url')
};
const bots = [
  { id: 'bot-main', name: 'Haku Main', token: tokens['bot-main'], active: true },
  { id: 'bot-khmer', name: 'Haku Khmer', token: tokens['bot-khmer'], active: true },
  { id: 'bot-paused', name: 'Haku Paused', token: tokens['bot-paused'], active: false }
];
const received = [];
let failNext = false;
const telegramApi = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let body = null;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
  received.push({ url: req.url, body });
  if (failNext) {
    failNext = false;
    res.writeHead(502, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false }));
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, result: { message_id: received.length } }));
});

function listen(server) {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolveListen(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}

function webhookSecret(botId) {
  return createHmac('sha256', secret).update('webhook:' + botId).digest('base64url');
}

function update(updateId, chatId, text, language = 'en', chatType = 'private') {
  return {
    update_id: updateId,
    message: {
      text,
      chat: { id: chatId, type: chatType },
      from: { id: chatId, language_code: language }
    }
  };
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
async function waitForRequestCount(count, timeoutMs = 3000) {
  const started = Date.now();
  while (received.length < count && Date.now() - started < timeoutMs) await sleep(10);
  assert.equal(received.length, count, 'waited for Telegram API request count');
}

let tempDir;
let serverProcess;
let stderr = '';
let stdout = '';
let appPort;
let apiPort;
const childEnv = { ...process.env };

try {
  tempDir = await mkdtemp(join(tmpdir(), 'haku-webhook-test-'));
  apiPort = await listen(telegramApi);
  appPort = await new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close((error) => error ? reject(error) : resolvePort(port));
    });
  });

  Object.assign(childEnv, {
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: String(appPort),
    HAKU_PUBLIC_ORIGIN: 'https://mini.example.test',
    HAKU_ALLOWED_ORIGINS: 'https://mini.example.test',
    HAKU_COOKIE_SAMESITE: 'lax',
    HAKU_SESSION_SECRET: secret,
    HAKU_ADMIN_PASSWORD: 'test-' + randomBytes(18).toString('base64url'),
    HAKU_DB_PATH: join(tempDir, 'haku.sqlite'),
    HAKU_CONSENT_VERSION: 'webhook-test',
    HAKU_BOTS_JSON: JSON.stringify(bots),
    HAKU_TELEGRAM_API_BASE: 'http://127.0.0.1:' + apiPort
  });

  serverProcess = spawn(process.execPath, [join(ROOT, 'server.mjs')], { cwd: ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  serverProcess.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  serverProcess.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });

  let ready = false;
  const readyAt = Date.now();
  while (!ready && Date.now() - readyAt < 8000) {
    if (serverProcess.exitCode !== null) throw new Error('server.mjs exited during startup: ' + stderr);
    try {
      const response = await fetch('http://127.0.0.1:' + appPort + '/api/health');
      ready = response.ok;
    } catch {}
    if (!ready) await sleep(50);
  }
  assert.equal(ready, true, 'server starts with temporary environment');

  async function post(botId, body, headerValue) {
    if (arguments.length < 3) headerValue = webhookSecret(botId);
    const headers = { 'Content-Type': 'application/json' };
    if (headerValue !== undefined) headers['X-Telegram-Bot-Api-Secret-Token'] = headerValue;
    const response = await fetch('http://127.0.0.1:' + appPort + '/api/telegram/webhook/' + botId, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  }

  assert.equal((await post('bot-main', update(1, 11, '/start'), null)).status, 401, 'missing secret is rejected');
  assert.equal((await post('bot-main', update(2, 12, '/start'), 'wrong-secret')).status, 401, 'wrong secret is rejected');
  assert.equal(received.length, 0, 'unauthorized webhooks never call Telegram');
  assert.equal((await post('missing-bot', update(3, 13, '/start'), webhookSecret('missing-bot'))).status, 404, 'unknown Bot is rejected');
  assert.equal((await post('bot-paused', update(4, 14, '/start'), webhookSecret('bot-paused'))).status, 404, 'inactive Bot is rejected');
  assert.equal(received.length, 0, 'unknown or inactive Bots never call Telegram');

  let response = await post('bot-main', update(10, 110, '/start', 'km'));
  assert.deepEqual({ status: response.status, body: response.body }, { status: 200, body: { ok: true } });
  await waitForRequestCount(1);
  assert.equal(received[0].body.text, BOT_COPY.km.welcome);
  assert.deepEqual(received[0].body.reply_markup, {
    inline_keyboard: [[{ text: BOT_COPY.km.button, web_app: { url: 'https://mini.example.test' } }]]
  });
  assert.equal(received[0].body.chat_id, 110);
  assert.equal(Object.hasOwn(received[0].body, 'parse_mode'), false);

  await post('bot-main', update(11, 111, '/start', 'vi'));
  await waitForRequestCount(2);
  assert.equal(received[1].body.text, BOT_COPY.vi.welcome);
  await post('bot-main', update(12, 112, '/start', 'vi-VN'));
  await waitForRequestCount(3);
  assert.equal(received[2].body.text, BOT_COPY.vi.welcome);
  await post('bot-main', update(13, 113, '/start', 'zh-hans'));
  await waitForRequestCount(4);
  assert.equal(received[3].body.text, BOT_COPY.zh.welcome);
  await post('bot-main', update(14, 114, '/start', 'fr'));
  await waitForRequestCount(5);
  assert.equal(received[4].body.text, BOT_COPY.en.welcome);
  await post('bot-main', update(15, 115, '/start abc'));
  await waitForRequestCount(6);
  await post('bot-main', update(16, 116, '/start@HakuStoryBot'));
  await waitForRequestCount(7);

  assert.equal((await post('bot-main', update(17, 117, '/start', 'en', 'group'))).status, 200);
  assert.equal((await post('bot-main', update(18, 118, 'hello'))).status, 200);
  assert.equal((await post('bot-main', { update_id: 19, edited_message: update(19, 119, '/start').message })).status, 200);
  await sleep(80);
  assert.equal(received.length, 7, 'group, ordinary text and non-message updates are ignored');

  const duplicate = update(20, 120, '/start');
  await post('bot-main', duplicate);
  await waitForRequestCount(8);
  await post('bot-main', duplicate);
  await sleep(80);
  assert.equal(received.length, 8, 'the same update_id is replied to once');

  for (let i = 0; i < 5; i++) await post('bot-main', update(30 + i, 777, '/start'));
  await waitForRequestCount(13);
  assert.equal((await post('bot-main', update(35, 777, '/start'))).status, 200);
  await sleep(100);
  assert.equal(received.length, 13, 'a chat receives at most five replies per minute');

  failNext = true;
  await post('bot-main', update(40, 440, '/start'));
  await sleep(150);
  assert.match(stderr, /bot-main TelegramApiError/);
  assert.equal(tokens && Object.values(tokens).some((token) => stderr.includes(token) || stdout.includes(token)), false, 'server logs never expose Bot tokens');

  const beforeDryRun = received.length;
  const dryRun = spawnSync(process.execPath, [join(ROOT, 'scripts', 'set-webhook.mjs'), '--dry-run'], {
    cwd: ROOT,
    env: childEnv,
    encoding: 'utf8'
  });
  assert.equal(dryRun.status, 0, 'webhook dry-run exits successfully: ' + dryRun.stderr);
  assert.ok(dryRun.stdout.includes('https://mini.example.test/api/telegram/webhook/bot-main'));
  assert.ok(dryRun.stdout.includes('https://mini.example.test/api/telegram/webhook/bot-khmer'));
  assert.equal(dryRun.stdout.includes('bot-paused'), false, 'dry-run skips inactive Bots');
  assert.equal(Object.values(tokens).some((token) => dryRun.stdout.includes(token) || dryRun.stderr.includes(token)), false, 'dry-run output contains no tokens');
  assert.equal(received.length, beforeDryRun, 'dry-run sends no Telegram API requests');

  const implicitDryRun = spawnSync(process.execPath, [join(ROOT, 'scripts', 'set-webhook.mjs'), '--dry-run'], {
    cwd: ROOT,
    env: { ...childEnv, HAKU_BOTS_JSON: JSON.stringify([{ id: 'bot-implicit', name: 'Haku Implicit', token: tokens['bot-main'] }, bots[2]]) },
    encoding: 'utf8'
  });
  assert.equal(implicitDryRun.status, 0, 'implicit-active dry-run exits successfully: ' + implicitDryRun.stderr);
  assert.ok(implicitDryRun.stdout.includes('https://mini.example.test/api/telegram/webhook/bot-implicit'),
    'a Bot without an active field is registered, matching the server');
  assert.equal(implicitDryRun.stdout.includes('bot-paused'), false, 'active:false Bots are still skipped');

  console.log('webhook.test.mjs: all assertions passed');
} finally {
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill('SIGTERM');
    await new Promise((resolveExit) => serverProcess.once('exit', resolveExit));
  }
  if (telegramApi.listening) await close(telegramApi);
  if (tempDir) {
    const tempRoot = resolve(tmpdir());
    const resolvedTemp = resolve(tempDir);
    if (resolvedTemp.startsWith(tempRoot + sep) && basename(resolvedTemp).startsWith('haku-webhook-test-')) {
      await rm(resolvedTemp, { recursive: true, force: true });
    }
  }
}
