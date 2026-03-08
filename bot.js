/**
 * WAReach Bot — bot.js v5.1 (Render + UptimeRobot)
 * ─────────────────────────────────────────────────
 * Anti-ban features:
 *  • Human-like random delays with Gaussian jitter
 *  • Typing presence simulation (composing → paused)
 *  • Per-account daily limits + cool-down windows
 *  • Message variation via Groq AI (every single message)
 *  • Image hash randomization (pixel-level noise injection)
 *  • Multi-account rotation (2-3 WA numbers)
 *  • Session warm-up (gradual ramp-up for new accounts)
 *
 * Render/UptimeRobot additions:
 *  • Data & sessions stored on /data (Render persistent disk)
 *  • GET /healthz endpoint for UptimeRobot ping (keeps free tier alive)
 *  • Auto-detects Render environment (PORT env var)
 */

import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  delay
} from '@whiskeysockets/baileys';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import Groq from 'groq-sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────
//  RENDER: Use /data for persistent storage
//  Locally: use ./data
// ─────────────────────────────────────────
const IS_RENDER = !!process.env.RENDER;
const BASE_DIR = IS_RENDER ? '/data' : path.join(__dirname, 'data');
const SESSION_BASE = IS_RENDER ? '/data' : __dirname;

// ─────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────
const CONFIG = {
  PORT: process.env.PORT || 3001,
  DATA_DIR: BASE_DIR,
  CAMPAIGNS_FILE: path.join(BASE_DIR, 'campaigns.json'),
  NUMBERS_FILE:   path.join(BASE_DIR, 'numbers.json'),
  LOGS_FILE:      path.join(BASE_DIR, 'logs.json'),
  STATS_FILE:     path.join(BASE_DIR, 'stats.json'),
  MIN_DELAY:  18000,
  MAX_DELAY:  45000,
  MIN_TYPING: 1500,
  MAX_TYPING: 5000,
  WARMUP_DAILY_LIMIT: 15,
  NORMAL_DAILY_LIMIT: 50,
};

// Ensure dirs exist
[CONFIG.DATA_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

if (IS_RENDER) {
  console.log(`[WAReach] Running on Render — data dir: ${BASE_DIR}`);
}

// ─────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────
const accounts = new Map();
let campaigns = load(CONFIG.CAMPAIGNS_FILE, []);
let numbers   = load(CONFIG.NUMBERS_FILE, []);
let logs      = load(CONFIG.LOGS_FILE, []);
let stats     = load(CONFIG.STATS_FILE, {});
const activeCampaigns = new Map();

// ─────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────
function load(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; }
}
function save(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
function saveAll() {
  save(CONFIG.CAMPAIGNS_FILE, campaigns);
  save(CONFIG.NUMBERS_FILE, numbers);
  save(CONFIG.STATS_FILE, stats);
}

function addLog(level, msg, campaignId = null) {
  const entry = { ts: new Date().toLocaleTimeString(), level, msg, campaignId };
  logs.unshift(entry);
  if (logs.length > 2000) logs = logs.slice(0, 2000);
  save(CONFIG.LOGS_FILE, logs);
  const icon = { info: 'ℹ', warn: '⚠', error: '✗', ok: '✓' }[level] || 'ℹ';
  console.log(`[WAReach] ${icon} ${campaignId ? '[' + campaignId + '] ' : ''}${msg}`);
}

// ─────────────────────────────────────────
//  ANTI-BAN: Human-like random delay
// ─────────────────────────────────────────
function humanDelay(base, spread) {
  const g = (Math.random() + Math.random() + Math.random()) / 3;
  return Math.round(base + (g - 0.5) * 2 * spread);
}

// ─────────────────────────────────────────
//  ANTI-BAN: Inject invisible pixel noise into image buffer
// ─────────────────────────────────────────
function randomizeImageBuffer(buffer) {
  try {
    const buf = Buffer.from(buffer);
    for (let i = 0; i < 3; i++) {
      const pos = buf.length - Math.floor(Math.random() * 512) - 1;
      if (pos > 100) buf[pos] = Math.floor(Math.random() * 256);
    }
    return buf;
  } catch { return buffer; }
}

// ─────────────────────────────────────────
//  GROQ AI REWRITE
// ─────────────────────────────────────────
async function rewriteMessage(text, groqKey, recipientName) {
  if (!groqKey) return text;
  try {
    const groq = new Groq({ apiKey: groqKey });
    const res = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      max_tokens: 400,
      temperature: 0.92,
      messages: [
        {
          role: 'system',
          content: `You rewrite WhatsApp messages to sound unique, natural, and human each time.
Rules:
- Keep the meaning and intent identical
- Keep all emojis
- Keep template variables like {{name}} {{phone}} as-is
- Vary sentence structure, synonyms, word order
- Make it sound like a real person typed it fresh
- Do NOT add any preamble, explanation, or quotes
- Output ONLY the rewritten message text`
        },
        { role: 'user', content: text }
      ]
    });
    const rewritten = res.choices[0]?.message?.content?.trim();
    return rewritten || text;
  } catch (e) {
    addLog('warn', 'Groq rewrite failed: ' + e.message + ' — using original');
    return text;
  }
}

