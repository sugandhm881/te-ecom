// Escalation reply tracking — logs sent critical emails, polls the inbox (IMAP) for replies, matches
// them to their thread (In-Reply-To / normalized subject), and AI-scores each reply for resolution.
// IMAP uses the SAME account the escalations are sent from (portal settings over .env), so no new creds.
const express = require('express');
const router = express.Router();
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const config = require('../../config');
const { supabase } = require('../supabase');
const { getEmailConfig } = require('./email_settings');
const { aiComplete } = require('./ai');

const normSubject = s => String(s || '').replace(/^(\s*(re|fwd?|fw)\s*:\s*)+/i, '').trim().toLowerCase();
const stripId = s => String(s || '').trim().replace(/^<|>$/g, '');

// ── Record a SENT escalation (called by /critical-email/send) ───────────────
async function logSentEscalation({ messageId, subject, to, body, orders, from }) {
    try {
        const { error } = await supabase.from('escalation_emails_ecom').insert({
            kind: 'sent', message_id: stripId(messageId) || null,
            thread_subject: normSubject(subject), subject,
            from_email: from || null, to_email: Array.isArray(to) ? to.join(', ') : (to || null),
            body: String(body || '').slice(0, 8000),
            orders: Array.isArray(orders) ? orders : [],
        });
        if (error) console.error('[EscMail] log-sent error:', error.message);
    } catch (e) { console.error('[EscMail] log-sent error:', e.message); }
}

// ── AI resolution analysis for one reply ────────────────────────────────────
async function analyzeReply(sentRow, replyText) {
    const sys = 'You analyze a courier partner\'s email reply to an escalation from The Element (Indian D2C skincare brand). Respond ONLY with strict JSON {"score":0-100,"status":"resolved|in_progress|needs_action|unresolved","suggestion":"..."} — score = how fully the reply resolves the escalation; suggestion = ONE concise concrete next action for The Element ops team (max 25 words).';
    const usr = `OUR ESCALATION:\nSubject: ${sentRow.subject}\n${String(sentRow.body || '').slice(0, 1200)}\n\nTHEIR REPLY:\n${String(replyText || '').slice(0, 2500)}`;
    const out = await aiComplete([{ role: 'system', content: sys }, { role: 'user', content: usr }], { temperature: 0.3, maxTokens: 300 });
    if (!out) return null;
    try {
        const j = JSON.parse(out.replace(/```json?/gi, '').replace(/```/g, '').trim());
        const score = Math.max(0, Math.min(100, parseInt(j.score, 10) || 0));
        const status = ['resolved', 'in_progress', 'needs_action', 'unresolved'].includes(j.status) ? j.status : 'needs_action';
        return { score, status, suggestion: String(j.suggestion || '').slice(0, 300) };
    } catch (_) { return null; }
}

