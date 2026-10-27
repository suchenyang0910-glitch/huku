import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CADDY_IMAGE = 'caddy:2.8.4';
const APP_PORT = 4173;
const CADDY_PORT = 18443;
const CONTAINER = `haku-caddy-test-${process.pid}`;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let tempDir;
let server;
let containerStarted = false;
let serverOutput = '';

function runSync(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return result;
}

function portIsFree(port) {
  return new Promise((resolveFree) => {
    const probe = createServer();
    probe.once('error', () => resolveFree(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolveFree(true)));
  });
}

async function ensurePortFree(port) {
  assert.equal(await portIsFree(port), true, `127.0.0.1:${port} must be free for this test`);
}

async function waitForApp() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`server.mjs exited during startup: ${serverOutput}`);
    try {
      const response = await fetch(`http://127.0.0.1:${APP_PORT}/api/health`);
      if (response.status === 200) return;
    } catch {}
    await sleep(100);
  }
  throw new Error(`server.mjs did not become healthy: ${serverOutput}`);
}

function curl(method, path, { headers = [], body } = {}) {
  const headerFile = join(tempDir, 'response.headers');
  const bodyFile = join(tempDir, 'response.body');
  const args = ['-k', '-sS', '-D', headerFile, '-o', bodyFile, '-w', '%{http_code}', '-X', method];
  for (const header of headers) args.push('-H', header);
  if (body !== undefined) args.push('--data-binary', body);
  args.push(`https://127.0.0.1:${CADDY_PORT}${path}`);
  const result = runSync('curl', args);
  return {
    status: Number(result.stdout.trim()),
    headers: readFileSync(headerFile, 'utf8'),
    body: readFileSync(bodyFile, 'utf8')
  };
}

async function cleanup() {
  if (containerStarted) runSync('docker', ['rm', '-f', CONTAINER], { allowFailure: true });
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise((resolveExit) => server.once('exit', resolveExit));
  }
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
}

