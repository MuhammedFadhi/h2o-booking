// Cloudflare Workers entry point. Bridges Workers' fetch(request, env, ctx) model
// to the existing api/*.js handlers, which are written in Vercel's
// `async function handler(req, res)` style. The handlers themselves are
// untouched (aside from the relay calls switching from Node's https module to
// fetch — Workers cannot bypass TLS validation the way Vercel's Node runtime
// could, so the relay now needs a real certificate).
const otp = require('../api/otp.js');
const sendSms = require('../api/send-sms.js');
const notifyReport = require('../api/notify-report.js');
const notifyInstallers = require('../api/notify-installers.js');
const authSmsHook = require('../api/auth-sms-hook.js');
const adminBookings = require('../api/admin/bookings.js');
const adminSlots = require('../api/admin/slots.js');
const adminInstallers = require('../api/admin/installers.js');
const adminUserOps = require('../api/admin/user-ops.js');

const ROUTES = {
  '/api/otp': otp,
  '/api/send-sms': sendSms,
  '/api/notify-report': notifyReport,
  '/api/notify-installers': notifyInstallers,
  '/api/auth-sms-hook': authSmsHook,
  '/api/admin/bookings': adminBookings,
  '/api/admin/slots': adminSlots,
  '/api/admin/installers': adminInstallers,
  '/api/admin/user-ops': adminUserOps
};

// auth-sms-hook verifies an HMAC over the exact raw bytes Supabase sent, so it
// must not be JSON-parsed — matches its `config.api.bodyParser = false` intent.
const RAW_BODY_ROUTES = new Set(['/api/auth-sms-hook']);

function createRes() {
  const state = { statusCode: 200, headers: {}, body: undefined };
  const res = {
    setHeader(name, value) { state.headers[name] = value; return res; },
    status(code) { state.statusCode = code; return res; },
    json(obj) {
      state.body = JSON.stringify(obj);
      if (!state.headers['Content-Type']) state.headers['Content-Type'] = 'application/json';
      return res;
    },
    end(data) { if (data !== undefined) state.body = data; return res; }
  };
  return { res, state };
}

async function runHandler(handler, request, url) {
  const headers = {};
  for (const [k, v] of request.headers) headers[k.toLowerCase()] = v;
  const query = Object.fromEntries(url.searchParams);

  let body;
  if (RAW_BODY_ROUTES.has(url.pathname)) {
    body = await request.text();
  } else if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    const text = await request.text();
    const ct = headers['content-type'] || '';
    if (text && ct.includes('application/json')) {
      try { body = JSON.parse(text); } catch { body = text; }
    } else if (text) {
      body = text;
    }
  }

  const req = { method: request.method, headers, query, body };
  const { res, state } = createRes();
  await handler(req, res);
  return new Response(state.body, { status: state.statusCode, headers: state.headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const handler = ROUTES[url.pathname];
    if (handler) {
      try {
        return await runHandler(handler, request, url);
      } catch (err) {
        console.error('worker error on', url.pathname, err);
        return new Response(JSON.stringify({ error: err.message || 'Server error' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
    return env.ASSETS.fetch(request);
  }
};