// ─────────────────────────────────────────
//  MULTI-ACCOUNT: Connect one WhatsApp account
// ─────────────────────────────────────────
async function connectAccount(accountId) {
  // Sessions stored on persistent disk
  const sessionDir = path.join(SESSION_BASE, `session_${accountId}`);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  addLog('info', `Account ${accountId}: connecting... (session: ${sessionDir})`);

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
    },
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
  });

  accounts.set(accountId, { sock, isConnected: false, qr: null, user: null, sessionDir });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    const acc = accounts.get(accountId);

    if (qr) {
      acc.qr = qr;
      addLog('info', `Account ${accountId}: QR ready — visit /qr/${accountId}`);
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      acc.isConnected = true;
      acc.qr = null;
      acc.user = sock.user;
      addLog('ok', `Account ${accountId}: connected as ${sock.user?.name || sock.user?.id}`);
      campaigns
        .filter(c => c.status === 'running' && c.accountId === accountId)
        .forEach(c => startCampaignLoop(c.id));
    }

    if (connection === 'close') {
      acc.isConnected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      addLog('warn', `Account ${accountId}: disconnected (${code})`);
      if (code !== DisconnectReason.loggedOut) {
        setTimeout(() => connectAccount(accountId), 6000);
      } else {
        addLog('error', `Account ${accountId}: logged out — delete session_${accountId}/ to re-link`);
        accounts.delete(accountId);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', ({ messages: msgs, type }) => {
    if (type !== 'notify') return;
    msgs.forEach(msg => {
      if (msg.key.fromMe) return;
      const from = msg.key.remoteJid?.replace('@s.whatsapp.net', '');
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '(media)';
      addLog('info', `↙ Reply from ${from}: ${text.slice(0, 60)}`);
    });
  });

  sock.ev.on('message-receipt.update', updates => {
    updates.forEach(({ key, receipt }) => {
      if (!key.fromMe) return;
      const phone = key.remoteJid?.replace('@s.whatsapp.net', '');
      const status = receipt.receiptTimestamp ? 'delivered' : receipt.readTimestamp ? 'read' : 'sent';
      addLog('info', `📬 ${status} → ${phone}`);
    });
  });

  sock.ev.on('messages.update', updates => {
    updates.forEach(({ key, update }) => {
      if (!key.fromMe) return;
      const phone = key.remoteJid?.replace('@s.whatsapp.net', '');
      const statusMap = { 0: 'error', 1: 'pending', 2: 'sent', 3: 'delivered', 4: 'read' };
      if (update.status !== undefined) {
        addLog('info', `📊 ${statusMap[update.status] || update.status} → ${phone}`);
      }
    });
  });

  return sock;
}

