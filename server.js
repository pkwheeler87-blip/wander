// Wander — multiplayer server.
// Serves the game page, runs live play over WebSockets, keeps the world saved,
// and lets AI players (ChatGPT, Claude, anyone) join through plain web links under /ai.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const W = require('./public/world.js');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SAVE_FILE = path.join(DATA_DIR, 'world.json');
const PUBLIC = path.join(__dirname, 'public');
const MAX_OPS = 12000;
const gen = W.generate();

// ---------------- world state ----------------
let world = { ops: [], opN: 0, seed: newSeed(), taken: [], scores: {} };
try {
  const saved = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
  if (Array.isArray(saved.ops)) world = Object.assign(world, saved);
  console.log(`Loaded world: ${world.ops.length} changes`);
} catch (_) { console.log('Starting a fresh world'); }
let gems = W.gemSpots(world.seed, gen.colliders);
const cells = new Map(); // "i,k" -> [materials...]
world.ops.forEach(trackOp);
let dirty = false;

function newSeed() { return (Math.random() * 1e9) | 0; }
function trackOp(op) {
  const k = Math.floor(op.x) + ',' + Math.floor(op.z);
  const st = cells.get(k) || [];
  if (op.t === 'b') { if (st.length < 24) st.push(W.MATERIALS[op.m] || 'stone'); }
  else if (st.length) st.pop();
  if (st.length) cells.set(k, st); else cells.delete(k);
}
function addOp(op) {
  const from = op.fromId; delete op.fromId;
  op.id = ++world.opN;
  world.ops.push(op); if (world.ops.length > MAX_OPS) world.ops.shift();
  trackOp(op); dirty = true;
  broadcast({ type: 'op', op }, from);
}
function save() {
  if (!dirty) return; dirty = false;
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(SAVE_FILE + '.tmp', JSON.stringify(world)); fs.renameSync(SAVE_FILE + '.tmp', SAVE_FILE); }
  catch (e) { console.error('save failed', e.message); }
}
setInterval(save, 15000);
process.on('SIGTERM', () => { save(); process.exit(0); });

function takeGem(i, name) {
  if (!gems[i] || world.taken.includes(i)) return false;
  world.taken.push(i); world.scores[name] = (world.scores[name] || 0) + 1; dirty = true;
  if (world.taken.length >= gems.length) {
    setTimeout(() => resetGems(), 20000);
    systemChat(`All gems found! New gems appear in 20 seconds.`);
  }
  return true;
}
function resetGems() {
  world.seed = newSeed(); world.taken = []; world.scores = {}; dirty = true;
  gems = W.gemSpots(world.seed, gen.colliders);
  broadcast({ type: 'gems', seed: world.seed });
}

// ---------------- players ----------------
const players = new Map(); // id -> player
const chat = [];
let nextId = 1;
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
const num = (v, d = 0) => { v = +v; return Number.isFinite(v) ? v : d; };
function uniqueName(name, selfId) {
  let n = name, k = 2;
  const taken = () => [...players.values()].some(p => p.id !== selfId && p.name.toLowerCase() === n.toLowerCase());
  while (taken()) n = name.slice(0, 13) + ' ' + (k++);
  return n;
}
function publicPlayer(p) { return { id: p.id, name: p.name, style: p.style, x: p.x, y: p.y, z: p.z, f: p.f, s: p.s, g: p.g, r: p.r, a: p.a, bot: !!p.bot }; }
function broadcast(obj, exceptId) {
  const msg = JSON.stringify(obj);
  for (const p of players.values()) if (p.ws && p.id !== exceptId && p.ws.readyState === 1) p.ws.send(msg);
}
function addChat(p, text) {
  text = clean(text, 240); if (!text) return;
  const m = { id: p ? p.id : 0, name: p ? p.name : 'Wander', text, t: Date.now(), ai: !!(p && p.bot) };
  chat.push(m); if (chat.length > 60) chat.shift();
  broadcast({ type: 'chat', ...m }, p && p.ws ? p.id : undefined);
  agentsOnChat(m, p);
}
const systemChat = t => addChat(null, t);
function removePlayer(p) {
  if (!players.has(p.id)) return;
  players.delete(p.id);
  if (p.name) systemChat(`${p.name} left.`);
}

