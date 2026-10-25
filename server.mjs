#!/usr/bin/env node
// Launcher for Claude Code Remote Control servers. Lists projects in the folders named
// in config.local.json; "start" runs `claude remote-control` for a project in its own detached
// tmux session, so new sessions can be opened in that folder from the Claude iPhone app.
// One server per project. Node standard library only.
//
// Serves 127.0.0.1:8766. `tailscale serve --set-path /rc` exposes it to the tailnet.

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const PORT = Number(process.env.PORT || 8766);
const HOME = homedir();
const CONFIG = loadConfig(join(import.meta.dirname, 'config.local.json'));
const GROUPS = CONFIG.groups.map((g) => ({
  title: g.title,
  dir: g.dir.replace(/^~(?=\/|$)/, HOME),
  skip: g.skip || [],
}));
// Only this Tailscale login may use the page. Requests without the header come from
// this Mac itself (tailscale serve always sets it for tailnet traffic).
const ALLOWED_LOGIN = process.env.ALLOWED_LOGIN || CONFIG.allowedLogin;
if (!ALLOWED_LOGIN) {
  console.error('Set allowedLogin in config.local.json (or ALLOWED_LOGIN) to your Tailscale login.');
  process.exit(1);
}
const TMUX = '/opt/homebrew/bin/tmux';
const CLAUDE = join(HOME, '.local/bin/claude');
const PREFIX = 'rc-';
const PUBLIC = join(import.meta.dirname, 'public');

// Clean environment for tmux and claude, so nothing leaks in from whatever started us.
const ENV = {
  HOME,
  USER: process.env.USER || basename(HOME),
  PATH: `${join(HOME, '.local/bin')}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
  LANG: 'en_US.UTF-8',
  TERM: 'xterm-256color',
};

// config.local.json is not committed; see config.example.json.
function loadConfig(file) {
  let config;
  try {
    config = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`Can't read ${file}: ${e.message}. Copy config.example.json to start.`);
    process.exit(1);
  }
  if (!Array.isArray(config.groups) || !config.groups.every((g) => g.title && g.dir)) {
    console.error(`${file}: groups must be a list of { "title", "dir" }.`);
    process.exit(1);
  }
  return config;
}

const tmux = (...args) => run(TMUX, args, { env: ENV });

async function listProjects() {
  const groups = [];
  for (const g of GROUPS) {
    const names = await readdir(g.dir).catch(() => []);
    const projects = [];
    for (const name of names.sort((a, b) => a.localeCompare(b))) {
      if (name.startsWith('.') || g.skip.includes(name)) continue;
      const path = join(g.dir, name);
      const s = await stat(path).catch(() => null); // follows symlinks
      if (s?.isDirectory()) projects.push({ name, path });
    }
    groups.push({ title: g.title, dir: g.dir, projects });
  }
  return groups;
}

// Server sessions are created once per project and found again by @rc_path.
const serverInfo = new Map(); // tmux session -> { url }

async function listServers() {
  let out = '';
  try {
    ({ stdout: out } = await tmux('list-sessions', '-F',
      '#{session_name}\t#{session_created}\t#{@rc_path}\t#{@rc_mode}'));
  } catch {
    return []; // no tmux server running means no sessions
  }
  const servers = [];
  for (const line of out.trim().split('\n')) {
    const [id, created, path, mode] = line.split('\t');
    if (!id?.startsWith(PREFIX) || mode !== 'server') continue;
    servers.push({ id, path, started: Number(created) * 1000, ...(await readPane(id)) });
  }
  return servers;
}