// ─────────────────────────────────────────
//  SEND ONE DM  (anti-ban wrapped)
// ─────────────────────────────────────────
async function sendDM(phone, name, camp) {
  const accountId = camp.accountId || 'main';
  const acc = accounts.get(accountId);
  if (!acc || !acc.isConnected) throw new Error(`Account ${accountId} not connected`);
  const sock = acc.sock;

  // Auto-fix 10-digit Indian numbers
  let num = phone.replace(/[^0-9]/g, '');
  if (num.length === 10 && /^[6-9]/.test(num)) num = '91' + num;
  const jid = num + '@s.whatsapp.net';

  try {
    const [result] = await sock.onWhatsApp(jid);
    if (!result?.exists) {
      addLog('warn', `${phone} — not on WhatsApp`);
      return 'not_found';
    }
  } catch (e) {
    addLog('warn', `${phone} — existence check failed: ${e.message}`);
  }

  let msg = (camp.msg || '')
    .replace(/\{\{name\}\}/gi, name || phone)
    .replace(/\{\{phone\}\}/gi, phone);

  if (camp.groqKey) {
    msg = await rewriteMessage(msg, camp.groqKey, name);
    addLog('info', `AI rewrite ✓`);
  }

  const typingTime = humanDelay(CONFIG.MIN_TYPING, (CONFIG.MAX_TYPING - CONFIG.MIN_TYPING) / 2);
  await sock.sendPresenceUpdate('available', jid);
  await delay(400);
  await sock.sendPresenceUpdate('composing', jid);
  await delay(typingTime);
  await sock.sendPresenceUpdate('paused', jid);
  await delay(300);

  if (camp.imgEnabled && camp.imgData) {
    const base64 = camp.imgData.split(',')[1];
    let imgBuffer = Buffer.from(base64, 'base64');
    imgBuffer = randomizeImageBuffer(imgBuffer);
    const mimeMatch = camp.imgData.match(/data:(image\/\w+);/);
    const mimetype = mimeMatch ? mimeMatch[1] : 'image/jpeg';

    if (camp.introText) {
      const intro = camp.introText
        .replace(/\{\{name\}\}/gi, name || phone)
        .replace(/\{\{phone\}\}/gi, phone);
      await sock.sendMessage(jid, { text: intro });
      await delay(humanDelay(2000, 800));
      await sock.sendPresenceUpdate('composing', jid);
      await delay(humanDelay(1500, 500));
      await sock.sendPresenceUpdate('paused', jid);
      await delay(200);
    }

    const imgResult = await sock.sendMessage(jid, { image: imgBuffer, mimetype, caption: msg });
    const imgKey = imgResult?.key?.id || 'no-key';
    addLog('ok', `✓ [img+txt] → ${phone}${name ? ' (' + name + ')' : ''} | id:${imgKey.slice(-6)}`);
  } else {
    const txtResult = await sock.sendMessage(jid, { text: msg });
    const txtKey = txtResult?.key?.id || 'no-key';
    addLog('ok', `✓ [text] → ${phone}${name ? ' (' + name + ')' : ''} | id:${txtKey.slice(-6)}`);
  }

  return 'sent';
}