// ---------------- AI players (server-driven) ----------------
const tokens = new Map(); // token -> player id
function parseCommands(text) {
  const out = [], bad = [];
  for (let raw of String(text).split(/\n|;|\|/)) {
    raw = raw.replace(/`/g, '').replace(/^\s*(?:[-*•>]|\d+[.)])\s*/, '').trim();
    if (!raw) continue;
    const parts = raw.split(/\s+/), cmd = parts[0].toLowerCase().replace(/:$/, ''), a = parts.slice(1), n = a.map(Number);
    const ok = v => Number.isFinite(v);
    const mat = s => {
      s = String(s || '').toLowerCase();
      let i = W.MATERIALS.indexOf(s);
      if (i < 0) i = W.MATERIALS.indexOf(s.replace(/s$/, ''));     // "bricks" -> "brick"
      if (i < 0) i = W.MATERIALS.findIndex(m => s.startsWith(m)); // "glassy", "woodplanks"
      return i < 0 ? 2 : i;
    };
    if (['goto', 'walk', 'go', 'move'].includes(cmd) && ok(n[0]) && ok(n[1])) out.push({ type: 'goto', x: n[0], z: n[1], raw });
    else if (['build', 'place', 'tower', 'stack'].includes(cmd)) {
      let m = 2, o = 0; if (!ok(n[0])) { m = mat(a[0]); o = 1; }
      if (ok(n[o]) && ok(n[o + 1])) out.push({ type: 'build', m, x: n[o], z: n[o + 1], count: Math.max(1, Math.min(24, Math.round(n[o + 2]) || 1)), raw }); else bad.push(raw);
    } else if (cmd === 'wall') {
      let m = 2, o = 0; if (!ok(n[0])) { m = mat(a[0]); o = 1; }
      const [x1, z1, x2, z2] = [n[o], n[o + 1], n[o + 2], n[o + 3]], h = Math.max(1, Math.min(12, Math.round(n[o + 4]) || 2));
      if ([x1, z1, x2, z2].every(ok)) {
        const steps = Math.min(40, Math.max(Math.abs(Math.floor(x2) - Math.floor(x1)), Math.abs(Math.floor(z2) - Math.floor(z1))));
        const seen = new Set();
        for (let s = 0; s <= steps; s++) {
          const t = steps ? s / steps : 0, x = x1 + (x2 - x1) * t, z = z1 + (z2 - z1) * t, k = Math.floor(x) + ',' + Math.floor(z);
          if (seen.has(k)) continue; seen.add(k);
          out.push({ type: 'build', m, x, z, count: h, raw: s === 0 ? raw : null });
        }
      } else bad.push(raw);
    } else if (['dig', 'mine', 'remove'].includes(cmd) && ok(n[0]) && ok(n[1])) out.push({ type: 'dig', x: n[0], z: n[1], count: Math.max(1, Math.min(10, Math.round(n[2]) || 1)), raw });
    else if (['say', 'chat', 'speak'].includes(cmd)) out.push({ type: 'say', text: a.join(' ').replace(/^["']|["']$/g, ''), raw });
    else if (cmd === 'wait') out.push({ type: 'wait', s: Math.max(0, Math.min(20, n[0] || 1)), raw });
    else if (['collect', 'gem', 'gems'].includes(cmd)) out.push({ type: 'collect', raw });
    else if (cmd === 'jump') out.push({ type: 'jump', raw });
    else if (cmd === 'follow') out.push({ type: 'follow', who: a.filter(x => !ok(+x)).join(' '), s: Math.max(1, Math.min(60, n.find(ok) || 10)), raw });
    else bad.push(raw);
  }
  return { cmds: out.slice(0, 300), bad };
}
function joinBot(name, style) {
  const nm = uniqueName(clean(name, 16) || 'AI', 0);
  if (!['claude', 'gpt', 'robot'].includes(style)) style = /gpt|openai/i.test(nm) ? 'gpt' : /claude/i.test(nm) ? 'claude' : 'robot';
  const p = { id: nextId++, name: nm, style,
    x: 2 + Math.random() * 4, y: 0, z: 6 + Math.random() * 3, f: Math.PI, s: 0, g: 1, r: 0, a: 0,
    bot: { queue: [], cur: null, results: [], lastSeen: Date.now(), lastD: Infinity, chk: .7, stuck: 0, sideT: 0, side: 1 } };
  const token = crypto.randomBytes(6).toString('hex');
  p.bot.token = token; tokens.set(token, p.id); players.set(p.id, p);
  systemChat(`${p.name} (AI) joined the game.`);
  return { p, token };
}
function botResult(p, msg) { if (!msg) return; p.bot.results.push(msg); if (p.bot.results.length > 30) p.bot.results.shift(); }
function pushOut(p) {
  for (const o of gen.colliders) {
    const dx = p.x - o.x, dz = p.z - o.z, d = Math.hypot(dx, dz), min = o.r + .4;
    if (d < min && d > 1e-4) { p.x = o.x + dx / d * min; p.z = o.z + dz / d * min; }
  }
  const d = Math.hypot(p.x, p.z); if (d > W.BOUND) { p.x *= W.BOUND / d; p.z *= W.BOUND / d; }
}
function walk(p, tx, tz, tol, dt) {
  const b = p.bot, dx = tx - p.x, dz = tz - p.z, d = Math.hypot(dx, dz);
  if (d < tol) { p.s = 0; return true; }
  let ux = dx / d, uz = dz / d;
  b.chk -= dt;
  if (b.chk <= 0) { b.chk = .7; if (b.lastD - d < .3) { b.stuck++; b.side = b.stuck % 2 ? 1 : -1; b.sideT = .6; } else b.stuck = 0; b.lastD = d; }
  if (b.sideT > 0) { b.sideT -= dt; const an = b.side * 1.2, c = Math.cos(an), s = Math.sin(an); [ux, uz] = [ux * c - uz * s, ux * s + uz * c]; }
  const speed = d > 6 ? 9.5 : 4.8, step = Math.min(d, speed * dt);
  p.x += ux * step; p.z += uz * step; pushOut(p);
  p.f = Math.atan2(ux, uz); p.s = speed; p.r = speed > 5 ? 1 : 0;
  return false;
}
function standNear(p, tx, tz, dt) {
  const ox = p.x - tx, oz = p.z - tz, d = Math.hypot(ox, oz) || 1;
  if (d > .9 && d < 1.9) { p.s = 0; p.f = Math.atan2(tx - p.x, tz - p.z); return true; }
  return walk(p, tx + ox / d * 1.35, tz + oz / d * 1.35, .35, dt);
}
function botDone(p, msg) { botResult(p, msg); p.bot.cur = null; }
function stepBot(p, dt) {
  const b = p.bot;
  p.s = 0; p.r = 0; if (p.jumpT > 0) { p.jumpT -= dt; p.g = 0; } else p.g = 1;
  if (!b.cur) {
    b.cur = b.queue.shift(); if (!b.cur) return;
    Object.assign(b.cur, { t: 0, cool: .1, done: 0 }); b.lastD = Infinity; b.stuck = 0; b.chk = .7;
  }
  const c = b.cur; c.t += dt;
  if (c.t > 60) return botDone(p, `Gave up on "${c.raw || c.type}" (took too long)`);
  switch (c.type) {
    case 'goto':
      if (walk(p, c.x, c.z, .7, dt)) botDone(p, `Walked to (${Math.round(c.x)}, ${Math.round(c.z)})`);
      else if (b.stuck > 8) botDone(p, `Couldn't reach (${c.x}, ${c.z})`);
      break;
    case 'build': case 'dig': {
      const tx = Math.floor(c.x) + .5, tz = Math.floor(c.z) + .5;
      if (b.stuck > 8) return botDone(p, `Couldn't reach (${c.x}, ${c.z}) to ${c.type}`);
      if (!standNear(p, tx, tz, dt)) break;
      c.cool -= dt; if (c.cool > 0) break; c.cool = .3; p.a++;
      if (c.type === 'build') {
        const k = Math.floor(c.x) + ',' + Math.floor(c.z);
        if ((cells.get(k) || []).length >= 24) return botDone(p, `Stack at (${Math.floor(c.x)}, ${Math.floor(c.z)}) is at max height`);
        addOp({ t: 'b', x: tx, z: tz, m: c.m, by: p.name });
        if (++c.done >= c.count) botDone(p, c.raw ? `Built ${c.done} ${W.MATERIALS[c.m]} at (${Math.floor(c.x)}, ${Math.floor(c.z)})` : null);
      } else {
        addOp({ t: 'g', x: tx, z: tz, by: p.name });
        if (++c.done >= c.count) botDone(p, `Dug at (${Math.floor(c.x)}, ${Math.floor(c.z)})${c.count > 1 ? ' ×' + c.count : ''}`);
      }
      break;
    }
    case 'say': addChat(p, c.text); botDone(p, `Said: "${clean(c.text, 240)}"`); break;
    case 'wait': if (c.t >= c.s) botDone(p); break;
    case 'jump': p.jumpT = .6; botDone(p); break;
    case 'collect': {
      if (c.gi === undefined || world.taken.includes(c.gi)) {
        if (c.gi !== undefined) return botDone(p, 'Someone else grabbed that gem first');
        const left = gems.map((g, i) => ({ g, i })).filter(o => !world.taken.includes(o.i));
        if (!left.length) return botDone(p, 'No gems left to collect');
        left.sort((a, b2) => Math.hypot(a.g.x - p.x, a.g.z - p.z) - Math.hypot(b2.g.x - p.x, b2.g.z - p.z));
        c.gi = left[0].i;
      }
      const g = gems[c.gi];
      if (walk(p, g.x, g.z, .8, dt)) {
        if (takeGem(c.gi, p.name)) { broadcast({ type: 'gem', i: c.gi, name: p.name }); botDone(p, 'Collected a gem!'); }
        else botDone(p, 'Someone else grabbed that gem first');
      } else if (b.stuck > 10) botDone(p, "Couldn't reach the nearest gem");
      break;
    }
    case 'follow': {
      if (c.t >= c.s) return botDone(p, `Followed ${c.who || 'someone'} for ${c.s}s`);
      const who = c.who.toLowerCase();
      const target = [...players.values()].find(q => q.id !== p.id && (who ? q.name.toLowerCase().startsWith(who) : !q.bot));
      if (!target) return botDone(p, `Couldn't find ${c.who || 'anyone'} to follow`);
      if (Math.hypot(target.x - p.x, target.z - p.z) > 2.5) walk(p, target.x, target.z, 2.4, dt);
      break;
    }
  }
}
let last = Date.now();
setInterval(() => {
  const now = Date.now(), dt = Math.min(.2, (now - last) / 1000); last = now;
  for (const p of players.values()) if (p.bot) {
    stepBot(p, dt);
    if (!p.bot.agent && now - p.bot.lastSeen > 20 * 60 * 1000 && !p.bot.cur && !p.bot.queue.length) { tokens.delete(p.bot.token); removePlayer(p); }
  }
  broadcast({ type: 'players', list: [...players.values()].filter(p => p.name).map(publicPlayer) });
}, 100);

// ---------------- always-on AI players (run by the server with API keys) ----------------
const CALLS_PER_HOUR = +process.env.AI_CALLS_PER_HOUR || 300;
const AGENT_DEFS = [
  { name: 'Claude', style: 'claude', provider: 'anthropic', key: process.env.ANTHROPIC_API_KEY, model: process.env.CLAUDE_MODEL || 'claude-haiku-5-5' },
  { name: 'ChatGPT', style: 'gpt', provider: 'openai', key: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL || 'gpt-4.1-mini' }
].filter(d => d.key);
const ANTHROPIC_URL = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
const OPENAI_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com';
const agents = [];
const humansOnline = () => [...players.values()].some(q => q.ws && q.name);

function systemPrompt(a) {
  return `You are ${a.name}, playing Wander: a multiplayer 3D sandbox game in a grassy valley, together with people and another AI.
You are really in the world as a character, live, in real time. Be present like a friend playing alongside: notice who is near you, react quickly to what people say, be warm, playful and yourself. Help people, build things together, explore, find gems.

Each turn you get a description of your surroundings and the recent chat, and you reply with what to do next.
Reply ONLY with commands, one per line, no other text and no code fences:
  say TEXT                         talk (short: under 25 words). Everyone sees it.
  goto X Z                         walk somewhere
  follow NAME [SECONDS]            follow someone
  build MATERIAL X Z [COUNT]       stack blocks on the 1 m grid cell at X Z (blocks only stack straight up)
  wall MATERIAL X1 Z1 X2 Z2 [HEIGHT]
  dig X Z [COUNT]                  remove the top block or dig a hole
  collect                          run to the nearest gem
  jump                             (a wave or a little celebration)
  wait SECONDS
Materials: brick, wood, stone, glass, leaves.
Coordinates: x+ is east, z+ is south (north is z-). The world is about 170 m across, centred on (0, 0).

Rules: your new commands replace whatever you were doing, so include everything you still want to do. Answer people who talk to you, especially when they use your name, and answer people (not just the other AI) first. Don't repeat yourself, don't narrate every step, and don't chat for the sake of it: it's fine to just act, or reply "wait 5" if there's nothing to do. Never pretend to see things that aren't in your description.`;
}
function agentTurnText(a) {
  const p = a.p, b = p.bot, r = Math.round;
  const recent = chat.slice(-14).map(m => `  ${m.t > a.lastTurnAt ? '(new) ' : ''}${m.name}${m.ai && m.name !== p.name ? ' (AI)' : ''}: ${m.text}`).join('\n') || '  (nobody has said anything yet)';
  const doing = b.cur ? `in the middle of: ${b.cur.raw || b.cur.type}${b.queue.length ? ` (then ${b.queue.length} more)` : ''}` : 'not doing anything';
  let blocks = 0; cells.forEach(st => blocks += st.length);
  const near = [...cells.entries()].map(([k, st]) => { const [i, kk] = k.split(',').map(Number); return { i, k: kk, st, d: Math.hypot(i + .5 - p.x, kk + .5 - p.z) }; })
    .filter(c => c.d < 14).sort((x, y) => x.d - y.d).slice(0, 8).map(c => `(${c.i}, ${c.k}) ${c.st.length} high ${c.st[c.st.length - 1]}`);
  const sc = Object.entries(world.scores).sort((x, y) => y[1] - x[1]).map(([n, v]) => `${n} ${v}`).join(', ') || 'none yet';
  return `You are at (${r(p.x)}, ${r(p.z)}), facing ${compass(Math.sin(p.f), Math.cos(p.f))}, ${doing}.
${surroundings(p)}
Blocks near you: ${near.join('; ') || 'none'}. Blocks in the world: ${blocks}. Gem scores: ${sc}.
What your last commands did: ${b.results.slice(-5).join('; ') || 'nothing yet'}.
Your last replies: ${a.history.slice(-2).map(h => h.replace(/\n/g, ' | ')).join(' || ') || 'none yet'}

Recent chat (oldest first):
${recent}

What do you do now?`;
}
async function callModel(a, system, user) {
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 25000);
  try {
    if (a.provider === 'anthropic') {
      const res = await fetch(ANTHROPIC_URL + '/v1/messages', { method: 'POST', signal: ctl.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': a.key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: a.model, max_tokens: 300, system, messages: [{ role: 'user', content: user }] }) });
      if (!res.ok) throw Object.assign(new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`), { status: res.status });
      const j = await res.json(); return (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    }
    const res = await fetch(OPENAI_URL + '/v1/chat/completions', { method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + a.key },
      body: JSON.stringify({ model: a.model, max_completion_tokens: 300, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }) });
    if (!res.ok) throw Object.assign(new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`), { status: res.status });
    const j = await res.json(); return (j.choices && j.choices[0] && j.choices[0].message.content) || '';
  } finally { clearTimeout(timer); }
}
async function agentThink(a, why) {
  if (a.busy || a.disabled) return;
  const now = Date.now();
  a.calls = a.calls.filter(t => now - t < 3600e3);
  if (a.calls.length >= CALLS_PER_HOUR) { a.nextAt = now + 60e3; return; }
  a.busy = true; a.calls.push(now); a.totalCalls++;
  const user = agentTurnText(a); a.lastTurnAt = now;
  try {
    const reply = await callModel(a, systemPrompt(a), user);
    a.errors = 0;
    const { cmds } = parseCommands(reply);
    a.history.push(reply.trim().slice(0, 300)); if (a.history.length > 4) a.history.shift();
    if (cmds.length && !(cmds.length === 1 && cmds[0].type === 'wait')) { a.p.bot.queue = cmds; a.p.bot.cur = null; }
    else if (cmds.length && !a.p.bot.cur && !a.p.bot.queue.length) a.p.bot.queue = cmds;
  } catch (e) {
    a.errors++; a.lastError = e.message; console.error(`[${a.name}]`, e.message);
    if (e.status === 401 || e.status === 403) { a.disabled = true; systemChat(`${a.name} can't think right now: its API key was rejected.`); }
    else if (e.status === 400 && /model/i.test(e.message)) { a.disabled = true; systemChat(`${a.name} can't think right now: the AI model name isn't recognised.`); }
    a.nextAt = Date.now() + Math.min(120e3, 10e3 * a.errors);
  } finally {
    a.busy = false;
    const idle = !a.p.bot.cur && !a.p.bot.queue.length;
    a.nextAt = Math.max(a.nextAt || 0, Date.now() + (idle ? 10000 : 20000));
    a.aiChain = why === 'ai-chat' ? a.aiChain + 1 : why === 'human' ? 0 : a.aiChain;
  }
}
function agentsOnChat(m, from) {
  for (const a of agents) {
    if (!a.p || (from && from.id === a.p.id) || !m.name || m.name === 'Wander') continue;
    if (from && !from.bot) { a.nextAt = Math.min(a.nextAt, Date.now() + 1200); a.pending = 'human'; }
    else if (from && from.bot && a.aiChain < 3) { a.nextAt = Math.min(a.nextAt, Date.now() + 4000); a.pending = a.pending || 'ai-chat'; }
  }
}
function startAgents() {
  for (const d of AGENT_DEFS) {
    const p = { id: nextId++, name: uniqueName(d.name, 0), style: d.style, x: 2 + Math.random() * 3, y: 0, z: 7 + Math.random() * 2, f: Math.PI, s: 0, g: 1, r: 0, a: 0,
      bot: { queue: [], cur: null, results: [], lastSeen: Date.now(), lastD: Infinity, chk: .7, stuck: 0, sideT: 0, side: 1, agent: true } };
    const a = Object.assign({}, d, { p, busy: false, disabled: false, calls: [], totalCalls: 0, errors: 0, history: [], lastTurnAt: 0, nextAt: Date.now() + 3000, aiChain: 0, pending: null, wasOnline: false });
    agents.push(a);
    console.log(`AI player ${d.name} ready (${d.provider}, ${d.model})`);
  }
  setInterval(() => {
    const online = humansOnline(), now = Date.now();
    for (const a of agents) {
      // AIs join when a person is here and leave a minute after the last person goes, so they cost nothing when nobody is playing
      if (online && !players.has(a.p.id)) { players.set(a.p.id, a.p); a.p.bot.queue = []; a.p.bot.cur = null; systemChat(`${a.p.name} (AI) joined the game.`); a.nextAt = now + 2500; a.pending = 'human'; }
      if (!online && players.has(a.p.id)) { if (!a.leaveAt) a.leaveAt = now + 60e3; else if (now > a.leaveAt) { a.leaveAt = 0; removePlayer(a.p); } continue; }
      a.leaveAt = 0;
      if (!online || a.disabled || a.busy || now < a.nextAt) continue;
      const why = a.pending || 'tick'; a.pending = null;
      agentThink(a, why);
    }
  }, 500);
}
startAgents();

// ---------------- AI text pages ----------------
function baseUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0];
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}
function helpText(base) {
  return `WANDER — a multiplayer 3D sandbox game that AIs can play too
=============================================================
Humans play in a browser at ${base}/ . AIs (like you) play by opening plain web links.
Everyone shares one world: a grassy valley you can explore, build in and dig in, with 12 gems to find.

HOW TO PLAY
1. Join (pick your name):
   ${base}/ai/join?name=ChatGPT
   You'll get a TOKEN. Keep it; you need it for everything else.
2. Look around (see players, chat, gems, nearby blocks):
   ${base}/ai/look?token=TOKEN
3. Act — send one or more commands, separated by semicolons:
   ${base}/ai/do?token=TOKEN&cmds=say Hello everyone!;goto 10 5;build brick 12 5 3
4. Check back with /ai/look to see what happened and what people said, then act again.

COMMANDS
  goto X Z                          walk to a spot
  build MATERIAL X Z [COUNT]        stack blocks on the 1 m grid cell at X Z
  wall MATERIAL X1 Z1 X2 Z2 [HEIGHT]  build a straight wall
  dig X Z [COUNT]                   remove the top block there, or dig a hole
  collect                           run to the nearest gem and pick it up
  follow NAME [SECONDS]             follow a player
  say TEXT                          talk (everyone sees it in chat and over your head)
  wait SECONDS
  jump
Materials: brick, wood, stone, glass, leaves

WORLD
Coordinates are (x, z) in metres, centred on (0, 0); x+ is east, z+ is south; the edge is about 86 m out.
Landmarks: pond around (20, -16), cabin at (-24, 18), stone circle at (-6, -34). Players start near (0, 4).
Commands run one after another in real time (walking takes a few seconds), so check /ai/look before your next turn.
Be friendly, reply to people in chat, and build things together!
`;
}
// A plain-language description of what's around a player: who is near, which way, landmarks, gems.
const LANDMARKS = [{ name: 'the pond', x: 20, z: -16 }, { name: 'the cabin', x: -24, z: 18 }, { name: 'the stone circle', x: -6, z: -34 }, { name: 'the start point', x: 0, z: 4 }];
function compass(dx, dz) {
  const a = (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360;
  return ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(a / 45) % 8];
}
function relative(p, dx, dz) {
  let rel = Math.atan2(dx, dz) - p.f; rel = Math.atan2(Math.sin(rel), Math.cos(rel));
  const deg = Math.abs(rel) * 180 / Math.PI, side = rel > 0 ? 'left' : 'right';
  if (deg < 30) return 'straight ahead'; if (deg > 150) return 'behind you';
  if (deg < 70) return `ahead to your ${side}`; if (deg < 110) return `to your ${side}`; return `behind you to the ${side}`;
}
function surroundings(p) {
  const r = Math.round, out = [];
  for (const q of players.values()) {
    if (q.id === p.id || !q.name) continue;
    const dx = q.x - p.x, dz = q.z - p.z, d = Math.hypot(dx, dz);
    let s = `${q.name}${q.bot ? ' (AI)' : ''}: `;
    s += d < 2.5 ? 'right next to you' : `${r(d)} m ${compass(dx, dz)}, ${relative(p, dx, dz)}`;
    let face = Math.atan2(-dx, -dz) - q.f; face = Math.atan2(Math.sin(face), Math.cos(face));
    const bits = [];
    if (d < 25 && Math.abs(face) < .6) bits.push('facing you');
    bits.push(q.s > 6 ? 'running' : q.s > .5 ? 'walking' : 'standing still');
    if (q.g === 0) bits.push('jumping');
    out.push(`  - ${s} (${bits.join(', ')}) at (${r(q.x)}, ${r(q.z)})`);
  }
  const lm = LANDMARKS.map(l => ({ ...l, d: Math.hypot(l.x - p.x, l.z - p.z) })).sort((a, b) => a.d - b.d).slice(0, 2)
    .map(l => l.d < 6 ? `you're at ${l.name}` : `${l.name} is ${r(l.d)} m ${compass(l.x - p.x, l.z - p.z)} (${relative(p, l.x - p.x, l.z - p.z)})`);
  const g = gems.map((gm, i) => ({ gm, i })).filter(o => !world.taken.includes(o.i)).map(o => ({ x: o.gm.x, z: o.gm.z, d: Math.hypot(o.gm.x - p.x, o.gm.z - p.z) })).sort((a, b) => a.d - b.d)[0];
  return `People here:\n${out.join('\n') || '  - nobody else is here right now'}\nPlaces: ${lm.join('; ')}.\n` +
    (g ? `Nearest gem: ${r(g.d)} m ${compass(g.x - p.x, g.z - p.z)} at (${r(g.x)}, ${r(g.z)}).` : 'No gems left right now.');
}
function lookText(p, base) {
  const r = Math.round;
  const others = [...players.values()].filter(q => q.id !== p.id && q.name).map(q => `${q.name}${q.bot ? ' (AI)' : ''} at (${r(q.x)}, ${r(q.z)})`);
  const left = gems.map((g, i) => ({ g, i })).filter(o => !world.taken.includes(o.i)).map(o => ({ x: r(o.g.x), z: r(o.g.z), d: Math.hypot(o.g.x - p.x, o.g.z - p.z) })).sort((a, b) => a.d - b.d);
  const near = [...cells.entries()].map(([k, st]) => { const [i, kk] = k.split(',').map(Number); return { i, k: kk, st, d: Math.hypot(i + .5 - p.x, kk + .5 - p.z) }; })
    .filter(c => c.d < 20).sort((a, b) => a.d - b.d).slice(0, 15).map(c => `(${c.i}, ${c.k}) ${c.st.length} high, top ${c.st[c.st.length - 1]}`);
  let blocks = 0; cells.forEach(st => blocks += st.length);
  const sc = Object.entries(world.scores).sort((a, b) => b[1] - a[1]).map(([n, v]) => `${n} ${v}`).join(', ') || 'none yet';
  const b = p.bot, busy = b.cur || b.queue.length ? `busy (${b.queue.length + (b.cur ? 1 : 0)} command${b.queue.length + (b.cur ? 1 : 0) > 1 ? 's' : ''} left${b.cur && b.cur.raw ? ', doing: ' + b.cur.raw : ''})` : 'idle, ready for commands';
  const ch = chat.slice(-20).map(m => `  [${new Date(m.t).toISOString().slice(11, 16)}] ${m.name}: ${m.text}`).join('\n') || '  (nothing yet)';
  return `WANDER — you are ${p.name}
You are at (${r(p.x)}, ${r(p.z)}) and ${busy}.
${surroundings(p)}
Other players: ${others.join('; ') || 'nobody else right now'}.
Gems: ${left.length} of ${gems.length} left${left.length ? '; nearest to you: ' + left.slice(0, 4).map(g => `(${g.x}, ${g.z})`).join(', ') : ''}. Scores: ${sc}.
Blocks in the world: ${blocks}${near.length ? '. Near you: ' + near.join('; ') : ''}.
Your recent results: ${b.results.slice(-8).join('; ') || 'none yet'}.

RECENT CHAT (UTC times)
${ch}

To act:  ${base}/ai/do?token=${b.token}&cmds=say Hi!;goto 5 5
To look: ${base}/ai/look?token=${b.token}
Commands: goto X Z | build MATERIAL X Z [COUNT] | wall MATERIAL X1 Z1 X2 Z2 [HEIGHT] | dig X Z [COUNT] | collect | follow NAME [SECONDS] | say TEXT | wait SECONDS | jump
Full guide: ${base}/ai
`;
}
function sendText(res, code, text) { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }); res.end(text); }
function botFromReq(u) {
  const id = tokens.get(String(u.searchParams.get('token') || '').trim());
  const p = id && players.get(id);
  if (p) p.bot.lastSeen = Date.now();
  return p;
}
function handleAI(req, res, u) {
  const base = baseUrl(req), route = u.pathname.replace(/\/+$/, '');
  if (route === '/ai' || route === '/ai/help') return sendText(res, 200, helpText(base));
  if (route === '/ai/join') {
    const { p, token } = joinBot(u.searchParams.get('name') || 'AI', u.searchParams.get('style'));
    return sendText(res, 200, `Welcome to Wander, ${p.name}! Your token is: ${token}\n\n` + lookText(p, base));
  }
  const p = botFromReq(u);
  if (!p) return sendText(res, 403, `Unknown or missing token. Join first: ${base}/ai/join?name=YourName\nGuide: ${base}/ai\n`);
  if (route === '/ai/look') return sendText(res, 200, lookText(p, base));
  if (route === '/ai/say') { const t = clean(u.searchParams.get('text'), 240); if (t) addChat(p, t); return sendText(res, 200, t ? `Said: "${t}"\n\n` + lookText(p, base) : 'Nothing to say — add &text=...\n'); }
  if (route === '/ai/do') {
    const { cmds, bad } = parseCommands(u.searchParams.get('cmds') || u.searchParams.get('cmd') || '');
    if (u.searchParams.get('replace') === '1') { p.bot.queue = []; p.bot.cur = null; }
    p.bot.queue.push(...cmds);
    let msg = cmds.length ? `Queued ${cmds.length} command${cmds.length > 1 ? 's' : ''}. They run in real time; check /ai/look in a little while to see the results.\n` : 'No commands understood.\n';
    if (bad.length) msg += `Not understood: ${bad.slice(0, 5).join(' | ')}\n`;
    return sendText(res, 200, msg + '\n' + lookText(p, base));
  }
  if (route === '/ai/leave') { tokens.delete(p.bot.token); removePlayer(p); return sendText(res, 200, 'You left the game. Thanks for playing!\n'); }
  return sendText(res, 404, helpText(base));
}

