#!/usr/bin/env node
// Retakes the README screenshots with sample data: node docs/screenshots.mjs
// Serves public/ with fake /api/state and /api/activity on 127.0.0.1:8798 and drives
// headless Chrome over the DevTools protocol at iPhone size. Standard library only.

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 8798, DEBUG_PORT = 9335;
const SHOTS = [['#/personal', 'docs/screenshot.png'], ['#/activity', 'docs/activity.png']];

const now = Date.now(), min = 60000, hr = 60 * min, day = 24 * hr;
const project = (group, name, extra = {}) =>
  ({ name, path: `/Users/you/dev/${group}/${name}`, server: null, changed: null, used: null, ...extra });
const server = (name, started, sessions, extra = {}) =>
  ({ id: `rc-${name}`, url: 'https://claude.ai/code', started: now - started, sessions, trustPrompt: false, ...extra });

const state = {
  version: (await readFile(join(ROOT, 'VERSION'), 'utf8')).trim(),
  accounts: [{ id: 'default', title: 'Claude', loggedIn: true }],
  groups: [
    { title: 'Personal projects', short: 'Personal', account: 'default', projects: [
      project('personal', 'blog', { server: server('personal-blog', 95 * min, 2), used: now - 4 * min }),
      project('personal', 'dotfiles', { used: now - 9 * day }),
      project('personal', 'garden-planner', { used: now - 2 * hr }),
      project('personal', 'photo-sorter', { used: now - 26 * hr }),
      project('personal', 'prototype', { server: server('personal-prototype', min, null, { url: null, trustPrompt: true }) }),
      project('personal', 'recipes', { changed: now - 3 * day }),
    ] },
    { title: 'Work projects', short: 'Work', account: 'default', projects: [
      project('work', 'api-gateway', { server: server('work-api-gateway', 12 * min, 1), used: now - min }),
      project('work', 'billing-service', { used: now - 5 * hr }),
      project('work', 'design-system', { used: now - 4 * day }),
      project('work', 'website', { used: now - 20 * day }),
    ] },
  ],
};

// 30 days of minutes per project, from a fixed pattern so every run looks the same.
const days = [...Array(30)].map((_, i) => new Date(now - (29 - i) * day).toLocaleDateString('en-CA'));
const weekday = (i) => new Date(days[i] + 'T12:00').getDay();
function series(base, skip = []) {
  const minutes = days.map((_, i) => {
    const w = weekday(i);
    if (skip.includes(i) || w === 0) return 0;
    return Math.round(base * (0.55 + ((i * 37) % 10) / 10) * (w === 6 ? 0.4 : 1));
  });
  return { minutes, tokens: minutes.map((m) => m * 1800), sessions7: 0, sessions30: 0, lastUsed: null };
}
const usage = {
  'personal/blog': series(42), 'personal/garden-planner': series(25, [0, 1, 2, 3]),
  'personal/photo-sorter': series(14, [5, 6, 12, 20]), 'personal/dotfiles': series(6, [...Array(21).keys()].map((i) => i + 9)),
  'work/api-gateway': series(70), 'work/billing-service': series(33), 'work/design-system': series(12, [26, 27, 28, 29]),
  'work/website': series(18, [...Array(20).keys()].map((i) => i + 10)),
};
const activity = { days, logDays: 60, projects: {}, elsewhere: series(8) };
for (const g of state.groups)
  for (const p of g.projects) {
    const a = usage[`${p.path.split('/').slice(-2).join('/')}`];
    if (!a) continue;
    a.sessions7 = Math.ceil(a.minutes.slice(-7).filter(Boolean).length * 1.5);
    a.sessions30 = Math.ceil(a.minutes.filter(Boolean).length * 1.5);
    a.lastUsed = p.used;
    activity.projects[p.path] = a;
  }

const TYPES = { '.html': 'text/html', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const site = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  const json = { '/api/state': state, '/api/activity': activity }[path];
  if (json) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(json)); }
  const file = path === '/' ? 'index.html' : path.slice(1);
  try {
    const body = await readFile(join(ROOT, 'public', file));
    res.writeHead(200, { 'Content-Type': TYPES[file.slice(file.lastIndexOf('.'))] || 'text/plain' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
}).listen(PORT, '127.0.0.1');

const profile = await mkdtemp(join(tmpdir(), 'launcher-shots-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${profile}`, '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  let ws;
  for (let i = 0; i < 40 && !ws; i++) {
    await sleep(250);
    try { ws = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json()).find((t) => t.type === 'page').webSocketDebuggerUrl; } catch {}
  }
  const sock = new WebSocket(ws);
  await new Promise((r) => { sock.onopen = r; });
  let id = 0; const pending = {};
  sock.onmessage = (m) => { const d = JSON.parse(m.data); pending[d.id]?.(d.result); };
  const send = (method, params = {}) => new Promise((r) => { pending[++id] = r; sock.send(JSON.stringify({ id, method, params })); });
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  for (const [hash, out] of SHOTS) {
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/${hash}` });
    await sleep(2000);
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(ROOT, out), Buffer.from(data, 'base64'));
    console.log('wrote', out);
  }
} finally {
  chrome.kill(); site.close();
  await sleep(500);
  await rm(profile, { recursive: true, force: true });
}
