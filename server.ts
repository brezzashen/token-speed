/** Serves rolling output-speed aggregates from local conversation records; it never calls a model provider. */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Tiktoken } from 'js-tiktoken/lite';
import ranks from 'js-tiktoken/ranks/o200k_base';
import { TaskWatch } from './task-watch.ts';
import { DialogSpeed } from './dialog-speed.ts';
import { codexOwner, parseProfiles } from './profiles.ts';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.TOKEN_PORT ?? 8047);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid TOKEN_PORT.');
const profiles = parseProfiles();
const encoder = new Tiktoken(ranks);
const dialogs = new DialogSpeed();
const watcher = new TaskWatch(profiles, text => encoder.encode(text, [], []).length, codexOwner, sample => dialogs.accept(sample));
// Public fields only: no text, paths, message IDs or conversation IDs leave this process.
const accounts = profiles.map(({ name, agent }) => ({ name, agent }));
let observedAt: number | null = null;
let polling = false, ticks = 0;
async function tick() {
  if (polling) return;
  polling = true;
  try { if (ticks++ % 8 === 0) await watcher.discover(); await watcher.poll(); observedAt = Date.now(); }
  finally { polling = false; }
}
function snapshot() {
  const now = Date.now(), intervals = dialogs.intervals(now);
  return { samples: intervals[0].samples, intervals, accounts, windowMs: 3600_000,
    observedAt: observedAt === null ? null : new Date(observedAt).toISOString(),
    stale: observedAt === null || now - observedAt > 20_000 };
}

const files: Record<string, [string, string]> = {
  '/': ['web/index.html', 'text/html; charset=utf-8'],
  '/style.css': ['web/style.css', 'text/css; charset=utf-8'],
  '/app.js': ['web/dist/app.js', 'application/javascript; charset=utf-8'],
};
const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'");
  if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return; }
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (path === '/health' || path === '/api/speed') {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(path === '/health' ? { status: 'ok', observedAt } : snapshot()));
    return;
  }
  const file = files[path];
  if (!file) { response.writeHead(404).end('Not found'); return; }
  try { response.setHeader('Content-Type', file[1]); response.end(await readFile(resolve(root, file[0]))); }
  catch { response.writeHead(503).end('Asset unavailable'); }
});
await tick();
const timer = setInterval(() => void tick(), 2000);
server.listen(port, process.env.TOKEN_HOST ?? '127.0.0.1', () => process.stdout.write(`Token Speed listening on port ${port}\n`));
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => {
  clearInterval(timer);
  server.close(() => process.exit(0));
});