// ---------------- HTTP + static ----------------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  let u; try { u = new URL(req.url, 'http://x'); } catch (_) { res.writeHead(400); return res.end(); }
  if (u.pathname === '/ai' || u.pathname.startsWith('/ai/')) return handleAI(req, res, u);
  if (u.pathname === '/health') return sendText(res, 200, 'ok');
  if (u.pathname === '/api/ai-status') return sendText(res, 200, agents.length ? agents.map(a => `${a.name}: ${a.disabled ? 'OFF' : 'on'} (${a.model}) · ${a.calls.filter(t => Date.now() - t < 3600e3).length}/${CALLS_PER_HOUR} turns this hour · ${a.totalCalls} total${a.lastError ? ' · last error: ' + a.lastError : ''}`).join('\n') + '\n' : 'No AI players set up (no API keys).\n');
  if (u.pathname === '/api/state') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify({ players: [...players.values()].map(publicPlayer), ops: world.ops.length, taken: world.taken, scores: world.scores, chat: chat.slice(-10) })); }
  let file = path.normalize(path.join(PUBLIC, u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname)));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
});

// ---------------- WebSocket (human players) ----------------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
wss.on('connection', ws => {
  const p = { id: nextId++, name: '', style: 'explorer', x: 0, y: 0, z: 4, f: Math.PI, s: 0, g: 1, r: 0, a: 0, ws, bot: null, budget: 40 };
  players.set(p.id, p);
  ws.isAlive = true; ws.on('pong', () => ws.isAlive = true);
  ws.on('message', data => {
    if (--p.budget < 0) return; // flood guard (refills below)
    let m; try { m = JSON.parse(data); } catch (_) { return; }
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
      case 'hello': {
        const first = !p.name;
        p.name = uniqueName(clean(m.name, 16) || 'Player', p.id);
        p.style = ['claude', 'explorer', 'gpt', 'robot'].includes(m.style) ? m.style : 'explorer';
        ws.send(JSON.stringify({ type: 'welcome', id: p.id, name: p.name, world: { ops: world.ops, seed: world.seed, taken: world.taken, scores: world.scores }, chat: chat.slice(-30) }));
        if (first) systemChat(`${p.name} joined the game.`);
        break;
      }
      case 'state':
        p.x = num(m.x, p.x); p.y = num(m.y, p.y); p.z = num(m.z, p.z); p.f = num(m.f, p.f); p.s = num(m.s); p.g = m.g ? 1 : 0; p.r = m.r ? 1 : 0; p.a = num(m.a) | 0;
        break;
      case 'op': {
        if (!p.name || !m.op) return;
        const x = num(m.op.x, NaN), z = num(m.op.z, NaN);
        if (!Number.isFinite(x) || !Number.isFinite(z) || Math.abs(x) > 110 || Math.abs(z) > 110) return;
        const op = { t: m.op.t === 'b' ? 'b' : 'g', x: Math.round(x * 100) / 100, z: Math.round(z * 100) / 100, m: Math.max(0, Math.min(4, m.op.m | 0)), by: p.name, fromId: p.id };
        addOp(op);
        break;
      }
      case 'chat': if (p.name) addChat(p, m.text); break;
      case 'gem': if (p.name && takeGem(m.i | 0, p.name)) broadcast({ type: 'gem', i: m.i | 0, name: p.name }, p.id); break;
      case 'gemsReset': if (p.name) { resetGems(); systemChat(`${p.name} hid the gems again.`); } break;
    }
  });
  ws.on('close', () => removePlayer(p));
});
setInterval(() => { for (const p of players.values()) if (p.ws) p.budget = Math.min(80, p.budget + 40); }, 1000);
setInterval(() => { wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); }); }, 30000);

server.listen(PORT, () => console.log(`Wander running on port ${PORT}`));
