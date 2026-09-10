'use strict';
const crypto = require('crypto');

const TOKEN = process.env.TAQNYAT_TOKEN;
const SENDER = process.env.TAQNYAT_SENDER || 'SADA.Co-AD';
const RSENDER = process.env.RELAY_SENDER || 'SADA.co';
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const SECRET = process.env.RELAY_SECRET || '';
const PORT = process.env.PORT || 8081;
const BATCH = 50, DELAY = 1200, CPM = 0.06;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function norm(m) {
  if (!m) return '';
  let n = String(m).replace(/\D/g, '');
  if (n.startsWith('00966')) n = n.slice(2);
  if (n.startsWith('0')) n = '966' + n.slice(1);
  if (n.indexOf('966') !== 0) n = '966' + n;
  return n;
}

function msg(ar, en, lang, c) {
  ar = ar || ''; en = en || '';
  let m = lang === 'ar' ? ar : lang === 'en' ? en : [ar, en].filter(Boolean).join('\n\n');
  return (m || ar || en || '').replace(/{{name}}/g, c.name || 'عميلنا الكريم').replace(/{{city}}/g, c.city || '').trim();
}

function body(req) {
  return new Promise((ok, err) => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch (e) { err(e); } });
    req.on('error', err);
  });
}

function jr(res, s, d) {
  res.writeHead(s, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(d));
}

async function tq(sender, mobile, text) {
  const r = await fetch('https://api.taqnyat.sa/v1/messages', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender, recipients: [mobile], body: text })
  });
  const d = await r.json();
  return { ok: r.status === 200 || r.status === 201 || d.statusCode === 201, id: (d.messages && d.messages[0] && d.messages[0].messageId) || '' };
}

async function sbl(log) {
  if (!SB_URL || !SB_KEY) return;
  await fetch(SB_URL + '/rest/v1/send_logs', {
    method: 'POST',
    headers: { apikey: SB_KEY, 'Authorization': 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(log)
  }).catch(() => {});
}

async function sbu(id, d, f, c) {
  if (!SB_URL || !SB_KEY) return;
  await fetch(SB_URL + '/rest/v1/campaigns?id=eq.' + id, {
    method: 'PATCH',
    headers: { apikey: SB_KEY, 'Authorization': 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ delivered: d, failed: f, cost: c, finished_at: new Date().toISOString() })
  }).catch(() => {});
}

async function run(cid, contacts, lang, ar, en) {
  let ok = 0, fail = 0;
  for (let i = 0; i < contacts.length; i += BATCH) {
    for (const c of contacts.slice(i, i + BATCH)) {
      try {
        const m = norm(c.mobile);
        if (!m) { fail++; continue; }
        const r = await tq(SENDER, m, msg(ar, en, lang, c));
        await sbl({ id: crypto.randomUUID(), campaign_id: cid, contact_id: c.id || '', mobile: m, name: c.name || '', status: r.ok ? 'delivered' : 'failed', taqnyat_id: r.id, sent_at: new Date().toISOString() });
        if (r.ok) ok++; else fail++;
      } catch (e) { fail++; }
    }
    if (i + BATCH < contacts.length) await sleep(DELAY);
  }
  const cost = parseFloat((ok * (lang === 'both' ? 2 : 1) * CPM).toFixed(2));
  await sbu(cid, ok, fail, cost);
  console.log('Done', ok, 'ok', fail, 'fail SAR', cost);
}

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Relay-Secret');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method !== 'POST') { jr(res, 405, { error: 'not allowed' }); return; }
  if (SECRET && req.url === '/campaign' && (req.headers['x-relay-secret'] || '') !== SECRET) { jr(res, 401, { error: 'unauthorized' }); return; }
  try {
    const b = await body(req);
    if (req.url === '/send' || req.url === '/') {
      if (!b.to || !b.body) { jr(res, 400, { error: 'missing to or body' }); return; }
      const r = await tq(RSENDER, norm(b.to), b.body);
      jr(res, 200, r);
      return;
    }
    if (req.url === '/campaign') {
      if (!b.campaignId || !(b.contacts && b.contacts.length)) { jr(res, 400, { error: 'missing fields' }); return; }
      jr(res, 202, { ok: true, queued: b.contacts.length });
      run(b.campaignId, b.contacts, b.lang, b.body_ar, b.body_en).catch(e => console.error(e.message));
      return;
    }
    if (req.url === '/health') { jr(res, 200, { ok: true }); return; }
    jr(res, 404, { error: 'not found' });
  } catch (e) { jr(res, 500, { error: e.message }); }
}

require('http').createServer(handler).listen(PORT, '127.0.0.1', () => {
  console.log('Relay up on 127.0.0.1:' + PORT);
  console.log('Campaign sender:', SENDER);
  console.log('Relay sender:', RSENDER);
  console.log('Supabase:', SB_URL ? 'connected' : 'NOT configured');
});
