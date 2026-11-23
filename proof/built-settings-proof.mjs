import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const [leg, source, output, ...extra] = process.argv.slice(2);
assert.ok(['base', 'candidate'].includes(leg) && source && output && !extra.length,
  'Usage: node built-settings-proof.mjs base|candidate SOURCE RESULT_DIR');
assert.equal(process.platform, 'linux', 'Run only in the disposable Linux proof container');
const root = fs.realpathSync(source);
const result = resolve(output);
const fixed = leg === 'candidate';
const cli = join(root, 'openclaw.mjs');
const uiRoot = join(root, 'dist/control-ui');
for (const file of [cli, join(uiRoot, 'index.html')]) fs.accessSync(file, fs.constants.R_OK);
assert.ok(['entry.js', 'entry.mjs'].some(name => fs.existsSync(join(root, 'dist', name))), 'Build the Gateway first');
const requireUi = createRequire(join(root, 'ui/package.json'));
const { chromium } = requireUi('playwright');
const { expect } = requireUi('playwright/test');
const owner = { owner: 'macos-app', displayName: 'OpenClaw.app',
  updateHint: 'Update OpenClaw.app to update this Gateway.' };
const marker = join(root, 'openclaw-install-owner.json');
const markerJson = { schemaVersion: 1, ...owner };
const images = ['settings', 'settings-recovery'].map(prefix => join(result, `${prefix}-${leg}.png`));
fs.mkdirSync(result, { recursive: true });
for (const file of images) assert.ok(!fs.existsSync(file), `Refusing to replace ${file}`);
process.umask(0o077);
const home = fs.mkdtempSync(join(tmpdir(), 'built-settings-'));
const state = join(home, '.openclaw');
const config = join(state, 'openclaw.json');
const env = { PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`, HOME: home,
  TMPDIR: join(home, 'tmp'), XDG_CACHE_HOME: join(home, 'cache'), XDG_CONFIG_HOME: join(home, 'config'),
  LANG: 'C.UTF-8', TZ: 'UTC', OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: config,
  OPENCLAW_SKIP_CHANNELS: '1', OPENCLAW_SKIP_PROVIDERS: '1', OPENCLAW_SKIP_GMAIL_WATCHER: '1',
  OPENCLAW_SKIP_CRON: '1', OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: '1', GIT_TERMINAL_PROMPT: '0' };
const groups = new Set();
let browser, ownMarker = false, cleanupTask, stage = 'setup';
function tell(message) { stage = message; console.log(`[${leg}] ${message}`); }
function signalGroup(pid, signal) {
  try { process.kill(-pid, signal); return true; }
  catch (err) { if (err.code !== 'ESRCH') throw err; return false; }
}
async function cleanup() {
  await browser?.close().catch(() => {});
  for (const pid of groups) signalGroup(pid, 'SIGTERM');
  const until = Date.now() + 5000;
  while ([...groups].some(pid => signalGroup(pid, 0)) && Date.now() < until) await sleep(100);
  for (const pid of groups) signalGroup(pid, 'SIGKILL');
  try { if (ownMarker) fs.unlinkSync(marker); }
  finally { fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 }); }
}
function finish() { return cleanupTask ??= cleanup(); }
for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]]) {
  process.once(signal, () => { void finish().finally(() => process.exit(code)); });
}
function start(args, capture = false) {
  assert.ok(!cleanupTask, 'Proof is shutting down');
  const child = spawn(process.execPath, [cli, ...args], { cwd: root, env, detached: true,
    stdio: ['ignore', capture ? 'pipe' : 'ignore', 'ignore'] });
  if (child.pid) groups.add(child.pid);
  return child;
}
async function dashboardLink(origin) {
  const child = start(['dashboard', '--json'], true);
  let raw = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { raw = (raw + chunk).slice(-65536); });
  const timeout = setTimeout(() => { if (child.pid) signalGroup(child.pid, 'SIGKILL'); }, 90_000);
  try {
    await new Promise((done, fail) => {
      child.once('error', fail);
      child.once('close', code => code === 0 ? done() : fail(new Error(`dashboard --json exited ${code}`)));
    });
    const handoff = JSON.parse(raw);
    assert.ok(handoff.ok && typeof handoff.browserUrl === 'string', 'No browser pairing handoff');
    const url = new URL(handoff.browserUrl);
    const fragment = new URLSearchParams(url.hash.slice(1));
    assert.ok(url.origin === origin && !url.username && !url.password && !url.search &&
      fragment.get('bootstrapToken') && new URL(fragment.get('gatewayUrl')).origin === origin.replace('http:', 'ws:'),
    'Expected a one-time handoff to this loopback Gateway');
    return url.href;
  } finally { clearTimeout(timeout); if (child.pid && !signalGroup(child.pid, 0)) groups.delete(child.pid); }
}
async function freePort() {
  const server = createServer();
  await new Promise((done, fail) => server.once('error', fail).listen(0, '127.0.0.1', done));
  const { port } = server.address();
  await new Promise((done, fail) => server.close(err => err ? fail(err) : done()));
  return port;
}
function seedFailedRun(id) {
  const writer = `
    import assert from 'node:assert/strict';
    import {createUpdateRun, recordUpdateRunPhase, finishUpdateRun, getUpdateRun} from './src/infra/update-run-ledger.ts';
    const runId = process.argv[1];
    assert.equal(createUpdateRun({runId, trigger: 'cli'}).runId, runId);
    recordUpdateRunPhase(runId, 'staging');
    finishUpdateRun(runId, {status: 'failed', reason: 'build-failed'});
    const saved = getUpdateRun(runId);
    assert.equal(saved?.status, 'failed');
    assert.equal(saved.reason, 'build-failed');
    assert.ok(saved.steps.some(step => step.step === 'staging' && step.status === 'failed'));
  `;
  const child = spawnSync(process.execPath, ['--import', './scripts/tsx.mjs', '--input-type=module', '-e', writer, id],
    { cwd: root, env, timeout: 90000, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  if (child.error) throw child.error;
  assert.equal(child.status, 0, `Ledger fixture writer failed: ${child.stderr.slice(-1200)}`);
}
async function launchBrowser() {
  const noSandbox = process.env.PROOF_CHROMIUM_NO_SANDBOX === '1';
  if (noSandbox) assert.deepEqual(fs.readdirSync('/sys/class/net'), ['lo'], 'Unsandboxed Chromium requires --network=none');
  const options = { headless: true, chromiumSandbox: !noSandbox, env,
    handleSIGHUP: false, handleSIGTERM: false, handleSIGINT: false };
  if (process.env.CHROMIUM_PATH) return chromium.launch({ ...options, executablePath: process.env.CHROMIUM_PATH });
  if (fs.existsSync(chromium.executablePath())) return chromium.launch({ ...options, channel: 'chromium' });
  try { return await chromium.launch(options); }
  catch (err) {
    if (!String(err.message).includes("Executable doesn't exist") || !fs.existsSync('/usr/bin/chromium')) throw err;
    return chromium.launch({ ...options, executablePath: '/usr/bin/chromium' });
  }
}
try {
  for (const dir of [state, env.TMPDIR, env.XDG_CACHE_HOME, env.XDG_CONFIG_HOME]) fs.mkdirSync(dir);
  try { fs.writeFileSync(marker, JSON.stringify(markerJson) + '\n', { flag: 'wx' }); ownMarker = true; }
  catch (err) {
    if (err.code !== 'EEXIST') throw err;
    assert.deepEqual(JSON.parse(fs.readFileSync(marker)), markerJson, 'Unexpected existing ownership marker; not replacing it');
  }
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  fs.writeFileSync(config, JSON.stringify({ gateway: { mode: 'local', bind: 'loopback', port,
    auth: { mode: 'token', token: randomBytes(32).toString('hex') }, controlUi: { enabled: true, root: uiRoot } },
    update: { checkOnStart: true, auto: { enabled: false } }, discovery: { mdns: { mode: 'off' } } }));
  tell('starting built Gateway on loopback');
  async function startGateway() {
    const gateway = start(['gateway', 'run', '--bind', 'loopback', '--port', String(port)]);
    let spawnFailure;
    gateway.on('error', err => { spawnFailure = err; });
    const deadline = Date.now() + 180_000;
    for (;;) {
      if (spawnFailure) throw spawnFailure;
      assert.ok(gateway.exitCode === null && gateway.signalCode === null, `Gateway exited before ready (${gateway.exitCode ?? gateway.signalCode})`);
      assert.ok(Date.now() < deadline, 'Gateway /readyz timeout');
      const response = await fetch(`${origin}/readyz`, { redirect: 'error', signal: AbortSignal.timeout(2000) }).catch(() => null);
      await response?.body?.cancel();
      if (response?.ok) return gateway;
      await sleep(350);
    }
  }
  const firstGateway = await startGateway();
  tell('launching Chromium');
  browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US',
    timezoneId: 'UTC', reducedMotion: 'reduce', colorScheme: 'light', serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  const verify = expect.configure({ timeout: 60_000 });
  const runId = randomUUID();
  const wsOrigin = origin.replace('http:', 'ws:');
  let healthyRead = false, failedRead = false, mutations = 0;
  page.on('websocket', socket => {
    if (new URL(socket.url()).origin !== wsOrigin) return;
    const ids = new Set();
    socket.on('framesent', ({ payload }) => {
      const frame = parseFrame(payload);
      if (frame?.type === 'req' && frame.method === 'update.status') ids.add(frame.id);
      if (frame?.type === 'req' && frame.method === 'update.run') mutations++;
    });
    socket.on('framereceived', ({ payload }) => {
      const frame = parseFrame(payload);
      if (frame?.type !== 'res' || !ids.delete(frame.id) || !frame.ok) return;
      const { schedule, lastRun, activeRun } = frame.payload ?? {};
      if (!schedule || activeRun) return;
      const host = schedule.install?.host;
      const matches = fixed ? schedule.install?.kind === 'host' && Object.keys(owner).every(key => host?.[key] === owner[key]) : !schedule.install;
      if (!matches) return;
      if (!lastRun) healthyRead = true;
      if (lastRun?.runId === runId && lastRun.status === 'failed') failedRead = true;
    });
  });
  function parseFrame(payload) { try { return JSON.parse(payload.toString()); } catch { return null; } }
  tell('pairing with one-time dashboard handoff');
  const handoff = await dashboardLink(origin);
  await page.goto(handoff, { waitUntil: 'domcontentloaded' }).catch(() => { throw new Error('Browser could not load handoff'); });
  const connected = () => page.waitForFunction(() => window.openclawControlUi?.snapshot().gatewayPhase === 'connected');
  await connected();
  const updates = `${origin}/settings/updates`;
  async function visitUpdates() {
    const response = await page.goto(updates, { waitUntil: 'domcontentloaded' });
    assert.equal(response?.status(), 200);
    await connected();
    await verify(page).toHaveURL(updates);
    const scriptPath = await page.evaluate(() => Array.from(document.scripts, script => script.src)
      .filter(Boolean).map(src => new URL(src, location.href)).find(url => url.origin === location.origin && /^\/assets\/[^/]+\.js$/.test(url.pathname))?.pathname);
    assert.ok(scriptPath, 'Expected a built Control UI entry script');
    const fetched = await context.request.get(`${origin}${scriptPath}`);
    assert.equal(fetched.status(), 200);
    assert.ok((await fetched.body()).equals(fs.readFileSync(join(uiRoot, scriptPath))), 'Served bundle differs from the tested build');
  }
  tell('checking healthy Settings → Updates');
  await visitUpdates();
  const view = page.locator('#config-section-update');
  const section = name => view.locator('.settings-section').filter({ has: page.getByRole('heading', { name, exact: true }) });
  const status = section('Update status');
  const history = section('Latest update attempt');
  const update = view.getByRole('button', { name: /^Update Gateway(?:…|\.{3})?$/i, includeHidden: true });
  const retry = view.getByRole('button', { name: 'Retry update', exact: true, includeHidden: true });
  const managed = `Managed by ${owner.displayName}`;
  const hint = status.getByText(`${managed}. ${owner.updateHint}`, { exact: true });
  await verify.poll(() => healthyRead, { message: 'Real update.status must describe the clean fixture' }).toBe(true);
  await verify(status.getByText(fixed ? managed : 'Update status unavailable', { exact: true })).toBeVisible();
  async function verifyAction() {
    if (fixed) { await verify(hint).toBeVisible(); await verify(update).toHaveCount(0); }
    else { await verify(hint).toHaveCount(0); await verify(update).toBeVisible(); await verify(update).toBeEnabled(); }
  }
  await verifyAction();
  const capture = async locator => {
    await locator.scrollIntoViewIfNeeded();
    await page.evaluate(() => document.fonts.ready.then(() => true));
    return locator.screenshot({ type: 'png', animations: 'disabled' });
  };
  const cleanPng = await capture(status);
  tell('seeding failed update in the disposable Gateway ledger');
  await page.goto('about:blank');
  assert.ok(signalGroup(firstGateway.pid, 'SIGTERM'), 'Fixture Gateway unexpectedly stopped');
  const stopBy = Date.now() + 90000;
  while (signalGroup(firstGateway.pid, 0)) {
    assert.ok(Date.now() < stopBy, 'Fixture Gateway did not release its state');
    await sleep(200);
  }
  groups.delete(firstGateway.pid);
  seedFailedRun(runId);
  tell('opening Settings with the recorded failed update');
  await startGateway();
  await visitUpdates();
  await verify.poll(() => failedRead, { message: 'Real update.status must return the seeded failed run' }).toBe(true);
  const check = history.getByRole('button', { name: 'Check status', exact: true });
  await verify(check).toBeVisible();
  await verify(check).toBeEnabled();
  await verifyAction();
  if (fixed) await verify(retry).toHaveCount(0);
  else { await verify(retry).toBeVisible(); await verify(retry).toBeEnabled(); }
  const recoveryPng = await capture(history);
  assert.equal(mutations, 0, 'Unexpected update.run request');
  for (const [index, png] of [cleanPng, recoveryPng].entries()) {
    fs.writeFileSync(images[index], png, { flag: 'wx' });
    fs.chmodSync(images[index], 0o644);
  }
} catch (err) {
  const message = String(err.message).replace(/(https?|wss?):\/\/[^\s"'<>]+/g, '[URL]').slice(0, 2400);
  console.error(`FAIL ${leg} (${stage}): ${message}`);
  process.exitCode = 1;
} finally { await finish(); }
if (!process.exitCode) console.log(`PASS ${leg}: ${images.join(', ')}`);