// ─────────────────────────────────────────
//  CAMPAIGN LOOP
// ─────────────────────────────────────────
async function startCampaignLoop(campaignId) {
  const camp = campaigns.find(c => c.id === campaignId);
  if (!camp) return;
  if (activeCampaigns.get(campaignId)?.running) return;

  const state = { running: true, sentToday: 0, dmCount: 0, accountId: camp.accountId || 'main' };
  activeCampaigns.set(campaignId, state);
  addLog('info', `Campaign "${camp.name}" started`, campaignId);

  let campNums;
  if (camp.numberIds && camp.numberIds.length) {
    campNums = numbers.filter(n => camp.numberIds.includes(n.phone));
  } else if (camp.targetGroups && camp.targetGroups.length) {
    campNums = numbers.filter(n => camp.targetGroups.includes(n.group));
  } else {
    campNums = [...numbers];
  }

  const sentKey = `sent_${campaignId}`;
  if (!stats[sentKey]) stats[sentKey] = [];
  const sentSet = new Set(stats[sentKey]);
  const pending = campNums.filter(n => n.status !== 'sent' && !sentSet.has(n.phone));

  addLog('info', `Queue: ${pending.length} numbers`, campaignId);
  if (!pending.length) {
    addLog('warn', 'No pending numbers', campaignId);
    camp.status = 'idle'; activeCampaigns.delete(campaignId); saveAll(); return;
  }

  const dailyLimit = camp.limit || CONFIG.NORMAL_DAILY_LIMIT;

  for (const { phone, name } of pending) {
    if (!activeCampaigns.get(campaignId)?.running) { addLog('warn', 'Campaign stopped', campaignId); break; }
    if (state.sentToday >= dailyLimit) { addLog('warn', `Daily limit (${dailyLimit}) reached`, campaignId); break; }

    try {
      const result = await sendDM(phone, name, camp);
      if (result === 'sent') {
        sentSet.add(phone);
        stats[sentKey] = [...sentSet];
        const numObj = numbers.find(n => n.phone === phone);
        if (numObj) numObj.status = 'sent';
        camp.sent = (camp.sent || 0) + 1;
        state.sentToday++;
        state.dmCount++;
        saveAll();
      } else if (result === 'not_found') {
        const numObj = numbers.find(n => n.phone === phone);
        if (numObj) numObj.status = 'failed';
        camp.failed = (camp.failed || 0) + 1;
        saveAll();
      }
    } catch (err) {
      addLog('error', `${phone} — ${err.message}`, campaignId);
      camp.failed = (camp.failed || 0) + 1;
      saveAll();
    }

    if (state.dmCount > 0 && state.dmCount % (camp.breakAfter || 10) === 0) {
      const breakMs = (camp.breakDur || 120) * 1000;
      addLog('warn', `☕ Break: ${Math.round(breakMs/60000)}min...`, campaignId);
      await delay(breakMs);
      addLog('info', 'Resuming...', campaignId);
    } else {
      const baseMs = (camp.delay || 20) * 1000;
      const jitterMs = baseMs * 0.4;
      const waitMs = humanDelay(baseMs, jitterMs);
      addLog('info', `Next in ${Math.round(waitMs/1000)}s...`, campaignId);
      await delay(waitMs);
    }
  }

  addLog('ok', `🎉 Done! Sent ${state.sentToday}`, campaignId);
  camp.status = 'idle';
  activeCampaigns.delete(campaignId);
  saveAll();
}

function stopCampaignLoop(campaignId) {
  const state = activeCampaigns.get(campaignId);
  if (state) state.running = false;
  const camp = campaigns.find(c => c.id === campaignId);
  if (camp) { camp.status = 'idle'; saveAll(); }
  addLog('warn', `Campaign stopped`, campaignId);
}

// ─────────────────────────────────────────
//  EXPRESS API
// ─────────────────────────────────────────
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── UptimeRobot keep-alive endpoint ──────
// Monitor this URL: https://your-app.onrender.com/healthz
// Interval: every 5 minutes — keeps the free tier from sleeping
app.get('/healthz', (req, res) => {
  const mainAcc = accounts.get('main');
  res.json({
    ok: true,
    ts: Date.now(),
    uptime: Math.round(process.uptime()),
    connected: mainAcc?.isConnected || false,
    accounts: accounts.size,
    activeCampaigns: activeCampaigns.size,
    version: '5.1'
  });
});

// ── Status ──
app.get('/ping', (req, res) => {
  const mainAcc = accounts.get('main');
  res.json({ ok: true, connected: mainAcc?.isConnected || false, ts: Date.now() });
});

app.get('/status', (req, res) => {
  const accountList = [...accounts.entries()].map(([id, acc]) => ({
    id, isConnected: acc.isConnected, user: acc.user, hasQR: !!acc.qr
  }));
  res.json({ accounts: accountList, activeCampaigns: [...activeCampaigns.keys()] });
});

