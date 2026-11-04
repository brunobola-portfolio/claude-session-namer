'use strict';
/**
 * CI-only proof on real POSIX ptys (GitHub Actions ubuntu-latest, macos-latest):
 * a process with no controlling terminal still titles the terminal it was
 * started from. Qwen Code starts hooks like that on macOS and Linux
 * (`detached`, i.e. setsid), so they cannot open /dev/tty.
 *
 * Each test runs this file as a "driver" under `script`, which gives the
 * driver a pty and copies everything written to that pty to our stdout:
 *
 *   script (pty) -> driver -> detached child (no tty): writeTerminalTitle
 *                                 -> worker, after the child exited
 *   script (pty) -> driver -> detached adapters/qwen/hook.js -> its worker
 *
 * The captured pty output must contain the OSC 0 sequences. The roles are
 * picked with SN_PTY_ROLE so that no separate fixture file is needed.
 * Skipped on Windows and outside CI; run it on macOS/Linux with CI=1.
 */
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const osc = require('../adapters/_shared/osc-title');

const ROLE_ENV = 'SN_PTY_ROLE';
const REPORT_TAG = 'SN_PTY_REPORT ';
const ROOT = path.join(__dirname, '..');
const QWEN_HOOK = path.join(ROOT, 'adapters', 'qwen', 'hook.js');
const FAKE_TOPIC = 'Fix Safari login redirect loop';
const OSC = (t) => `\u001b]0;${t}\u0007`;

const delay = (ms) => new Promise((r) => { setTimeout(r, ms); });
async function waitFor(check, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const v = check();
    if (v || Date.now() > end) return v;
    await delay(25);
  }
}
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const ps = (args) => {
  const r = childProcess.spawnSync('ps', args, { encoding: 'utf8' });
  return { status: r.status, stdout: String(r.stdout || '') };
};

/** What opening /dev/tty does here: 'opened' or the error code (ENXIO without a controlling terminal). */
function devTtyStatus() {
  try {
    fs.closeSync(fs.openSync('/dev/tty', 'w'));
    return 'opened';
  } catch (e) {
    return e.code || String(e);
  }
}