// ── IMAP poll: find replies to our sent escalations ─────────────────────────
let _pollRunning = false;
async function pollEscalationReplies() {
    if (_pollRunning) return { skipped: true };
    _pollRunning = true;
    try {
        // Load the sent threads we're watching (last 60 days is plenty).
        const sinceISO = new Date(Date.now() - 60 * 86400000).toISOString();
        const { data: sent } = await supabase.from('escalation_emails_ecom')
            .select('id, message_id, thread_subject, subject, body').eq('kind', 'sent').gte('created_at', sinceISO);
        const sentRows = sent || [];
        if (!sentRows.length) return { checked: 0, saved: 0 };
        const byMsgId = new Map(sentRows.filter(r => r.message_id).map(r => [r.message_id, r]));
        const bySubject = new Map(sentRows.filter(r => r.thread_subject).map(r => [r.thread_subject, r]));
        // Track the WHOLE chain: a reply-to-a-reply carries the previous reply's Message-ID in its
        // In-Reply-To, so map every stored reply's message_id back to its thread's sent row too.
        const sentById = new Map(sentRows.map(r => [r.id, r]));
        const { data: knownReplies } = await supabase.from('escalation_emails_ecom')
            .select('message_id, parent_id').eq('kind', 'reply').gte('created_at', sinceISO);
        (knownReplies || []).forEach(kr => { const p = sentById.get(kr.parent_id); if (p && kr.message_id) byMsgId.set(kr.message_id, p); });

        const cfg = await getEmailConfig();
        if (!cfg) { console.warn('[EscMail] email not configured — skip poll'); return { error: 'email not configured' }; }
        const imapHost = process.env.IMAP_HOST || String(cfg.host || '').replace(/^smtp\./i, 'imap.');
        const client = new ImapFlow({ host: imapHost, port: 993, secure: true, logger: false, auth: { user: cfg.user, pass: cfg.pass } });
        await client.connect();
        let checked = 0, saved = 0;
        const lock = await client.getMailboxLock('INBOX');
        try {
            const uids = await client.search({ since: new Date(Date.now() - 7 * 86400000) });
            // PHASE 1 — envelopes only. No other IMAP command may run while the fetch iterator is active
            // (issuing client.download() inside this loop deadlocks imapflow), so just collect candidates.
            const candidates = [];
            for await (const msg of client.fetch(uids, { envelope: true, uid: true })) {
                checked++;
                const env = msg.envelope || {};
                const fromAddr = (env.from && env.from[0] && env.from[0].address) || '';
                const inReplyTo = stripId(env.inReplyTo);
                const refParent = inReplyTo ? byMsgId.get(inReplyTo) : null;
                // Own-address mail is skipped UNLESS it explicitly references a sent escalation (In-Reply-To) —
                // that covers a teammate replying from the same mailbox without matching our own sent copies.
                if (!refParent && fromAddr.toLowerCase() === String(cfg.user).toLowerCase()) continue;
                const parent = refParent || bySubject.get(normSubject(env.subject)) || null;
                if (!parent) continue;
                const msgId = stripId(env.messageId);
                if (!msgId) continue;
                candidates.push({ uid: msg.uid, env, fromAddr, inReplyTo, msgId, parent });
            }
            // PHASE 2 — download + save + analyze each candidate (fetch stream is closed now).
            for (const c of candidates) {
                const { data: exists } = await supabase.from('escalation_emails_ecom').select('id').eq('message_id', c.msgId).maybeSingle();
                if (exists) continue;
                let text = '';
                try {
                    const dl = await client.download(c.uid, undefined, { uid: true });
                    const parsed = await simpleParser(dl.content);
                    text = (parsed.text || parsed.html || '').toString();
                } catch (_) { /* envelope-only fallback */ }
                // Trim quoted history — keep the fresh part of the reply. The "On … wrote:" header can
                // wrap across lines (Gmail), so match across newlines ([\s\S]) up to "wrote:".
                text = text.split(/\r?\n\s*(?:>|On [\s\S]{5,140}?wrote:)/)[0].trim().slice(0, 8000);
                const { data: ins, error } = await supabase.from('escalation_emails_ecom').insert({
                    kind: 'reply', message_id: c.msgId, in_reply_to: c.inReplyTo || null,
                    thread_subject: normSubject(c.env.subject), subject: c.env.subject || '',
                    from_email: c.fromAddr, to_email: cfg.user, body: text,
                    parent_id: c.parent.id, created_at: c.env.date ? new Date(c.env.date).toISOString() : new Date().toISOString(),
                }).select('id').single();
                if (error) { if (!/duplicate/i.test(error.message)) console.error('[EscMail] save reply error:', error.message); continue; }
                saved++;
                console.log(`[EscMail] reply saved from ${c.fromAddr} — "${(c.env.subject || '').slice(0, 60)}"`);
                // AI resolution analysis — only for INBOUND replies (the courier's). Our own follow-ups
                // from the same mailbox are part of the thread but scoring them is meaningless.
                if (c.fromAddr.toLowerCase() !== String(cfg.user).toLowerCase()) {
                    const a = await analyzeReply(c.parent, text);
                    if (a) await supabase.from('escalation_emails_ecom').update({ ai_score: a.score, ai_status: a.status, ai_suggestion: a.suggestion }).eq('id', ins.id);
                }
            }
        } finally { lock.release(); }
        await client.logout().catch(() => {});
        // Retry AI scoring for INBOUND replies that missed it (e.g. the model was overloaded at capture).
        try {
            const { data: unscored } = await supabase.from('escalation_emails_ecom')
                .select('id, parent_id, body, from_email').eq('kind', 'reply').is('ai_score', null)
                .gte('created_at', new Date(Date.now() - 14 * 86400000).toISOString()).limit(5);
            for (const u of (unscored || [])) {
                if (String(u.from_email || '').toLowerCase() === String(cfg.user).toLowerCase()) continue;   // our own follow-up
                const parent = sentById.get(u.parent_id); if (!parent) continue;
                const a = await analyzeReply(parent, u.body);
                if (a) { await supabase.from('escalation_emails_ecom').update({ ai_score: a.score, ai_status: a.status, ai_suggestion: a.suggestion }).eq('id', u.id); console.log('[EscMail] scored pending reply', u.id, '→', a.score, a.status); }
            }
        } catch (_) { /* next poll retries */ }
        if (saved) console.log(`[EscMail] poll done — ${saved} new repl${saved === 1 ? 'y' : 'ies'} (${checked} checked)`);
        return { checked, saved };
    } catch (e) {
        console.error('[EscMail] poll error:', e.message);
        return { error: e.message };
    } finally { _pollRunning = false; }
}