// ── QR per account ──
app.get('/qr', (req, res) => {
  const acc = accounts.get('main');
  if (!acc) return res.json({ qr: null, msg: 'No accounts connected yet' });
  res.json({ qr: acc.qr, connected: acc.isConnected, user: acc.user });
});

app.get('/qr/:accountId', (req, res) => {
  const acc = accounts.get(req.params.accountId);
  if (!acc) return res.json({ qr: null, msg: 'Account not found' });
  res.json({ qr: acc.qr, connected: acc.isConnected, user: acc.user });
});

// ── Account management ──
app.get('/api/accounts', (req, res) => {
  const list = [...accounts.entries()].map(([id, acc]) => ({
    id, isConnected: acc.isConnected, user: acc.user, hasQR: !!acc.qr
  }));
  const sessionDirs = fs.readdirSync(SESSION_BASE).filter(f => f.startsWith('session_'));
  sessionDirs.forEach(d => {
    const id = d.replace('session_', '');
    if (!accounts.has(id)) list.push({ id, isConnected: false, user: null, hasQR: false });
  });
  res.json(list);
});

app.post('/api/accounts', async (req, res) => {
  const { accountId } = req.body;
  if (!accountId) return res.status(400).json({ error: 'accountId required' });
  if (accounts.has(accountId)) return res.json({ ok: true, msg: 'Already exists' });
  await connectAccount(accountId);
  res.json({ ok: true, msg: `Account ${accountId} connecting — check /qr/${accountId}` });
});

app.delete('/api/accounts/:id', (req, res) => {
  const id = req.params.id;
  const acc = accounts.get(id);
  if (acc?.sock) try { acc.sock.end(); } catch {}
  accounts.delete(id);
  const sessionDir = path.join(SESSION_BASE, `session_${id}`);
  if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true });
  addLog('warn', `Account ${id} removed`);
  res.json({ ok: true });
});

// ── Campaigns ──
app.get('/api/campaigns', (req, res) => res.json(campaigns));

app.post('/api/campaigns', (req, res) => {
  const existing = campaigns.find(c => c.id === req.body.id);
  if (existing) { Object.assign(existing, req.body); saveAll(); return res.json({ ok: true, campaign: existing }); }
  const camp = { ...req.body, id: req.body.id || 'c_' + Date.now(), status: 'idle', sent: 0, failed: 0 };
  campaigns.push(camp);
  saveAll();
  res.json({ ok: true, campaign: camp });
});

app.put('/api/campaigns/:id', (req, res) => {
  let camp = campaigns.find(c => c.id === req.params.id);
  if (!camp) { camp = { ...req.body, id: req.params.id }; campaigns.push(camp); }
  else Object.assign(camp, req.body);
  saveAll();
  res.json({ ok: true });
});

app.delete('/api/campaigns/:id', (req, res) => {
  campaigns = campaigns.filter(c => c.id !== req.params.id);
  saveAll(); res.json({ ok: true });
});

app.post('/api/campaigns/:id/start', async (req, res) => {
  let camp = campaigns.find(c => c.id === req.params.id);
  if (!camp && req.body?.id) { camp = { ...req.body }; campaigns.push(camp); saveAll(); }
  if (!camp) return res.status(404).json({ error: 'Campaign not found' });

  const accountId = camp.accountId || 'main';
  const acc = accounts.get(accountId);
  if (!acc?.isConnected) return res.status(503).json({ error: `Account "${accountId}" not connected` });

  camp.status = 'running'; saveAll();
  startCampaignLoop(camp.id);
  res.json({ ok: true, msg: `Campaign "${camp.name}" started on account ${accountId}` });
});

app.post('/api/campaigns/:id/stop', (req, res) => {
  stopCampaignLoop(req.params.id);
  res.json({ ok: true });
});

