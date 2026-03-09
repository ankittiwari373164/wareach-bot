/**
 * WAReach Bot — bot.js v6.0 (Render Free + MongoDB Atlas)
 * ─────────────────────────────────────────────────────────
 * Storage: MongoDB Atlas (free 512MB) for ALL persistence:
 *   • WhatsApp session credentials (creds + signal keys)
 *   • Campaigns, Numbers, Logs, Stats
 *
 * Anti-ban:
 *   • Human-like Gaussian random delays
 *   • Typing presence simulation
 *   • Image hash randomization
 *   • Groq AI message rewrite
 *   • Multi-account support
 *
 * Render Free Tier:
 *   • GET /healthz → UptimeRobot pings this every 5 min (no sleep)
 *   • Binds 0.0.0.0 (required by Render)
 *   • MONGODB_URI set in Render → Environment tab
 */

import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  delay,
  initAuthCreds,
  BufferJSON,
  proto
} from '@whiskeysockets/baileys';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import Groq from 'groq-sdk';
import { MongoClient } from 'mongodb';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────
const CONFIG = {
  PORT: process.env.PORT || 3001,
  MONGODB_URI: process.env.MONGODB_URI || '',
  MIN_DELAY:  18000,
  MAX_DELAY:  45000,
  MIN_TYPING: 1500,
  MAX_TYPING: 5000,
  NORMAL_DAILY_LIMIT: 50,
};

// ─────────────────────────────────────────
//  MONGODB CONNECTION
// ─────────────────────────────────────────
let db = null;

async function connectMongo() {
  if (!CONFIG.MONGODB_URI) {
    console.error('[WAReach] FATAL: MONGODB_URI env var not set!');
    console.error('[WAReach] → Set it in Render dashboard → Environment tab');
    console.error('[WAReach] → Get free URI from https://cloud.mongodb.com');
    process.exit(1);
  }
  try {
    const client = new MongoClient(CONFIG.MONGODB_URI, {
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
    });
    await client.connect();
    db = client.db('wareach');
    console.log('[WAReach] ✓ MongoDB Atlas connected');
    // Indexes
    await db.collection('sessions').createIndex({ accountId: 1, key: 1 }, { unique: true });
    await db.collection('numbers').createIndex({ phone: 1 }, { unique: true });
  } catch (err) {
    console.error('[WAReach] MongoDB failed:', err.message);
    setTimeout(connectMongo, 5000);
  }
}

// ─────────────────────────────────────────
//  MONGO AUTH STATE  (Baileys session → MongoDB)
//  Replaces useMultiFileAuthState (which needs disk)
// ─────────────────────────────────────────
async function useMongoAuthState(accountId) {
  const col = db.collection('sessions');

  const readData = async (key) => {
    const doc = await col.findOne({ accountId, key });
    if (!doc) return null;
    return JSON.parse(doc.value, BufferJSON.reviver);
  };

  const writeData = async (key, data) => {
    const value = JSON.stringify(data, BufferJSON.replacer);
    await col.updateOne(
      { accountId, key },
      { $set: { accountId, key, value, updatedAt: new Date() } },
      { upsert: true }
    );
  };

  const removeData = async (key) => {
    await col.deleteOne({ accountId, key });
  };

  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async id => {
            const val = await readData(`key-${type}-${id}`);
            if (val) {
              data[id] = type === 'app-state-sync-key'
                ? proto.Message.AppStateSyncKeyData.fromObject(val)
                : val;
            }
          }));
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const val = data[category][id];
              tasks.push(
                val
                  ? writeData(`key-${category}-${id}`, val)
                  : removeData(`key-${category}-${id}`)
              );
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: () => writeData('creds', creds)
  };
}

// ─────────────────────────────────────────
//  DATA HELPERS
// ─────────────────────────────────────────
const upsert = (col, filter, data) =>
  db.collection(col).updateOne(filter, { $set: { ...data, _updatedAt: new Date() } }, { upsert: true });

const del = (col, filter) => db.collection(col).deleteOne(filter);

// ─────────────────────────────────────────
//  STATE  (in-memory, loaded from Mongo on boot)
// ─────────────────────────────────────────
const accounts = new Map();
let campaigns = [];
let numbers   = [];
let logs      = [];
let stats     = {};
const activeCampaigns = new Map();

