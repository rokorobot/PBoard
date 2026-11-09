#!/usr/bin/env node
// PBoard: personal board for your most active Cloudroom projects.
// Zero dependencies. Reads data through `room-cli` (the same CLI Cloudroom agents use).
// Run on the machine where the Cloudroom app runs:  node server.js  -> http://127.0.0.1:4777

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PORT = Number(process.env.PBOARD_PORT || 4777);
const HOST = process.env.PBOARD_HOST || '127.0.0.1';
const CLI = process.env.PBOARD_CLI || process.env.ROOM_CLI || 'room-cli';
const TOP = Number(process.env.PBOARD_TOP || 12); // how many projects to show
const DAY = 86400000;

function run(args) {
  return new Promise((resolve, reject) => {
    // Windows ships room-cli as a .cmd launcher, which needs a shell.
    const shell = process.platform === 'win32';
    execFile(CLI, args, { shell, timeout: 30000, maxBuffer: 32 << 20, windowsHide: true }, (err, out, errOut) => {
      if (err) return reject(new Error(`${CLI} ${args.join(' ')}: ${(errOut || err.message).trim()}`));
      try { resolve(JSON.parse(out)); } catch { reject(new Error(`${CLI} ${args.join(' ')}: not JSON: ${out.slice(0, 200)}`)); }
    });
  });
}

// The CLI may return a bare array or wrap it ({projects:[...]}, {threads:[...]}, {items:[...]}).
const list = (x) => Array.isArray(x) ? x : (x && Object.values(x).find(Array.isArray)) || [];
const ts = (...vals) => {
  for (const v of vals) {
    if (v == null || v === '') continue;
    const n = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v);
    if (!Number.isNaN(n)) return n;
  }
  return 0;
};
const safeId = (id) => /^[\w.:-]+$/.test(String(id)); // guards the Windows shell

function normThread(t) {
  return {
    id: t.id,
    title: t.title || t.name || t.summary || '(untitled)',
    status: t.status || 'unknown',
    provider: t.providerId || t.provider || '',
    model: t.model || t.modelId || '',
    machine: t.hostName || t.machineName || t.hostId || t.machineId || '',
    queuedWork: t.queuedWork || 'none',
    parent: t.parentThreadId || null,
    pinned: !!(t.pinned || t.pinnedAt),
    archived: !!t.archivedAt,
    unread: !!(t.unread || t.hasUnread),
    activity: ts(t.lastActivityAt, t.lastMessageAt, t.updatedAt, t.createdAt),
    created: ts(t.createdAt),
  };
}

const LIVE = new Set(['active', 'starting', 'pending', 'stopping']);

async function board() {
  const projects = list(await run(['project', 'list', '--json']));
  const now = Date.now();
  const rows = await Promise.all(projects.filter((p) => safeId(p.id)).map(async (p) => {
    let threads = [], error = null;
    try {
      threads = list(await run(['thread', 'list', '--project', String(p.id), '--include-archived', '--json'])).map(normThread);
    } catch (e) { error = e.message; }
    threads.sort((a, b) => b.activity - a.activity);
    const open = threads.filter((t) => !t.archived);
    const last = Math.max(0, ts(p.lastActivityAt, p.updatedAt), ...threads.map((t) => t.activity));
    const recent7 = threads.filter((t) => now - t.activity < 7 * DAY).length;
    const live = open.filter((t) => LIVE.has(t.status)).length;
    const errors = open.filter((t) => t.status === 'error' || t.queuedWork === 'failed').length;
    // Activity score: live work counts most, then last-7-day threads, then recency.
    const recency = last ? Math.max(0, 14 - (now - last) / DAY) : 0;
    const score = live * 10 + recent7 * 3 + recency;
    // 14-day sparkline of thread activity
    const spark = Array.from({ length: 14 }, (_, i) => threads.filter((t) => {
      const d = Math.floor((now - t.activity) / DAY); return d === 13 - i;
    }).length);
    return {
      id: p.id, name: p.name || p.title || p.id,
      root: p.root || p.path || p.rootPath || (p.sources && p.sources[0] && p.sources[0].path) || '',
      last, live, errors, recent7, open: open.length, total: threads.length, score, spark, error,
      threads: open.slice(0, 8),
    };
  }));
  rows.sort((a, b) => b.score - a.score || b.last - a.last);
  return { generatedAt: now, cli: CLI, projectCount: rows.length, projects: rows.slice(0, TOP) };
}

let cache = null, cacheAt = 0;
const html = fs.readFileSync(path.join(__dirname, 'index.html'));

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, body, type = 'application/json') => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  try {
    if (url.pathname === '/') return send(200, html, 'text/html; charset=utf-8');
    if (url.pathname === '/api/board') {
      if (!cache || url.searchParams.has('fresh') || Date.now() - cacheAt > 20000) {
        cache = await board(); cacheAt = Date.now();
      }
      return send(200, cache);
    }
    // Raw CLI output, for checking field mapping on a new Cloudroom version.
    if (url.pathname === '/api/raw') {
      const p = url.searchParams.get('project');
      if (p && !safeId(p)) return send(400, { error: 'bad id' });
      return send(200, await run(p ? ['thread', 'list', '--project', p, '--json'] : ['project', 'list', '--json']));
    }
    send(404, { error: 'not found' });
  } catch (e) {
    send(500, { error: e.message });
  }
}).listen(PORT, HOST, () => console.log(`PBoard on http://${HOST}:${PORT}  (cli: ${CLI})`));
