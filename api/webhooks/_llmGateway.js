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
  gemini: 'gemini-flash-latest', // rolling alias for the current stable Flash model — avoids repeating the 'gemini-2.0-flash' retirement surprise (2026-11-09) whenever Google cycles the underlying model
  openrouter: 'openai/gpt-4o-mini',
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

// Exponential backoff on 429 (rate limit) / 503 (overloaded, with Google
// actually responding promptly) only. A request that instead stalled and
// hit our own client-side timeout (504 — see fetchWithTimeout) is NOT
// retried here: Meta's webhook caller has a limited patience window too,
// so burning it on a second multi-second wait for a provider that just
// hung isn't worth it — better to fail this delivery fast and let the
// next inbound message (or Meta's own webhook redelivery) try again.
async function withRetry(fn, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (![429, 503].includes(err.status) || i === attempts - 1) throw err;
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
const PROVIDER_TIMEOUT_MS = 10000;
async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    // 504, not 503 — deliberately NOT in withRetry()'s retryable set (see
    // its comment above) since a stall deserves a fast failure, not a
    // second multi-second wait on the same unresponsive provider.
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