async function loadFromMongo() {
  campaigns = await db.collection('campaigns').find({}).toArray();
  numbers   = await db.collection('numbers').find({}).toArray();
  logs      = await db.collection('logs').find({}).sort({ _id: -1 }).limit(500).toArray();
  const statDoc = await db.collection('meta').findOne({ _id: 'stats' });
  stats = statDoc?.data || {};
  console.log(`[WAReach] Loaded: ${campaigns.length} campaigns, ${numbers.length} numbers from MongoDB`);
}

async function saveAll() {
  // Use bulkWrite for numbers — single DB round trip instead of 937 parallel ops
  try {
    if (numbers.length) {
      const numOps = numbers.map(n => ({
        updateOne: {
          filter: { phone: n.phone },
          update: { $set: { ...n, _updatedAt: new Date() } },
          upsert: true
        }
      }));
      // Process in batches of 100 to avoid memory spikes
      for (let i = 0; i < numOps.length; i += 100) {
        await db.collection('numbers').bulkWrite(numOps.slice(i, i + 100), { ordered: false });
      }
    }
    // Campaigns are few, save normally
    for (const c of campaigns) {
      await upsert('campaigns', { id: c.id }, c);
    }
    await db.collection('meta').updateOne(
      { _id: 'stats' },
      { $set: { _id: 'stats', data: stats, _updatedAt: new Date() } },
      { upsert: true }
    );
  } catch(e) {
    console.error('[WAReach] saveAll error:', e.message);
  }
}

// Lightweight save — only update ONE number status (called per DM instead of saveAll)
async function saveNumberStatus(phone, status) {
  try {
    await db.collection('numbers').updateOne({ phone }, { $set: { status, _updatedAt: new Date() } });
  } catch(e) {}
}

// Lightweight save — only update campaign counters
async function saveCampaignStats(camp) {
  try {
    await db.collection('campaigns').updateOne(
      { id: camp.id },
      { $set: { sent: camp.sent, failed: camp.failed, status: camp.status, _updatedAt: new Date() } }
    );
    await db.collection('meta').updateOne(
      { _id: 'stats' },
      { $set: { _id: 'stats', data: stats, _updatedAt: new Date() } },
      { upsert: true }
    );
  } catch(e) {}
}

// ─────────────────────────────────────────
//  LOGGING
// ─────────────────────────────────────────
function addLog(level, msg, campaignId = null) {
  const entry = { ts: new Date().toLocaleTimeString(), level, msg, campaignId, createdAt: new Date() };
  logs.unshift(entry);
  if (logs.length > 500) logs = logs.slice(0, 500);
  db?.collection('logs').insertOne({ ...entry }).catch(() => {});
  // Prune logs only occasionally (every 100 entries) to avoid constant DB ops
  if (logs.length % 100 === 0) {
    db?.collection('logs').deleteMany({ createdAt: { $lt: new Date(Date.now() - 7 * 86400000) } }).catch(() => {});
  }
  const icon = { info: 'ℹ', warn: '⚠', error: '✗', ok: '✓' }[level] || 'ℹ';
  console.log(`[WAReach] ${icon} ${campaignId ? '[' + campaignId + '] ' : ''}${msg}`);
}

// ─────────────────────────────────────────
//  ANTI-BAN HELPERS
// ─────────────────────────────────────────
function humanDelay(base, spread) {
  const g = (Math.random() + Math.random() + Math.random()) / 3;
  return Math.round(base + (g - 0.5) * 2 * spread);
}

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
async function rewriteMessage(text, groqKey) {
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
          content: `Rewrite this WhatsApp message to sound unique and human each time.
- Keep meaning, emojis, and {{variables}} identical
- Vary sentence structure and word choice
- Output ONLY the rewritten message, no preamble`
        },
        { role: 'user', content: text }
      ]
    });
    return res.choices[0]?.message?.content?.trim() || text;
  } catch (e) {
    addLog('warn', 'Groq rewrite failed: ' + e.message);
    return text;
  }
}

