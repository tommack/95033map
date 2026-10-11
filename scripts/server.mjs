// Local dev server: serves the project folder and persists the tools' editing
// state to disk. No dependencies.
//
//   node scripts/server.mjs            # http://localhost:8765/tools/
//   PORT=… SAVE_DIR=… node scripts/server.mjs   # elsewhere, e.g. for testing
//
// API (one store per tool: graph = node picker, layout = layout editor; layout-g35 = the layout
// editor's map of one neighborhood, the area group g35 in the main layout)
//   GET /api/<store>  -> { rev, savedAt, state }   (rev 0 / state null when nothing saved yet)
//   PUT /api/<store>  <- { rev, state, derived? }  409 if rev isn't the current one
//
// Files
//   data/<store>.json          editing state (source of truth)
//   data/<store>-derived.json  derived output, rewritten on every save that includes one
//   data/backups/              copy of <store>.json at most every BACKUP_EVERY_MS, newest MAX_BACKUPS kept per store

import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8765;
const SAVE_DIR = process.env.SAVE_DIR ? path.resolve(process.env.SAVE_DIR) : path.join(ROOT, 'data');
const STORES = ['graph', 'layout'];
const BACKUP_DIR = path.join(SAVE_DIR, 'backups');
const BACKUP_EVERY_MS = 5 * 60 * 1000;
const MAX_BACKUPS = 200;
const MAX_BODY = 64 * 1024 * 1024;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.geojson': 'application/geo+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8',
};

async function readJSON(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

async function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, text);
  await fs.rename(tmp, file);
}

const stateFile = (store) => path.join(SAVE_DIR, `${store}.json`);
const derivedFile = (store) => path.join(SAVE_DIR, `${store}-derived.json`);

const lastBackup = {};
async function backup(store) {
  if (Date.now() - (lastBackup[store] || 0) < BACKUP_EVERY_MS) return;
  try { await fs.access(stateFile(store)); } catch { return; }
  await fs.mkdir(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await fs.copyFile(stateFile(store), path.join(BACKUP_DIR, `${store}-${stamp}.json`));
  lastBackup[store] = Date.now();
  // The date after the name, so layout's backups aren't confused with layout-g35's.
  const files = (await fs.readdir(BACKUP_DIR)).filter((f) => f.startsWith(`${store}-`) && /^\d{4}-/.test(f.slice(store.length + 1))).sort();
  for (const f of files.slice(0, Math.max(0, files.length - MAX_BACKUPS))) await fs.unlink(path.join(BACKUP_DIR, f));
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Saves are serialized so two quick PUTs can't interleave their rev checks.
let queue = Promise.resolve();
const serialized = (fn) => (queue = queue.then(fn, fn));

async function handleApi(req, res, store) {
  if (req.method === 'GET') {
    const cur = await readJSON(stateFile(store));
    return send(res, 200, cur ?? { rev: 0, savedAt: null, state: null });
  }
  if (req.method === 'PUT') {
    const body = JSON.parse(await readBody(req));
    return serialized(async () => {
      const cur = await readJSON(stateFile(store));
      const curRev = cur?.rev ?? 0;
      if (body.rev !== curRev) return send(res, 409, { error: 'stale', rev: curRev });
      await backup(store);
      const saved = { rev: curRev + 1, savedAt: new Date().toISOString(), state: body.state };
      await writeAtomic(stateFile(store), JSON.stringify(saved, null, 1));
      if (body.derived) await writeAtomic(derivedFile(store), JSON.stringify(body.derived));
      send(res, 200, { rev: saved.rev, savedAt: saved.savedAt });
    });
  }
  send(res, 405, { error: 'method not allowed' });
}

async function handleStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  let file = path.join(ROOT, decodeURIComponent(url.pathname));
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return send(res, 403, 'forbidden', 'text/plain');
  // With SAVE_DIR elsewhere (testing), /data/ files saved there shadow the project's.
  if (process.env.SAVE_DIR && url.pathname.startsWith('/data/')) {
    const alt = path.join(SAVE_DIR, decodeURIComponent(url.pathname.slice(6)));
    if (alt.startsWith(SAVE_DIR + path.sep)) { try { await fs.access(alt); file = alt; } catch {} }
  }
  try {
    if ((await fs.stat(file)).isDirectory()) {
      if (!url.pathname.endsWith('/')) { res.writeHead(301, { Location: url.pathname + '/' }); return res.end(); }
      file = path.join(file, 'index.html');
    }
    const buf = await fs.readFile(file);
    send(res, 200, buf, TYPES[path.extname(file)] || 'application/octet-stream');
  } catch {
    send(res, 404, 'not found', 'text/plain');
  }
}

http.createServer(async (req, res) => {
  try {
    const api = req.url.split('?')[0].match(/^\/api\/([a-z]+(?:-g\d+)?)$/);
    if (api && (STORES.includes(api[1]) || /^layout-g\d+$/.test(api[1]))) await handleApi(req, res, api[1]);
    else await handleStatic(req, res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: e.message });
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`http://localhost:${PORT}/tools/`);
});