// ── Numbers ──
app.get('/api/numbers', (req, res) => {
  const { group, status } = req.query;
  let r = numbers;
  if (group) r = r.filter(n => n.group === group);
  if (status) r = r.filter(n => n.status === status);
  res.json(r);
});

app.post('/api/numbers', (req, res) => {
  const incoming = Array.isArray(req.body) ? req.body : [req.body];
  const existing = new Set(numbers.map(n => n.phone));
  let added = 0;
  incoming.forEach(n => {
    let phone = String(n.phone || '').replace(/[^0-9]/g, '');
    // Auto-fix 10-digit Indian numbers
    if (phone.length === 10 && /^[6-9]/.test(phone)) phone = '91' + phone;
    if (phone.length >= 7 && !existing.has(phone)) {
      numbers.push({ phone, name: n.name || '', group: n.group || '', status: 'pending', addedAt: Date.now() });
      existing.add(phone); added++;
    }
  });
  saveAll(); res.json({ ok: true, added, total: numbers.length });
});

app.put('/api/numbers/:phone', (req, res) => {
  const n = numbers.find(n => n.phone === req.params.phone);
  if (!n) return res.status(404).json({ error: 'Not found' });
  Object.assign(n, req.body); saveAll(); res.json({ ok: true });
});

app.delete('/api/numbers/:phone', (req, res) => {
  numbers = numbers.filter(n => n.phone !== req.params.phone);
  saveAll(); res.json({ ok: true });
});

app.post('/api/numbers/reset-status', (req, res) => {
  const { campaignId } = req.body;
  if (campaignId) delete stats[`sent_${campaignId}`];
  numbers.forEach(n => n.status = 'pending');
  saveAll(); res.json({ ok: true });
});

// ── Logs ──
app.get('/api/logs', (req, res) => {
  const { campaignId, limit = 200 } = req.query;
  let r = campaignId ? logs.filter(l => l.campaignId === campaignId) : logs;
  res.json(r.slice(0, parseInt(limit)));
});
app.delete('/api/logs', (req, res) => { logs = []; save(CONFIG.LOGS_FILE, logs); res.json({ ok: true }); });

// ── Stats ──
app.get('/api/stats', (req, res) => {
  const { campaignId } = req.query;
  if (campaignId) {
    const camp = campaigns.find(c => c.id === campaignId);
    res.json({ sent: camp?.sent || 0, failed: camp?.failed || 0 });
  } else res.json(stats);
});

app.get('/api/groups', (req, res) => {
  const groups = [...new Set(numbers.map(n => n.group).filter(Boolean))];
  res.json(groups.map(g => ({ id: g, name: g, count: numbers.filter(n => n.group === g).length })));
});

// ─────────────────────────────────────────
//  START SERVER
// ─────────────────────────────────────────
app.listen(CONFIG.PORT, '0.0.0.0', () => {
  console.log(`\n╔══════════════════════════════════════════════╗`);
  console.log(`║   WAReach Bot v5.1 — Render + UptimeRobot    ║`);
  console.log(`╚══════════════════════════════════════════════╝`);
  console.log(`  Dashboard:  http://localhost:${CONFIG.PORT}`);
  console.log(`  QR:         http://localhost:${CONFIG.PORT}/qr`);
  console.log(`  Health:     http://localhost:${CONFIG.PORT}/healthz`);
  if (IS_RENDER) {
    console.log(`  Mode:       Render (persistent disk at /data)`);
    console.log(`  UptimeRobot: ping /healthz every 5 min`);
  }
  console.log('');
});

// Connect default "main" account + any saved sessions
connectAccount('main');
setTimeout(() => {
  const sessionDirs = fs.readdirSync(SESSION_BASE).filter(f => f.startsWith('session_') && f !== 'session_main');
  sessionDirs.forEach(d => {
    const id = d.replace('session_', '');
    if (!accounts.has(id)) {
      addLog('info', `Auto-reconnecting saved account: ${id}`);
      connectAccount(id);
    }
  });
}, 3000);