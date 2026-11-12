// Multi-provider LLM gateway for the WhatsApp auto-reply bot (see
// _whatsappBot.js). One function, one admin-pasted API key — the provider
// is auto-detected from the key's own prefix so Settings never needs a
// separate "which provider" dropdown. Each provider has a different
// request/response shape; this file is the only place that knows about
// any of them — callLLM() always returns the same thing: the model's raw
// text response (expected to be JSON per the bot's forced output contract,
// but parsing that is the caller's job, not this file's).

function detectProvider(apiKey) {
  const k = String(apiKey || '');
  if (k.startsWith('sk-ant-')) return 'anthropic';
  // Google AI Studio now issues two different key formats for the same
  // Gemini API — the classic "AIzaSy..." and a newer "AQ...." one (seen
  // live in the Studio UI, 2026-11) — both need to route here.
  if (k.startsWith('AIza') || k.startsWith('AQ.')) return 'gemini';
  if (k.startsWith('sk-or-')) return 'openrouter';
  return 'openai';
}

// Update these if a newer model becomes the obvious default — kept as
// plain constants rather than config so there's one place to bump them.
const MODELS = {
  anthropic: 'claude-sonnet-4-5-20250929',
  // Direct live test against the actual (paid, "standard" service tier) key
  // on 2026-11-10 confirmed: 'gemini-2.5-pro' and 'gemini-2.5-flash' are
  // hard-retired for this account ("no longer available to new users" —
  // unrelated to billing, the whole 2.x generation is cut off for accounts
  // created after Google's cutoff) — not usable at all, at any reliability,
  // so it's never coming back into this rotation. 'gemini-3.5-flash'
  // (routes internally to 'gemini-3.6-flash') later hit a 20-requests/day
  // FREE TIER quota wall (2026-11-11) despite the key otherwise showing a
  // paid "standard" service tier — some per-model quota buckets apparently
  // stay free-tier independent of the account's overall billing status.
  // Per explicit instruction, back on 'gemini-3.1-flash-lite-preview' — it
  // still hits occasional "high demand" 503s under load, which is exactly
  // what llm_api_key_fallback (see _whatsappBot.js) exists to paper over.
  gemini: 'gemini-3.1-flash-lite-preview',
  // Switched the primary bot provider to Kimi via OpenRouter (explicit
  // instruction, 2026-11-12) after every Gemini model on this account hit
  // some failure mode (retired, demand-overloaded, or a hidden free-tier
  // quota wall despite a paid key). 'moonshotai/kimi-k2.6' is the current
  // general-purpose, non-reasoning Kimi release on OpenRouter — deliberately
  // not 'kimi-k2-thinking' (a reasoning variant, same slowness tradeoff the
  // bot is trying to avoid) or 'kimi-k2.7-code' (coding-specialized, not a
  // fit for a chat bot).
  openrouter: 'moonshotai/kimi-k2.6',
  openai: 'gpt-4o-mini'
};

// messages: [{ role: 'user' | 'assistant', content: string }] — oldest
// first. Returns the model's raw text output.
async function callLLM({ apiKey, systemPrompt, messages }) {
  const provider = detectProvider(apiKey);
  const call = () => {
    if (provider === 'anthropic') return callAnthropic(apiKey, systemPrompt, messages);
    if (provider === 'gemini') return callGemini(apiKey, systemPrompt, messages);
    return callOpenAiCompatible(apiKey, systemPrompt, messages, provider);
  };
  return withRetry(call);
}

// Exponential backoff on 429 (rate limit) / 503 (overloaded) / 504 (our
// own client-side timeout — see fetchWithTimeout). Direct testing against
// a real key (2026-11-09) showed the provider stalling on one attempt and
// responding instantly on the very next — so a stall IS worth retrying
// once, unlike a hard auth/bad-request error. Kept to 2 total attempts
// (not 3) specifically because each one can itself cost up to
// PROVIDER_TIMEOUT_MS — Meta's webhook caller has a limited patience
// window, so this still has to stay fast overall.
async function withRetry(fn, attempts = 2) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (![429, 503, 504].includes(err.status) || i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 500 * Math.pow(3, i)));
    }
  }
  throw lastErr;
}

function apiError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// Provider APIs occasionally stall completely under load instead of
// returning an error (observed directly: a Gemini call hung 2+ minutes
// with no response) — with no timeout, that leaves the Worker hanging
// until Meta's own webhook delivery gives up and retries minutes later,
// which looks exactly like "the bot took forever to reply". A hard
// per-attempt timeout turns that into a fast, retryable failure instead.
const PROVIDER_TIMEOUT_MS = 7000;
async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw apiError(504, `Provider request timed out after ${PROVIDER_TIMEOUT_MS}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function callAnthropic(apiKey, systemPrompt, messages) {
  const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: MODELS.anthropic,
      max_tokens: 1024,
      system: systemPrompt,
      messages: messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))
    })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw apiError(res.status, json?.error?.message || `Anthropic API error ${res.status}`);
  const text = json?.content?.find((c) => c.type === 'text')?.text;
  if (!text) throw apiError(502, 'Anthropic returned no text content.');
  return text;
}

async function callGemini(apiKey, systemPrompt, messages) {
  const res = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODELS.gemini}:generateContent`,
    {
      method: 'POST',
      // The newer "AQ." key format (project-scoped, billing-linked) is
      // rejected as invalid via the old `?key=` query param — Google's own
      // current docs/curl examples authenticate it via this header instead,
      // which also still works for the classic "AIzaSy..." format.
      headers: { 'Content-Type': 'application/json', 'X-goog-api-key': apiKey },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        generationConfig: { responseMimeType: 'application/json' }
      })
    }
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw apiError(res.status, json?.error?.message || `Gemini API error ${res.status}`);
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw apiError(502, 'Gemini returned no text content.');
  return text;
}

// OpenAI and OpenRouter share this exact OpenAI-compatible shape — only
// the base URL and default model differ.
async function callOpenAiCompatible(apiKey, systemPrompt, messages, provider) {
  const baseUrl = provider === 'openrouter' ? 'https://openrouter.ai/api/v1/chat/completions' : 'https://api.openai.com/v1/chat/completions';
  const res = await fetchWithTimeout(baseUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: provider === 'openrouter' ? MODELS.openrouter : MODELS.openai,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: systemPrompt }, ...messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))]
    })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw apiError(res.status, json?.error?.message || `${provider} API error ${res.status}`);
  const text = json?.choices?.[0]?.message?.content;
  if (!text) throw apiError(502, `${provider} returned no message content.`);
  return text;
}

module.exports = { callLLM, detectProvider };