// The server prints its environment link once and redraws "Capacity: N/32" as sessions
// come and go, so read the pane each time and keep the link once found.
async function readPane(id) {
  const info = serverInfo.get(id) || {};
  let sessions = null;
  try {
    const { stdout } = await tmux('capture-pane', '-p', '-J', '-S', '-200', '-t', id);
    info.url ||= stdout.match(/https:\/\/claude\.ai\/code\?environment=[A-Za-z0-9_]+/)?.[0];
    const counts = [...stdout.matchAll(/Capacity: (\d+)\//g)];
    if (counts.length) sessions = Number(counts.at(-1)[1]);
    serverInfo.set(id, info);
  } catch {}
  return { url: info.url || null, sessions };
}

async function state() {
  const [groups, servers] = await Promise.all([listProjects(), listServers()]);
  for (const g of groups)
    for (const p of g.projects) p.server = servers.find((s) => s.path === p.path) || null;
  return { groups };
}

async function start(path) {
  const groups = await listProjects();
  const group = groups.find((g) => g.projects.some((p) => p.path === path));
  if (!group) throw httpError(400, 'Unknown project');
  const project = group.projects.find((p) => p.path === path);
  if ((await listServers()).some((s) => s.path === path))
    throw httpError(409, `${project.name} is already running`);

  const id = `${PREFIX}${basename(group.dir)}-${project.name}`.replace(/[^A-Za-z0-9_-]/g, '_');
  // A tmux session left over from a server that exited has no live claude; clear it.
  await tmux('kill-session', '-t', `=${id}`).catch(() => {});
  serverInfo.delete(id);

  // Passing the command as separate args makes tmux exec it directly, no shell.
  // The server opens one session in this folder named after the project, so it shows
  // up in the app right away; more sessions opened from the phone also run here.
  await tmux('new-session', '-d', '-s', id, '-x', '200', '-y', '50', '-c', path,
    '/usr/bin/env', '-i', ...Object.entries(ENV).map(([k, v]) => `${k}=${v}`),
    CLAUDE, 'remote-control', '--spawn', 'same-dir', '--name', project.name,
    '--remote-control-session-name-prefix', project.name);
  await tmux('set-option', '-t', id, '@rc_path', path);
  await tmux('set-option', '-t', id, '@rc_name', project.name);
  await tmux('set-option', '-t', id, '@rc_mode', 'server');

  // Wait briefly for the server to print its environment link.
  for (let i = 0; i < 20; i++) {
    const { url } = await readPane(id);
    if (url) return { id, name: project.name, url };
    await new Promise((r) => setTimeout(r, 500));
  }
  return { id, name: project.name, url: null };
}

async function stop(id) {
  if (!(await listServers()).some((s) => s.id === id)) throw httpError(400, 'Unknown server');
  // Ctrl-C lets the server shut down and archive its sessions; kill the tmux session
  // if it hasn't exited after a few seconds.
  await tmux('send-keys', '-t', `=${id}:`, 'C-c').catch(() => {});
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (!(await tmux('has-session', '-t', `=${id}`).then(() => true, () => false))) break;
  }
  await tmux('kill-session', '-t', `=${id}`).catch(() => {});
  serverInfo.delete(id);
  return { ok: true };
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function readJson(req) {
  if (!req.headers['content-type']?.startsWith('application/json'))
    throw httpError(415, 'Expected JSON'); // also blocks simple cross-site form posts
  let body = '';
  for await (const chunk of req) body += chunk;
  return JSON.parse(body || '{}');
}

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/manifest.json': ['manifest.json', 'application/manifest+json'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'],
};

createServer(async (req, res) => {
  const send = (status, body, type = 'application/json') => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  };
  try {
    const login = req.headers['tailscale-user-login'];
    if (login && login !== ALLOWED_LOGIN) throw httpError(403, 'Forbidden');

    const { pathname } = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && STATIC[pathname]) {
      const [file, type] = STATIC[pathname];
      return send(200, await readFile(join(PUBLIC, file)), type);
    }
    if (req.method === 'GET' && pathname === '/api/state') return send(200, await state());
    if (req.method === 'POST' && pathname === '/api/start')
      return send(200, await start((await readJson(req)).path));
    if (req.method === 'POST' && pathname === '/api/stop')
      return send(200, await stop((await readJson(req)).id));
    throw httpError(404, 'Not found');
  } catch (e) {
    if (!e.status) console.error(e);
    send(e.status || 500, { error: e.message });
  }
}).listen(PORT, '127.0.0.1', () => console.error(`Serving http://127.0.0.1:${PORT}`));