// ─────────────────────────────────────────
//  CONNECT WHATSAPP ACCOUNT
// ─────────────────────────────────────────
async function connectAccount(accountId) {
  addLog('info', `Account ${accountId}: connecting...`);

  let authState;
  try {
    authState = await useMongoAuthState(accountId);
  } catch(e) {
    addLog('warn', `Account ${accountId}: session load failed (${e.message}) — clearing and starting fresh`);
    await db.collection('sessions').deleteMany({ accountId });
    authState = await useMongoAuthState(accountId);
  }
  const { state, saveCreds } = authState;
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

  accounts.set(accountId, { sock, isConnected: false, qr: null, user: null });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    const acc = accounts.get(accountId);

    if (qr) {
      acc.qr = qr;
      addLog('info', `Account ${accountId}: QR ready → scan at dashboard or /qr/${accountId}`);
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      acc.isConnected = true;
      acc.qr = null;
      acc.user = sock.user;
      addLog('ok', `Account ${accountId}: connected as ${sock.user?.name || sock.user?.id}`);
      // Resume running campaigns
      campaigns
        .filter(c => c.status === 'running' && (c.accountId || 'main') === accountId)
        .forEach(c => startCampaignLoop(c.id));
    }

    if (connection === 'close') {
      acc.isConnected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      addLog('warn', `Account ${accountId}: disconnected (code: ${code})`);

      if (code === DisconnectReason.loggedOut) {
        // Intentional logout — clear session, don't reconnect
        addLog('error', `Account ${accountId}: logged out — scan QR again`);
        accounts.delete(accountId);
        await db.collection('sessions').deleteMany({ accountId });

      } else if (code === 440) {
        // 440 = Conflict — another device/session took over
        // Wait longer before reconnecting to let the conflict resolve
        addLog('warn', `Account ${accountId}: session conflict (440) — waiting 15s then reconnecting`);
        addLog('warn', `If this keeps looping: on your phone → WhatsApp → Linked Devices → log out wareach-bot → re-scan QR`);
        setTimeout(() => connectAccount(accountId), 15000);

      } else if (code === 401) {
        // 401 = Unauthorized — session expired, needs fresh QR
        addLog('warn', `Account ${accountId}: session expired (401) — clearing session, re-scan QR`);
        accounts.delete(accountId);
        await db.collection('sessions').deleteMany({ accountId });
        setTimeout(() => connectAccount(accountId), 3000);

      } else {
        // Other disconnect — standard 6s reconnect with jitter
        const wait = 6000 + Math.floor(Math.random() * 4000);
        setTimeout(() => connectAccount(accountId), wait);
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

  sock.ev.on('messages.update', updates => {
    updates.forEach(({ key, update }) => {
      if (!key.fromMe) return;
      const phone = key.remoteJid?.replace('@s.whatsapp.net', '');
      const statusMap = { 0: 'error', 1: 'pending', 2: 'sent', 3: 'delivered', 4: 'read' };
      if (update.status !== undefined)
        addLog('info', `📊 ${statusMap[update.status] || update.status} → ${phone}`);
    });
  });
}

// ─────────────────────────────────────────
//  SEND ONE DM
// ─────────────────────────────────────────
async function sendDM(phone, name, camp) {
  const accountId = camp.accountId || 'main';
  const acc = accounts.get(accountId);
  if (!acc?.isConnected) throw new Error(`Account ${accountId} not connected`);
  const sock = acc.sock;

  let num = phone.replace(/[^0-9]/g, '');
  if (num.length === 10 && /^[6-9]/.test(num)) num = '91' + num;
  const jid = num + '@s.whatsapp.net';

  try {
    const [result] = await sock.onWhatsApp(jid);
    if (!result?.exists) { addLog('warn', `${phone} — not on WhatsApp`); return 'not_found'; }
  } catch (e) {
    addLog('warn', `${phone} — check failed: ${e.message} (continuing)`);
  }

  let msg = (camp.msg || '')
    .replace(/\{\{name\}\}/gi, name || phone)
    .replace(/\{\{phone\}\}/gi, phone);

  if (camp.groqKey) { msg = await rewriteMessage(msg, camp.groqKey); addLog('info', 'AI rewrite ✓'); }

  // Simulate typing
  const typingTime = humanDelay(CONFIG.MIN_TYPING, (CONFIG.MAX_TYPING - CONFIG.MIN_TYPING) / 2);
  await sock.sendPresenceUpdate('available', jid);
  await delay(400);
  await sock.sendPresenceUpdate('composing', jid);
  await delay(typingTime);
  await sock.sendPresenceUpdate('paused', jid);
  await delay(300);

  if (camp.imgEnabled && camp.imgData) {
    const base64 = camp.imgData.split(',')[1];
    let imgBuffer = randomizeImageBuffer(Buffer.from(base64, 'base64'));
    const mimeMatch = camp.imgData.match(/data:(image\/\w+);/);
    const mimetype = mimeMatch ? mimeMatch[1] : 'image/jpeg';

    if (camp.introText) {
      const intro = camp.introText.replace(/\{\{name\}\}/gi, name || phone).replace(/\{\{phone\}\}/gi, phone);
      await sock.sendMessage(jid, { text: intro });
      await delay(humanDelay(2000, 800));
      await sock.sendPresenceUpdate('composing', jid);
      await delay(humanDelay(1500, 500));
    }

    const r = await sock.sendMessage(jid, { image: imgBuffer, mimetype, caption: msg });
    addLog('ok', `✓ [img+txt] → ${phone}${name ? ' (' + name + ')' : ''} | id:${r?.key?.id?.slice(-6)}`);
  } else {
    const r = await sock.sendMessage(jid, { text: msg });
    addLog('ok', `✓ [text] → ${phone}${name ? ' (' + name + ')' : ''} | id:${r?.key?.id?.slice(-6)}`);
  }

  return 'sent';
}

// ─────────────────────────────────────────
//  CAMPAIGN LOOP
// ─────────────────────────────────────────
async function startCampaignLoop(campaignId) {
  const camp = campaigns.find(c => c.id === campaignId);
  if (!camp || activeCampaigns.get(campaignId)?.running) return;

  const state = { running: true, sentToday: 0, dmCount: 0 };
  activeCampaigns.set(campaignId, state);
  addLog('info', `Campaign "${camp.name}" started`, campaignId);

  let campNums = camp.numberIds?.length
    ? numbers.filter(n => camp.numberIds.includes(n.phone))
    : camp.targetGroups?.length
      ? numbers.filter(n => camp.targetGroups.includes(n.group))
      : [...numbers];

  const sentKey = `sent_${campaignId}`;
  if (!stats[sentKey]) stats[sentKey] = [];
  const sentSet = new Set(stats[sentKey]);
  const pending = campNums.filter(n => n.status !== 'sent' && !sentSet.has(n.phone));

  addLog('info', `Queue: ${pending.length} numbers`, campaignId);
  if (!pending.length) {
    addLog('warn', 'No pending numbers', campaignId);
    camp.status = 'idle'; activeCampaigns.delete(campaignId); await saveAll(); return;
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
        // Lightweight saves — don't hammer MongoDB with all 937 numbers every DM
        await saveNumberStatus(phone, 'sent');
        await saveCampaignStats(camp);
      } else if (result === 'not_found') {
        const numObj = numbers.find(n => n.phone === phone);
        if (numObj) numObj.status = 'failed';
        camp.failed = (camp.failed || 0) + 1;
        await saveNumberStatus(phone, 'failed');
        await saveCampaignStats(camp);
      }
    } catch (err) {
      addLog('error', `${phone} — ${err.message}`, campaignId);
      camp.failed = (camp.failed || 0) + 1;
      await saveCampaignStats(camp);
    }

    if (state.dmCount > 0 && state.dmCount % (camp.breakAfter || 10) === 0) {
      const breakMs = (camp.breakDur || 120) * 1000;
      addLog('warn', `☕ Break: ${Math.round(breakMs / 60000)}min...`, campaignId);
      await delay(breakMs);
      addLog('info', 'Resuming...', campaignId);
    } else {
      const baseMs = (camp.delay || 20) * 1000;
      const waitMs = humanDelay(baseMs, baseMs * 0.4);
      addLog('info', `Next in ${Math.round(waitMs / 1000)}s...`, campaignId);
      await delay(waitMs);
    }
  }

  addLog('ok', `🎉 Done! Sent ${state.sentToday}`, campaignId);
  camp.status = 'idle';
  activeCampaigns.delete(campaignId);
  await saveAll();
}

