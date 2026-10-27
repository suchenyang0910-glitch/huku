import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOT_COPY } from '../bot-copy.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
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

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--dry-run') || args.filter((arg) => arg === '--dry-run').length > 1) {
  console.error('Usage: node scripts/set-webhook.mjs [--dry-run]');
  process.exit(2);
}
const dryRun = args.includes('--dry-run');
const sessionSecret = process.env.HAKU_SESSION_SECRET?.trim();
if (!sessionSecret || sessionSecret.length < 32 || /replace-with/i.test(sessionSecret)) {
  throw new Error('HAKU_SESSION_SECRET must be set to at least 32 characters');
}

const publicOrigin = process.env.HAKU_PUBLIC_ORIGIN?.trim();
let originUrl;
try { originUrl = new URL(publicOrigin); } catch { throw new Error('HAKU_PUBLIC_ORIGIN must be a valid HTTPS origin'); }
if (originUrl.protocol !== 'https:' || originUrl.origin !== publicOrigin) {
  throw new Error('HAKU_PUBLIC_ORIGIN must be an HTTPS origin without a path');
}

let bots;
try { bots = JSON.parse(process.env.HAKU_BOTS_JSON || ''); }
catch { throw new Error('HAKU_BOTS_JSON must be a JSON array of Bot configurations'); }
if (!Array.isArray(bots)) throw new Error('HAKU_BOTS_JSON must be a JSON array of Bot configurations');
for (const bot of bots) {
  if (!bot || typeof bot.id !== 'string' || !/^[a-zA-Z0-9_-]{2,64}$/.test(bot.id)) throw new Error('Each Bot requires a safe id');
  if (typeof bot.token !== 'string' || !/^\d+:[A-Za-z0-9_-]{20,}$/.test(bot.token)) throw new Error('Each Bot requires a valid token');
}

const apiBase = (process.env.HAKU_TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
// Match server.mjs: a Bot is active unless it is explicitly disabled.
const activeBots = bots.filter((bot) => bot.active !== false);
let failed = false;

function webhookSecret(botId) {
  return createHmac('sha256', sessionSecret).update('webhook:' + botId).digest('base64url');
}

async function callTelegram(bot, method, payload) {
  const response = await fetch(apiBase + '/bot' + bot.token + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
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
}

for (const bot of activeBots) {
  const url = publicOrigin + '/api/telegram/webhook/' + bot.id;
  const actions = [
    ['setWebhook', { url, secret_token: webhookSecret(bot.id), allowed_updates: ['message'] }, url],
    ['setChatMenuButton', { menu_button: { type: 'web_app', text: BOT_COPY.en.button, web_app: { url: publicOrigin } } }],
    ['setMyName', { name: BOT_COPY.en.name }],
    ['setMyName[vi]', { name: BOT_COPY.vi.name, language_code: 'vi' }, null, 'setMyName'],
    ['setMyName[zh]', { name: BOT_COPY.zh.name, language_code: 'zh' }, null, 'setMyName'],
    ['setMyName[km]', { name: BOT_COPY.km.name, language_code: 'km' }, null, 'setMyName'],
    ['setMyName[th]', { name: BOT_COPY.th.name, language_code: 'th' }, null, 'setMyName'],
    ['setMyShortDescription', { short_description: BOT_COPY.en.shortDescription }],
    ['setMyShortDescription[vi]', { short_description: BOT_COPY.vi.shortDescription, language_code: 'vi' }, null, 'setMyShortDescription'],
    ['setMyShortDescription[zh]', { short_description: BOT_COPY.zh.shortDescription, language_code: 'zh' }, null, 'setMyShortDescription'],
    ['setMyShortDescription[km]', { short_description: BOT_COPY.km.shortDescription, language_code: 'km' }, null, 'setMyShortDescription'],
    ['setMyShortDescription[th]', { short_description: BOT_COPY.th.shortDescription, language_code: 'th' }, null, 'setMyShortDescription'],
    ['setMyDescription', { description: BOT_COPY.en.description }],
    ['setMyDescription[vi]', { description: BOT_COPY.vi.description, language_code: 'vi' }, null, 'setMyDescription'],
    ['setMyDescription[zh]', { description: BOT_COPY.zh.description, language_code: 'zh' }, null, 'setMyDescription'],
    ['setMyDescription[km]', { description: BOT_COPY.km.description, language_code: 'km' }, null, 'setMyDescription'],
    ['setMyDescription[th]', { description: BOT_COPY.th.description, language_code: 'th' }, null, 'setMyDescription']
  ];

  for (const [label, payload, displayUrl, methodOverride] of actions) {
    const method = methodOverride || label;
    if (dryRun) {
      console.log(bot.id + ' ' + label + ' ' + (displayUrl || '') + ' dry-run');
      continue;
    }
    try {
      await callTelegram(bot, method, payload);
      console.log(bot.id + ' ' + label + ' success');
    } catch (error) {
      failed = true;
      console.error(bot.id + ' ' + label + ' failed ' + (error?.name || 'Error'));
    }
  }
}

if (failed) process.exitCode = 1;