async function main() {
  assert.equal(process.platform, 'linux', 'Docker host networking is required; run this test on Linux');
  assert.ok(process.versions.node.split('.')[0] >= 25, 'Node.js 25.7 or newer is required');
  assert.ok(Number(process.versions.node.split('.')[1]) >= 7 || Number(process.versions.node.split('.')[0]) > 25,
    'Node.js 25.7 or newer is required');
  runSync('docker', ['info']);
  runSync('openssl', ['version']);
  runSync('curl', ['--version']);
  await ensurePortFree(APP_PORT);
  await ensurePortFree(CADDY_PORT);

  tempDir = await mkdtemp(join(tmpdir(), 'haku-caddy-test-'));
  const certDir = join(tempDir, 'certs');
  await mkdir(certDir);
  const cert = join(certDir, 'truesignal-origin.pem');
  const key = join(certDir, 'truesignal-origin.key');
  runSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', key, '-out', cert, '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'
  ]);

  runSync('docker', ['image', 'inspect', CADDY_IMAGE], { allowFailure: true }).status === 0 || runSync('docker', ['pull', CADDY_IMAGE]);
  const gatewayResult = runSync('docker', ['network', 'inspect', 'bridge', '--format', '{{range .IPAM.Config}}{{.Gateway}}{{end}}']);
  const gateway = gatewayResult.stdout.trim();
  assert.ok(gateway, 'Docker bridge gateway must be available');

  runSync('docker', [
    'run', '--rm', '-v', `${ROOT}/deploy/Caddyfile.example:/etc/caddy/Caddyfile:ro`,
    '-v', `${certDir}:/etc/caddy/certs:ro`, CADDY_IMAGE,
    'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'
  ]);
  console.log(`PASS: ${CADDY_IMAGE} validates deploy/Caddyfile.example with a temporary certificate.`);

  const testConfig = `{
    admin localhost:20199
    servers {
        trusted_proxies static 127.0.0.1/32 ${gateway}/32 173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22 2400:cb00::/32 2606:4700::/32 2803:f800::/32 2405:b500::/32 2405:8100::/32 2a06:98c0::/29 2c0f:f248::/32
        client_ip_headers CF-Connecting-IP
    }
}

https://127.0.0.1:${CADDY_PORT} {
    tls /etc/caddy/certs/truesignal-origin.pem /etc/caddy/certs/truesignal-origin.key
    encode zstd gzip

    handle /api/* {
        reverse_proxy 127.0.0.1:${APP_PORT} {
            header_up X-Forwarded-For {client_ip}
            header_up X-Forwarded-Proto https
        }
    }

    handle {
        root * /var/www/truesignal/current
        header {
            Content-Security-Policy "default-src 'self'; img-src 'self'; font-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
            X-Content-Type-Options nosniff
            Referrer-Policy strict-origin-when-cross-origin
        }
        @html path / /index.html /zh/ /zh/index.html /privacy/ /privacy/index.html /404.html
        header @html Cache-Control "public, max-age=300"
        @assets path_regexp assets \\.(woff2|webp|png|jpe?g|ico|svg)$
        header @assets Cache-Control "public, max-age=604800"
        file_server
    }

    handle_errors 404 {
        rewrite /404.html
        file_server
    }
}
`;
  const testConfigPath = join(tempDir, 'Caddyfile.test');
  await writeFile(testConfigPath, testConfig, 'utf8');

  const botToken = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  server = spawn(process.execPath, [join(ROOT, 'server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(APP_PORT),
      HAKU_PUBLIC_ORIGIN: `http://127.0.0.1:${APP_PORT}`,
      HAKU_ALLOWED_ORIGINS: `http://127.0.0.1:${APP_PORT}`,
      HAKU_TRUSTED_PROXY: 'true',
      HAKU_SESSION_SECRET: (await import('node:crypto')).randomBytes(32).toString('base64url'),
      HAKU_DB_PATH: join(tempDir, 'haku.sqlite'),
      HAKU_CONSENT_VERSION: 'caddy-test-v1',
      HAKU_BOTS_JSON: JSON.stringify([{
        id: 'caddy-test', name: 'Caddy Test', handle: '@caddy_test', token: botToken, role: 'Mini App', active: true
      }])
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  server.stdout.setEncoding('utf8').on('data', (chunk) => { serverOutput += chunk; });
  server.stderr.setEncoding('utf8').on('data', (chunk) => { serverOutput += chunk; });
  await waitForApp();

  runSync('docker', [
    'run', '-d', '--rm', '--name', CONTAINER, '--network', 'host',
    '-v', `${testConfigPath}:/etc/caddy/Caddyfile:ro`,
    '-v', `${certDir}:/etc/caddy/certs:ro`,
    '-v', `${ROOT}/site/dist:/var/www/truesignal/current:ro`,
    CADDY_IMAGE, 'run', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'
  ]);
  containerStarted = true;

  let caddyReady = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = runSync('curl', ['-k', '-sS', '-o', '/dev/null', '-w', '%{http_code}', `https://127.0.0.1:${CADDY_PORT}/api/health`], { allowFailure: true });
    if (result.status === 0 && result.stdout.trim() === '200') { caddyReady = true; break; }
    const alive = runSync('docker', ['inspect', CONTAINER], { allowFailure: true });
    if (alive.status !== 0) throw new Error('Test Caddy exited before becoming ready.');
    await sleep(100);
  }
  assert.equal(caddyReady, true, 'test Caddy should answer /api/health');

  const loginStatus = (ip) => curl('POST', '/api/admin/login', {
    headers: [`CF-Connecting-IP: ${ip}`, 'X-Forwarded-For: 1.2.3.4', 'Content-Type: application/json'],
    body: '{"username":"missing-user","password":"wrong-password"}'
  }).status;
  for (let attempt = 1; attempt <= 8; attempt += 1) assert.equal(loginStatus('203.0.113.7'), 401);
  assert.equal(loginStatus('203.0.113.7'), 429, 'the ninth failure for one visitor should be rate limited');
  assert.equal(loginStatus('203.0.113.8'), 401, 'another visitor must not inherit the first visitor rate limit');
  console.log('PASS: Caddy replaces spoofed X-Forwarded-For with one trusted CF-Connecting-IP value.');

  for (const path of ['/', '/zh/', '/privacy/']) {
    const response = curl('GET', path);
    assert.equal(response.status, 200, `${path} should return 200`);
    assert.match(response.headers, /content-security-policy:\s*default-src 'self'/i, `${path} should include CSP`);
  }

  const missing = curl('GET', '/route-that-does-not-exist');
  assert.equal(missing.status, 404, 'unknown routes retain the 404 status');
  assert.equal(missing.body, await readFile(join(ROOT, 'site/dist/404.html'), 'utf8'), 'unknown routes serve 404.html');
  assert.equal(curl('HEAD', '/api/health').status, 200, 'HEAD health check should return 200');
  console.log('PASS: static routes, CSP, 404 status/body, and HEAD health check.');
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  if (serverOutput) console.error(serverOutput);
  process.exitCode = 1;
} finally {
  await cleanup();
}