// ── API ──────────────────────────────────────────────────────────────────────
// Thread(s) for one order/awb: the sent escalation(s) + their replies (with AI analysis).
// Every message carries `direction`: 'outbound' = from The Element (us), 'inbound' = from the courier —
// so the UI renders a proper sender/receiver mail thread.
router.get('/escalation-emails', async (req, res) => {
    try {
        const awb = (req.query.awb || '').trim(), order = (req.query.order || '').trim();
        let q = supabase.from('escalation_emails_ecom').select('*').eq('kind', 'sent').order('created_at', { ascending: false }).limit(10);
        if (awb) q = q.contains('orders', JSON.stringify([{ awb }]));
        else if (order) q = q.contains('orders', JSON.stringify([{ order_name: order }]));
        const { data: sent, error } = await q;
        if (error) return res.status(500).json({ success: false, error: error.message });
        const ids = (sent || []).map(s => s.id);
        let replies = [];
        if (ids.length) {
            const { data: reps } = await supabase.from('escalation_emails_ecom').select('*').eq('kind', 'reply').in('parent_id', ids).order('created_at', { ascending: true });
            replies = reps || [];
        }
        const cfg = await getEmailConfig().catch(() => null);
        const ours = new Set([cfg && cfg.user, cfg && cfg.from].filter(Boolean).map(x => String(x).toLowerCase()));
        const dir = m => m.kind === 'sent' ? 'outbound' : (ours.has(String(m.from_email || '').toLowerCase()) ? 'outbound' : 'inbound');
        res.json({ success: true, threads: (sent || []).map(s => ({ ...s, direction: 'outbound', replies: replies.filter(r => r.parent_id === s.id).map(r => ({ ...r, direction: dir(r) })) })) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
// Latest replies across all threads (for the insight card) — labeled with the orders they belong to.
router.get('/escalation-emails/recent', async (req, res) => {
    try {
        const { data: reps, error } = await supabase.from('escalation_emails_ecom')
            .select('id, parent_id, from_email, subject, body, ai_score, ai_status, ai_suggestion, created_at')
            .eq('kind', 'reply').order('created_at', { ascending: false }).limit(8);
        if (error) return res.status(500).json({ success: false, error: error.message });
        const parentIds = [...new Set((reps || []).map(r => r.parent_id).filter(Boolean))];
        const ordersByParent = {};
        if (parentIds.length) {
            const { data: parents } = await supabase.from('escalation_emails_ecom').select('id, orders').in('id', parentIds);
            (parents || []).forEach(p => { ordersByParent[p.id] = (p.orders || []).map(o => o.order_name).filter(Boolean); });
        }
        res.json({ success: true, replies: (reps || []).map(r => ({ ...r, order_names: ordersByParent[r.parent_id] || [] })) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
// Manual poll trigger (admin utility / testing).
router.post('/escalation-emails/poll', async (req, res) => {
    const out = await pollEscalationReplies();
    res.json({ success: !out.error, ...out });
});

module.exports = { router, logSentEscalation, pollEscalationReplies };
