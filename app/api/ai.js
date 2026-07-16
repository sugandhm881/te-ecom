// Minimal AI client for the critical-email polish. Supports two providers, auto-detected from AI_API_URL:
//   • Google Gemini (native generateContent) — when the URL is on generativelanguage.googleapis.com.
//     (Gemini's OpenAI-compat endpoint returns EMPTY for thinking models like gemini-flash-latest, so we
//      call the native API and disable "thinking" so the token budget goes to the actual answer.)
//   • Any OpenAI-compatible chat/completions provider (Groq, OpenRouter, Together, …) — otherwise.
// Configure AI_API_KEY / AI_API_URL / AI_MODEL in .env. Returns null when unconfigured or on error —
// callers must fall back to a plain template so the feature never hard-depends on AI.
const axios = require('axios');
const config = require('../../config');

function isConfigured() { return !!(config.AI_API_KEY && config.AI_API_URL && config.AI_MODEL); }
function isGemini() { return /generativelanguage\.googleapis\.com/i.test(config.AI_API_URL || ''); }

async function aiComplete(messages, { temperature = 0.5, maxTokens = 900 } = {}) {
    if (!isConfigured()) return null;
    try {
        return isGemini() ? await geminiComplete(messages, temperature, maxTokens)
                          : await openaiComplete(messages, temperature, maxTokens);
    } catch (e) { console.error('[AI] error:', e.message); return null; }
}

async function openaiComplete(messages, temperature, maxTokens) {
    const r = await axios.post(config.AI_API_URL,
        { model: config.AI_MODEL, messages, temperature, max_tokens: maxTokens },
        { headers: { Authorization: 'Bearer ' + config.AI_API_KEY, 'Content-Type': 'application/json' }, timeout: 30000, validateStatus: () => true });
    if (r.status >= 400) { console.error('[AI] HTTP', r.status, JSON.stringify(r.data).slice(0, 200)); return null; }
    const txt = r.data && r.data.choices && r.data.choices[0] && r.data.choices[0].message && r.data.choices[0].message.content;
    return (txt || '').trim() || null;
}

// Native Gemini generateContent. Converts OpenAI-style messages → Gemini contents/systemInstruction and
// disables thinking (thinkingBudget:0) so short responses aren't swallowed by the reasoning budget.
// When the primary model is overloaded (503) or rate-limited (429), retries once on a lighter fallback
// model (AI_MODEL_FALLBACK, default gemini-flash-lite-latest) so scoring/polish keep working.
async function geminiComplete(messages, temperature, maxTokens) {
    const base = (config.AI_API_URL.match(/^https?:\/\/[^/]+/) || ['https://generativelanguage.googleapis.com'])[0];
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const contents = messages.filter(m => m.role !== 'system')
        .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));

    const call = async (model) => {
        const url = `${base}/v1beta/models/${model}:generateContent`;
        const body = { contents, generationConfig: { temperature, maxOutputTokens: maxTokens, thinkingConfig: { thinkingBudget: 0 } } };
        if (system) body.systemInstruction = { parts: [{ text: system }] };
        let r = await axios.post(url, body,
            { headers: { 'X-goog-api-key': config.AI_API_KEY, 'Content-Type': 'application/json' }, timeout: 30000, validateStatus: () => true });
        // Some models reject thinkingConfig — retry once without it.
        if (r.status === 400 && /thinking/i.test(JSON.stringify(r.data))) {
            delete body.generationConfig.thinkingConfig;
            r = await axios.post(url, body, { headers: { 'X-goog-api-key': config.AI_API_KEY, 'Content-Type': 'application/json' }, timeout: 30000, validateStatus: () => true });
        }
        return r;
    };

    let r = await call(config.AI_MODEL);
    if (r.status === 503 || r.status === 429) {
        const fallback = process.env.AI_MODEL_FALLBACK || 'gemini-flash-lite-latest';
        if (fallback && fallback !== config.AI_MODEL) {
            console.warn(`[AI] ${config.AI_MODEL} unavailable (${r.status}) — falling back to ${fallback}`);
            r = await call(fallback);
        }
    }
    if (r.status >= 400) { console.error('[AI] Gemini HTTP', r.status, JSON.stringify(r.data).slice(0, 200)); return null; }
    const parts = r.data && r.data.candidates && r.data.candidates[0] && r.data.candidates[0].content && r.data.candidates[0].content.parts;
    const txt = Array.isArray(parts) ? parts.map(p => p.text || '').join('') : '';
    return (txt || '').trim() || null;
}

module.exports = { aiComplete, isConfigured };
