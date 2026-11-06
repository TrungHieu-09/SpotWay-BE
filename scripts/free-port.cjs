/**
 * Frees the API port before starting the server, so a stale `node dist/main`
 * left over from a previous run never causes `EADDRINUSE`.
 *
 * Safety: only kills processes that look like THIS backend (command line contains
 * "dist/main", "dist\main" or "spotway-be"). Any other program using the port is
 * left alone and reported, instead of being killed.
 */
const { execSync } = require('child_process');
const path = require('path');

try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch {
  /* dotenv is optional; fall back to process.env / default port */
}

const port = Number(process.env.PORT ?? 3000);
const isWindows = process.platform === 'win32';

function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

function listeningPids() {
  if (isWindows) {
    const out = run(
      `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique"`,
    );
    return out.split(/\r?\n/).map((s) => s.trim()).filter((s) => /^\d+$/.test(s) && s !== '0');
  }
  const out = run(`lsof -ti tcp:${port} -sTCP:LISTEN`);
  return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function commandLine(pid) {
  if (isWindows) {
    return run(
      `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine"`,
    ).trim();
  }
  return run(`ps -p ${pid} -o command=`).trim();
}

const pids = listeningPids().filter((pid) => Number(pid) !== process.pid);

if (pids.length === 0) {
  console.log(`[free-port] Port ${port} is free.`);
  process.exit(0);
}

let blocked = false;
for (const pid of pids) {
  const cmd = commandLine(pid);
  const isOurBackend = /dist[\\/]+main|spotway-be/i.test(cmd);
  if (!isOurBackend) {
    blocked = true;
    console.error(`[free-port] Port ${port} is used by PID ${pid}, which is not this backend:\n  ${cmd || '(unknown command)'}`);
    continue;
  }
  try {
    if (isWindows) run(`taskkill /PID ${pid} /F /T`);
    else process.kill(Number(pid), 'SIGKILL');
    console.log(`[free-port] Stopped stale backend (PID ${pid}) on port ${port}.`);
  } catch (error) {
    blocked = true;
    console.error(`[free-port] Could not stop PID ${pid}: ${error.message}`);
  }
}

process.exit(blocked ? 1 : 0);

