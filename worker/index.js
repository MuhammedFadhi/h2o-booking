// Cloudflare Workers entry point. Bridges Workers' fetch(request, env, ctx) model
// to the existing api/*.js handlers, which are written in Vercel's
// `async function handler(req, res)` style. The handlers themselves are
// untouched (aside from the relay calls switching from Node's https module to
// fetch — Workers cannot bypass TLS validation the way Vercel's Node runtime
// could, so the relay now needs a real certificate).
//
// The handler modules read secrets via `process.env.X` at their own top-level
// scope (once, when first required). If they were required at the top of this
// file, that would run before any request's `env` bindings are in scope, so
// every secret would be captured as undefined. Loading them lazily on first
// use inside fetch() — after env has been bridged onto process.env — avoids
// that. require() calls stay as literal strings so esbuild can still bundle
// them even though they're inside functions.
const ROUTE_LOADERS = {
  '/api/otp': () => require('../api/otp.js'),
  '/api/send-sms': () => require('../api/send-sms.js'),
  '/api/notify-report': () => require('../api/notify-report.js'),
  '/api/notify-installers': () => require('../api/notify-installers.js'),
  '/api/auth-sms-hook': () => require('../api/auth-sms-hook.js'),
  '/api/admin/bookings': () => require('../api/admin/bookings.js'),
  '/api/admin/slots': () => require('../api/admin/slots.js'),
  '/api/admin/installers': () => require('../api/admin/installers.js'),
  '/api/admin/user-ops': () => require('../api/admin/user-ops.js'),
  '/api/admin/whatsapp': () => require('../api/admin/whatsapp.js'),
  '/api/sales/ops': () => require('../api/sales/ops.js'),
  '/api/webhooks/whatsapp': () => require('../api/webhooks/whatsapp.js')
};

// auth-sms-hook and the whatsapp webhook verify an HMAC over the exact raw
// bytes the sender sent, so neither must be JSON-parsed — matches their own
// `config.api.bodyParser = false` intent.
const RAW_BODY_ROUTES = new Set(['/api/auth-sms-hook', '/api/webhooks/whatsapp']);

// Routes that accept a multipart/form-data upload (a media attachment) and
// need the parsed FormData itself, not text/JSON — see RAW_BODY_ROUTES
// above for why text() can't come first for these either.
const MULTIPART_ROUTES = new Set(['/api/admin/whatsapp']);

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
  const ct = headers['content-type'] || '';
  if (RAW_BODY_ROUTES.has(url.pathname)) {
    body = await request.text();
  } else if (MULTIPART_ROUTES.has(url.pathname) && ct.includes('multipart/form-data')) {
    // request.formData() reads the body directly off the stream — must not
    // go through request.text() first (that would UTF-8-decode the raw
    // bytes and corrupt any binary file content before we ever see it).
    body = await request.formData();
  } else if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    const text = await request.text();
    if (text && ct.includes('application/json')) {
      try { body = JSON.parse(text); } catch { body = text; }
    } else if (text) {
      body = text;
    }
  }

  // Cloudflare always sets cf-connecting-ip on requests it proxies to the Worker —
  // that's the real client IP. Node's req.socket.remoteAddress doesn't exist here
  // (no raw TCP socket in Workers), so stub it for handlers that fall back to it.
  const clientIp = headers['cf-connecting-ip'] || '';
  if (!headers['x-forwarded-for'] && clientIp) headers['x-forwarded-for'] = clientIp;
  const req = { method: request.method, headers, query, body, socket: { remoteAddress: clientIp } };
  const { res, state } = createRes();
  await handler(req, res);
  return new Response(state.body, { status: state.statusCode, headers: state.headers });
}

export default {
  async fetch(request, env, ctx) {
    // Belt-and-braces: mirror bindings onto process.env explicitly, in case
    // Cloudflare's own nodejs_compat_populate_process_env doesn't cover a
    // module that's about to be required for the first time right below.
    for (const k in env) {
      if (typeof env[k] === 'string') process.env[k] = env[k];
    }

    const url = new URL(request.url);
    const loadHandler = ROUTE_LOADERS[url.pathname];
    if (loadHandler) {
      try {
        return await runHandler(loadHandler(), request, url);
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