function stopCampaignLoop(campaignId) {
  const s = activeCampaigns.get(campaignId);
  if (s) s.running = false;
  const camp = campaigns.find(c => c.id === campaignId);
  if (camp) { camp.status = 'idle'; saveAll(); }
  addLog('warn', 'Campaign stopped', campaignId);
}

// ─────────────────────────────────────────
//  EXPRESS API
// ─────────────────────────────────────────
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// UptimeRobot keep-alive — ping this URL every 5 min
app.get('/healthz', (req, res) => res.json({
  ok: true, ts: Date.now(),
  uptime: Math.round(process.uptime()),
  connected: accounts.get('main')?.isConnected || false,
  accounts: accounts.size,
  activeCampaigns: activeCampaigns.size,
  mongoConnected: !!db,
  version: '6.0'
}));

app.get('/ping', (req, res) => res.json({ ok: true, connected: accounts.get('main')?.isConnected || false, ts: Date.now() }));

app.get('/status', (req, res) => res.json({
  accounts: [...accounts.entries()].map(([id, acc]) => ({ id, isConnected: acc.isConnected, user: acc.user, hasQR: !!acc.qr })),
  activeCampaigns: [...activeCampaigns.keys()]
}));

app.get('/qr', (req, res) => {
  const acc = accounts.get('main');
  res.json({ qr: acc?.qr || null, connected: acc?.isConnected || false, user: acc?.user || null });
});

