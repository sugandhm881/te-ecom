// ─────────────────────────────────────────────────────────────────────────────
// CLAUDE USAGE LEDGER (2026-09-02). Every Anthropic call this system makes — the
// call brain, the opening line, the summarizer, agent-learning reviews, the Call
// Insights audit — writes what the API itself reported into claude_usage_ecom.
//
// Why: the AI Calling Statement only knew about tokens spent INSIDE a call, so it
// showed roughly half of what the Anthropic console billed. Whatever is not
// attributable to one call still costs money, and a statement that quietly omits
// it is wrong. Fire-and-forget: a ledger write can never break a call.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const { supabase } = require('../supabase');

// Anthropic list prices, USD per MILLION tokens (verified 2026-09-02).
// Cache reads bill at 10% of input, cache writes at 125%.
const PRICES = [
    [/haiku-4-5/i, { in: 1, out: 5 }],
    [/sonnet-5/i, { in: 2, out: 10 }],
    [/sonnet-4-6/i, { in: 3, out: 15 }],
    [/fable-5|mythos-5/i, { in: 10, out: 50 }],
    [/opus/i, { in: 5, out: 25 }],
];
const priceFor = (model) => (PRICES.find(([rx]) => rx.test(String(model || ''))) || [null, { in: 3, out: 15 }])[1];

function usdFor(model, u) {
    const p = priceFor(model);
    return (u.tokens_in || 0) * p.in / 1e6
         + (u.tokens_out || 0) * p.out / 1e6
         + (u.cache_read || 0) * p.in * 0.1 / 1e6
         + (u.cache_write || 0) * p.in * 1.25 / 1e6;
}

// usage = the API's own usage object (or our {in,out,cr,cw} shape)
function logClaudeUsage(source, model, usage, ref) {
    try {
        if (!usage) return;
        const row = {
            source, model: String(model || 'unknown'),
            tokens_in: usage.input_tokens ?? usage.in ?? 0,
            tokens_out: usage.output_tokens ?? usage.out ?? 0,
            cache_read: usage.cache_read_input_tokens ?? usage.cr ?? 0,
            cache_write: usage.cache_creation_input_tokens ?? usage.cw ?? 0,
            ref: ref ? String(ref).slice(0, 60) : null,
        };
        if (!row.tokens_in && !row.tokens_out && !row.cache_read && !row.cache_write) return;
        supabase.from('claude_usage_ecom').insert(row)
            .then(({ error }) => { if (error) console.warn('[claude-usage] write failed:', error.message); })
            .catch(() => {});
    } catch (_) { /* never break the caller */ }
}

module.exports = { logClaudeUsage, usdFor, priceFor };
