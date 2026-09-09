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
// Cache reads bill at 10% of input. A cache WRITE bills as a multiple of input that depends on how
// long the cache lives — 1.25x for the 5-minute cache, 2.00x for the 1-hour one. We charged 1.25x
// for everything while the call brain has always asked for the 1-hour cache, so the statement read
// $1.83 on 08-Sep against a console figure of $2.55. Re-priced, the same tokens come to $2.536.
const PRICES = [
    [/haiku-4-5/i, { in: 1, out: 5 }],
    [/sonnet-5/i, { in: 2, out: 10 }],
    [/sonnet-4-6/i, { in: 3, out: 15 }],
    [/fable-5|mythos-5/i, { in: 10, out: 50 }],
    [/opus/i, { in: 5, out: 25 }],
];
const priceFor = (model) => (PRICES.find(([rx]) => rx.test(String(model || ''))) || [null, { in: 3, out: 15 }])[1];
// The multiplier follows the TTL the call actually requested, which is why the row stores it: this is
// an env var (CLAUDE_CACHE_TTL), so an inferred '1h' would misprice every row the day it changes.
const CACHE_WRITE_MULT = (ttl) => (String(ttl || '') === '1h' ? 2.0 : 1.25);

// ONE definition of what an Anthropic call costs. ai_call_costs.js kept a second copy of this table
// and this arithmetic; they drifted (Sonnet 5 and Opus were stale in one of them for days), so the
// statement now calls this rather than re-implementing it.
// Accepts either the ledger row shape (tokens_in / cache_write / cache_ttl) or the compact
// {in,out,cr,cw,ttl} the bridge tallies in — the same numbers arrive from both directions.
function usdFor(model, u) {
    const p = priceFor(model);
    const cw = u.cache_write ?? u.cw ?? 0;
    return (u.tokens_in ?? u.in ?? 0) * p.in / 1e6
         + (u.tokens_out ?? u.out ?? 0) * p.out / 1e6
         + (u.cache_read ?? u.cr ?? 0) * p.in * 0.1 / 1e6
         + cw * p.in * CACHE_WRITE_MULT(u.cache_ttl ?? u.ttl) / 1e6;
}

// usage = the API's own usage object (or our {in,out,cr,cw} shape)
function logClaudeUsage(source, model, usage, ref, cacheTtl) {
    try {
        if (!usage) return;
        const row = {
            source, model: String(model || 'unknown'),
            tokens_in: usage.input_tokens ?? usage.in ?? 0,
            tokens_out: usage.output_tokens ?? usage.out ?? 0,
            cache_read: usage.cache_read_input_tokens ?? usage.cr ?? 0,
            cache_write: usage.cache_creation_input_tokens ?? usage.cw ?? 0,
            // only meaningful when something was actually cached; NULL keeps the column honest
            cache_ttl: (usage.cache_creation_input_tokens ?? usage.cw ?? 0) ? String(cacheTtl || usage.ttl || '') || null : null,
            ref: ref ? String(ref).slice(0, 60) : null,
        };
        if (!row.tokens_in && !row.tokens_out && !row.cache_read && !row.cache_write) return;
        supabase.from('claude_usage_ecom').insert(row)
            .then(({ error }) => { if (error) console.warn('[claude-usage] write failed:', error.message); })
            .catch(() => {});
    } catch (_) { /* never break the caller */ }
}

module.exports = { logClaudeUsage, usdFor, priceFor, CACHE_WRITE_MULT };