/** Spawn like Qwen Code spawns a hook: detached (setsid), stdio piped to us. */
function runDetached(cmd, args, { env, cwd, input = '' }) {
  return new Promise((resolve) => {
    const child = childProcess.spawn(cmd, args, { env, cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => resolve({ code: -1, stdout, stderr: `${stderr}${e}` }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

// ---- roles (run as separate processes) -------------------------------------

/** Under `script`: owns the pty. Starts the detached process(es) and reports. */
async function driver() {
  const report = { mode: process.env.SN_PTY_MODE, pid: process.pid, devTty: devTtyStatus() };
  report.tty = ps(['-o', 'tty=', '-p', String(process.pid)]).stdout.trim();
  if (report.mode === 'direct') {
    const r = await runDetached(process.execPath, [__filename], { env: { ...process.env, [ROLE_ENV]: 'child' } });
    report.childExit = r.code;
    try { report.child = JSON.parse(r.stdout); } catch { report.child = { raw: r.stdout, stderr: r.stderr }; }
    report.worker = await waitFor(() => readJson(process.env.SN_PTY_MARKER), 4000);
  } else {
    const home = process.env.SN_PTY_QWEN_HOME;
    const proj = process.env.SN_PTY_PROJECT;
    const env = { ...process.env, QWEN_HOME: home, SESSION_NAMER_FAKE_RESULT: FAKE_TOPIC, SESSION_NAMER_PROJECT_SOURCE: 'cwd' };
    for (const k of [ROLE_ENV, 'CLAUDE_SESSION_NAMER', osc.TTY_ENV]) delete env[k];
    const payload = { session_id: 'ci-pty-1', cwd: proj, hook_event_name: 'UserPromptSubmit', prompt: 'Fix the login redirect loop on Safari' };
    // Through a shell that cannot exec the command in place: hook -> sh (no tty) -> driver (pty).
    const r = await runDetached('/bin/sh', ['-c', '"$0" "$1"; exit $?', process.execPath, QWEN_HOOK], { env, cwd: proj, input: JSON.stringify(payload) });
    report.hookExit = r.code;
    report.hookOutput = r.stdout + r.stderr;
    const logFile = path.join(home, 'session-namer', 'log.txt');
    report.log = (await waitFor(() => (/tab title "/.test(readText(logFile)) ? readText(logFile) : ''), 4000)) || readText(logFile);
  }
  process.stdout.write(`\n${REPORT_TAG}${JSON.stringify(report)}\n`);
}

/** Detached: a new session, no controlling terminal. Titles, then leaves a worker behind. */
function child() {
  const report = { pid: process.pid, ppid: process.ppid, devTty: devTtyStatus() };
  report.wrote = osc.writeTerminalTitle(process.env.SN_PTY_TITLE);
  report.hint = process.env[osc.TTY_ENV] || null;
  // Evidence for the ps syntax: POSIX lets everything after "=" be the header.
  report.psSplit = ps(['-o', 'ppid=', '-o', 'tty=', '-p', String(process.ppid)]);
  report.psJoined = ps(['-o', 'ppid=,tty=', '-p', String(process.ppid)]);
  const w = childProcess.spawn(process.execPath, [__filename], {
    env: { ...process.env, [ROLE_ENV]: 'worker', SN_PTY_HOOK_PID: String(process.pid) }, stdio: 'ignore', detached: false,
  });
  w.unref();
  process.stdout.write(JSON.stringify(report));
}

/** Like the tab-title worker: titles after its parent is gone (reparented, no ancestor terminal). */
async function worker() {
  const hookPid = Number(process.env.SN_PTY_HOOK_PID);
  const ppidNow = () => Number.parseInt(ps(['-o', 'ppid=', '-p', String(process.pid)]).stdout.trim(), 10);
  const ppid = await waitFor(() => { const p = ppidNow(); return p !== hookPid ? p : 0; }, 3000);
  const report = { pid: process.pid, hookPid, ppid, devTty: devTtyStatus(), hint: process.env[osc.TTY_ENV] || null };
  report.walkFromNewParent = osc.ancestorTtyDevice(Number.isInteger(ppid) ? ppid : process.ppid);
  report.wrote = osc.writeTerminalTitle(process.env.SN_PTY_WORKER_TITLE);
  fs.writeFileSync(process.env.SN_PTY_MARKER, JSON.stringify(report));
}

// ---- tests -----------------------------------------------------------------

const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/** Run the driver under `script` and capture the pty output. */
function runUnderScript(extraEnv) {
  const env = { ...process.env, ...extraEnv, [ROLE_ENV]: 'driver' };
  delete env[osc.TTY_ENV];
  const [cmd, args] = process.platform === 'darwin'
    ? ['script', ['-q', '/dev/null', process.execPath, __filename]]
    : ['script', ['-qec', `${shq(process.execPath)} ${shq(__filename)}`, '/dev/null']];
  // stdin: macOS script aborts unless tcgetattr fails with ENOTTY, and Node's 'pipe' is a
  // socket (EOPNOTSUPP), so it gets /dev/null. On Linux a pipe kept open while script runs.
  const stdin = process.platform === 'darwin' ? 'ignore' : 'pipe';
  return new Promise((resolve) => {
    const p = childProcess.spawn(cmd, args, { env, stdio: [stdin, 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), 12000);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: `${out}${e}`, report: null }); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (p.stdin) p.stdin.destroy();
      const at = out.lastIndexOf(REPORT_TAG);
      let report = null;
      if (at >= 0) {
        try { report = JSON.parse(out.slice(at + REPORT_TAG.length).split(/\r?\n/)[0]); } catch { report = null; }
      }
      resolve({ code, out, report });
    });
  });
}

function defineTests() {
  const test = require('node:test');
  const assert = require('node:assert/strict');

  let skip = false;
  if (process.platform === 'win32') skip = 'POSIX only';
  else if (!process.env.CI) skip = 'CI only (needs `script`; set CI=1 to run it here)';

  test('pty: a detached process (no controlling tty) titles its ancestor\'s terminal, and so does its worker', { skip, timeout: 20000 }, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-pty-'));
    const marker = path.join(dir, 'worker.json');
    const t0 = Date.now();
    const { code, out, report } = await runUnderScript({
      SN_PTY_MODE: 'direct', SN_PTY_TITLE: 'proj - Topic', SN_PTY_WORKER_TITLE: 'proj - Later topic', SN_PTY_MARKER: marker,
    });
    const ms = Date.now() - t0;
    t.diagnostic(`platform ${process.platform}, script exit ${code}, ${ms} ms`);
    t.diagnostic(`pty output: ${JSON.stringify(out)}`);
    assert.ok(report, `no driver report in the pty output: ${JSON.stringify(out)}`);
    const { child: c, worker: w } = report;
    t.diagnostic(`driver: tty ${report.tty}, /dev/tty ${report.devTty}`);
    t.diagnostic(`child: /dev/tty ${c.devTty}, wrote ${c.wrote}, device ${c.hint}`);
    t.diagnostic(`ps -o ppid= -o tty= -> ${JSON.stringify(c.psSplit)}; ps -o ppid=,tty= -> ${JSON.stringify(c.psJoined)}`);
    t.diagnostic(`worker: ppid ${w && w.ppid} (was ${w && w.hookPid}), walk from new parent ${w && w.walkFromNewParent}, inherited ${w && w.hint}, wrote ${w && w.wrote}`);

    assert.equal(report.devTty, 'opened', 'the driver runs on the pty');
    assert.notEqual(c.devTty, 'opened', 'the detached child must have no controlling terminal');
    assert.equal(c.wrote, true);
    assert.equal(c.hint, `/dev/${report.tty}`, 'the child wrote to the driver\'s terminal');
    assert.ok(out.includes(OSC('proj - Topic')), 'OSC 0 from the detached child reached the pty');

    assert.ok(w, 'the worker finished');
    assert.ok(Number.isInteger(w.ppid) && w.ppid !== w.hookPid, 'the worker was reparented before it wrote');
    assert.equal(w.walkFromNewParent, null, 'its new parent chain has no terminal');
    assert.equal(w.wrote, true);
    assert.ok(out.includes(OSC('proj - Later topic')), 'OSC 0 from the reparented worker reached the pty');
    assert.ok(ms < 5000, `took ${ms} ms`);
  });

  test('pty: the Qwen hook, started detached, titles the tab with the project, then the topic', { skip, timeout: 20000 }, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-pty-hook-'));
    const proj = path.join(dir, 'proj');
    fs.mkdirSync(proj);
    const t0 = Date.now();
    const { code, out, report } = await runUnderScript({ SN_PTY_MODE: 'hook', SN_PTY_QWEN_HOME: path.join(dir, 'home'), SN_PTY_PROJECT: proj });
    const ms = Date.now() - t0;
    t.diagnostic(`platform ${process.platform}, script exit ${code}, ${ms} ms`);
    t.diagnostic(`pty output: ${JSON.stringify(out)}`);
    assert.ok(report, `no driver report in the pty output: ${JSON.stringify(out)}`);
    t.diagnostic(`hook exit ${report.hookExit}; log: ${JSON.stringify(report.log)}`);

    assert.equal(report.hookExit, 0, report.hookOutput);
    assert.ok(out.includes(OSC('proj')), 'the hook showed the project');
    assert.ok(out.includes(OSC(`proj - ${FAKE_TOPIC}`)), 'the worker showed the topic');
    assert.match(report.log, new RegExp(`tab title "proj - ${FAKE_TOPIC}"`));
    assert.doesNotMatch(report.log, /no terminal/);
    assert.ok(ms < 5000, `took ${ms} ms`);
  });
}

const role = process.env[ROLE_ENV];
if (!role) {
  defineTests();
} else {
  const roles = { driver, child, worker };
  Promise.resolve()
    .then(() => (roles[role] || (() => {}))())
    .catch((e) => { process.stdout.write(`\n${REPORT_TAG}${JSON.stringify({ error: String(e && e.stack) })}\n`); });
}