// /reset-session — clears saved session so fresh QR is generated
app.get('/reset-session', async (req, res) => {
  const accountId = req.query.account || 'main';
  try {
    const acc = accounts.get(accountId);
    if (acc?.sock) try { acc.sock.end(); } catch {}
    accounts.delete(accountId);
    await db.collection('sessions').deleteMany({ accountId });
    addLog('warn', `Session reset for ${accountId} — reconnecting fresh`);
    setTimeout(() => connectAccount(accountId), 1000);
    res.send(`<html><body style="background:#0a0f0a;color:#25D366;font-family:sans-serif;padding:40px;text-align:center">
      <h2>✓ Session cleared for "${accountId}"</h2>
      <p style="color:#5a7a5a">New QR generating... wait 10 seconds then:</p>
      <a href="/scan" style="color:#25D366;font-size:18px">→ Go to /scan to scan QR</a>
    </body></html>`);
  } catch(e) {
    res.send('Error: ' + e.message);
  }
});

// /scan — browser page that renders the QR as a scannable image
app.get('/scan', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="refresh" content="8">
<title>WAReach QR</title>
<style>
  body{background:#0a0f0a;color:#e8f5e8;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;text-align:center}
  h2{color:#25D366;margin-bottom:8px}
  p{color:#5a7a5a;font-size:14px;margin-bottom:20px}
  #qr{background:#fff;padding:16px;border-radius:12px;display:inline-block;min-width:100px;min-height:100px}
  .ok{color:#25D366;font-size:18px;margin-top:16px}
  .err{color:#ffaa00;font-size:14px;margin-top:16px}
  small{color:#3a5a3a;font-size:12px;margin-top:12px;display:block}
</style>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
</head>
<body>
<h2>📱 WAReach — Scan to Connect</h2>
<p>Scan with WhatsApp → Settings → Linked Devices → Link a Device</p>
<div id="qr"></div>
<div id="msg" class="err">Loading...</div>
<small>Page auto-refreshes every 8 seconds</small>
<script>
async function load(){
  try{
    const r=await fetch('/qr');
    const d=await r.json();
    if(d.connected){
      document.getElementById('qr').innerHTML='<div style="font-size:60px;padding:20px">✅</div>';
      document.getElementById('msg').className='ok';
      document.getElementById('msg').textContent='Connected as: '+(d.user?.name||d.user?.id||'WhatsApp');
      return;
    }
    if(d.qr){
      document.getElementById('qr').innerHTML='';
      new QRCode(document.getElementById('qr'),{text:d.qr,width:256,height:256,correctLevel:QRCode.CorrectLevel.L});
      document.getElementById('msg').className='ok';
      document.getElementById('msg').textContent='Scan now — refreshes in 8s';
    } else {
      document.getElementById('msg').className='err';
      document.getElementById('msg').textContent='Waiting for QR... retrying in 5s';
      setTimeout(load,5000);
    }
  }catch(e){
    document.getElementById('msg').textContent='Bot starting up... retrying';
    setTimeout(load,5000);
  }
}
load();
</script>
</body>
</html>`);
});

app.get('/qr/:accountId', (req, res) => {
  const acc = accounts.get(req.params.accountId);
  if (!acc) return res.json({ qr: null, msg: 'Account not found' });
  res.json({ qr: acc.qr, connected: acc.isConnected, user: acc.user });
});

app.get('/api/accounts', async (req, res) => {
  const list = [...accounts.entries()].map(([id, acc]) => ({ id, isConnected: acc.isConnected, user: acc.user, hasQR: !!acc.qr }));
  const savedIds = await db.collection('sessions').distinct('accountId');
  savedIds.forEach(id => { if (!accounts.has(id)) list.push({ id, isConnected: false, user: null, hasQR: false }); });
  res.json(list);
});

app.post('/api/accounts', async (req, res) => {
  const { accountId } = req.body;
  if (!accountId) return res.status(400).json({ error: 'accountId required' });
  if (accounts.has(accountId)) return res.json({ ok: true, msg: 'Already exists' });
  connectAccount(accountId);
  res.json({ ok: true, msg: `Account ${accountId} connecting — check /qr/${accountId}` });
});

app.delete('/api/accounts/:id', async (req, res) => {
  const id = req.params.id;
  const acc = accounts.get(id);
  if (acc?.sock) try { acc.sock.end(); } catch {}
  accounts.delete(id);
  await db.collection('sessions').deleteMany({ accountId: id });
  addLog('warn', `Account ${id} removed`);
  res.json({ ok: true });
});

app.get('/api/campaigns', (req, res) => res.json(campaigns));

app.post('/api/campaigns', async (req, res) => {
  const existing = campaigns.find(c => c.id === req.body.id);
  if (existing) { Object.assign(existing, req.body); await upsert('campaigns', { id: existing.id }, existing); return res.json({ ok: true, campaign: existing }); }
  const camp = { ...req.body, id: req.body.id || 'c_' + Date.now(), status: 'idle', sent: 0, failed: 0 };
  campaigns.push(camp);
  await upsert('campaigns', { id: camp.id }, camp);
  res.json({ ok: true, campaign: camp });
});

app.put('/api/campaigns/:id', async (req, res) => {
  let camp = campaigns.find(c => c.id === req.params.id);
  if (!camp) { camp = { ...req.body, id: req.params.id }; campaigns.push(camp); }
  else Object.assign(camp, req.body);
  await upsert('campaigns', { id: req.params.id }, camp);
  res.json({ ok: true });
});

app.delete('/api/campaigns/:id', async (req, res) => {
  campaigns = campaigns.filter(c => c.id !== req.params.id);
  await del('campaigns', { id: req.params.id });
  res.json({ ok: true });
});

app.post('/api/campaigns/:id/start', async (req, res) => {
  let camp = campaigns.find(c => c.id === req.params.id);
  if (!camp && req.body?.id) { camp = { ...req.body }; campaigns.push(camp); await upsert('campaigns', { id: camp.id }, camp); }
  if (!camp) return res.status(404).json({ error: 'Campaign not found' });
  const accountId = camp.accountId || 'main';
  const acc = accounts.get(accountId);
  if (!acc?.isConnected) return res.status(503).json({ error: `Account "${accountId}" not connected` });
  camp.status = 'running';
  await upsert('campaigns', { id: camp.id }, camp);
  startCampaignLoop(camp.id);
  res.json({ ok: true, msg: `Campaign "${camp.name}" started` });
});

app.post('/api/campaigns/:id/stop', (req, res) => { stopCampaignLoop(req.params.id); res.json({ ok: true }); });

app.get('/api/numbers', (req, res) => {
  let r = numbers;
  if (req.query.group) r = r.filter(n => n.group === req.query.group);
  if (req.query.status) r = r.filter(n => n.status === req.query.status);
  res.json(r);
});

app.post('/api/numbers', async (req, res) => {
  const incoming = Array.isArray(req.body) ? req.body : [req.body];
  const existing = new Set(numbers.map(n => n.phone));
  let added = 0;
  const ops = [];
  incoming.forEach(n => {
    let phone = String(n.phone || '').replace(/[^0-9]/g, '');
    if (phone.length === 10 && /^[6-9]/.test(phone)) phone = '91' + phone;
    if (phone.length >= 7 && !existing.has(phone)) {
      const num = { phone, name: n.name || '', group: n.group || '', status: 'pending', addedAt: new Date() };
      numbers.push(num); existing.add(phone);
      ops.push(upsert('numbers', { phone }, num));
      added++;
    }
  });
  await Promise.all(ops);
  res.json({ ok: true, added, total: numbers.length });
});

app.put('/api/numbers/:phone', async (req, res) => {
  const n = numbers.find(n => n.phone === req.params.phone);
  if (!n) return res.status(404).json({ error: 'Not found' });
  Object.assign(n, req.body);
  await upsert('numbers', { phone: req.params.phone }, n);
  res.json({ ok: true });
});

app.delete('/api/numbers/:phone', async (req, res) => {
  numbers = numbers.filter(n => n.phone !== req.params.phone);
  await del('numbers', { phone: req.params.phone });
  res.json({ ok: true });
});

app.post('/api/numbers/reset-status', async (req, res) => {
  const { campaignId } = req.body;
  if (campaignId) delete stats[`sent_${campaignId}`];
  numbers.forEach(n => n.status = 'pending');
  await saveAll();
  res.json({ ok: true });
});

app.get('/api/logs', (req, res) => {
  const { campaignId, limit = 200 } = req.query;
  let r = campaignId ? logs.filter(l => l.campaignId === campaignId) : logs;
  res.json(r.slice(0, parseInt(limit)));
});

app.delete('/api/logs', async (req, res) => {
  logs = [];
  await db.collection('logs').deleteMany({});
  res.json({ ok: true });
});

app.get('/api/stats', (req, res) => {
  const { campaignId } = req.query;
  if (campaignId) { const camp = campaigns.find(c => c.id === campaignId); return res.json({ sent: camp?.sent || 0, failed: camp?.failed || 0 }); }
  res.json(stats);
});

app.get('/api/groups', (req, res) => {
  const groups = [...new Set(numbers.map(n => n.group).filter(Boolean))];
  res.json(groups.map(g => ({ id: g, name: g, count: numbers.filter(n => n.group === g).length })));
});

// ─────────────────────────────────────────
//  BOOT
// ─────────────────────────────────────────
// ─────────────────────────────────────────
//  CRASH PROTECTION — log instead of silent die
// ─────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('[WAReach] UNCAUGHT EXCEPTION:', err.message);
  console.error(err.stack);
  // Don't exit — let the process keep running
});
process.on('unhandledRejection', (reason) => {
  console.error('[WAReach] UNHANDLED REJECTION:', reason?.message || reason);
});

async function boot() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   WAReach Bot v6.0 — Render Free + MongoDB   ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  await connectMongo();
  await loadFromMongo();

  app.listen(CONFIG.PORT, '0.0.0.0', () => {
    console.log(`[WAReach] Server:  http://localhost:${CONFIG.PORT}`);
    console.log(`[WAReach] Health:  http://localhost:${CONFIG.PORT}/healthz`);
    console.log(`[WAReach] QR:      http://localhost:${CONFIG.PORT}/qr\n`);
  });

  await connectAccount('main');

  // Auto-reconnect any other saved sessions in MongoDB
  setTimeout(async () => {
    try {
      const savedIds = await db.collection('sessions').distinct('accountId');
      for (const id of savedIds) {
        if (id !== 'main' && !accounts.has(id)) {
          addLog('info', `Auto-reconnecting saved account: ${id}`);
          await connectAccount(id);
          await delay(2000);
        }
      }
    } catch (e) { addLog('warn', 'Auto-reconnect error: ' + e.message); }
  }, 4000);
}

boot().catch(err => {
  console.error('[WAReach] Boot error:', err);
  process.exit(1);
});