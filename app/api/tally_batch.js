// ─────────────────────────────────────────────────────────────────────────────
// Finance → nightly Tally push with Teams approval.
//
// Users draft vouchers all day (they never touch Tally). At 23:50 IST a cron re-validates every draft
// against Tally's freshly-synced masters, groups the valid ones into a BATCH, and asks for approval in
// Teams. Only when an admin approves do the vouchers become `queued` for the bridge agent to post.
//
//   draft ──(23:50 cron)──► awaiting_approval ──(admin says yes)──► queued ──► posting ──► posted
//     ▲                            │                                                   └─► failed
//     └────(rejected / expired)────┘
//
// Deliberate decisions:
//  • The batch lives in Postgres, not in a module-level variable. The Amazon review approval keeps its
//    pending batch in memory, so a restart silently loses it — unacceptable for money.
//  • A voucher that fails validation is NOT dropped and NOT failed: it stays `draft` with a
//    `validation_error`, is listed in the Teams card's Blocked section, and rejoins the next run once
//    fixed. One typo therefore never blocks the other twelve.
//  • The result card is posted by a WATCHER cron, not from inside /bridge/ack. If the agent dies
//    mid-batch a cron still notices and reports; an inline hook never would.
//  • Approving is admin-only, enforced here as well as in the UI.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const config = require('../../config');
const { supabase } = require('../supabase');
const T = require('./tally_xml');
const tally = require('./tally');
const { postTeams } = require('./teams');

const ENABLED = () => String(config.TALLY_BATCH_CRON_ENABLED || '').toLowerCase() === 'true';
const REQUIRE_APPROVAL = () => String(config.TALLY_BATCH_REQUIRE_APPROVAL ?? 'true').toLowerCase() !== 'false';
const NOTIFY_EMPTY = () => String(config.TALLY_NOTIFY_EMPTY || '').toLowerCase() === 'true';
const BATCH_TTL_H = Math.max(1, parseInt(config.TALLY_BATCH_TTL_HOURS, 10) || 24);
const BATCH_MAX = Math.max(1, parseInt(config.TALLY_BATCH_MAX, 10) || 250);
// The APPROVAL request goes to the admin-only finance channel (its membership is the authorisation
// boundary). Results and exception cards can go elsewhere — typically a general "cron confirmations"
// channel — via TEAMS_WEBHOOK_FINANCE_RESULT; unset means both use the same webhook.
const webhook = (kind) => (kind === 'result'
    ? (config.TEAMS_WEBHOOK_FINANCE_RESULT || config.TEAMS_WEBHOOK_FINANCE)
    : config.TEAMS_WEBHOOK_FINANCE) || config.TEAMS_WEBHOOK_WAREHOUSE || null;

const istNow = () => new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
const istToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const money = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dmy = (d) => String(d || '').split('-').reverse().join('-');

// ── Teams ────────────────────────────────────────────────────────────────────────────────────────
async function teamsCard(blocks, opts = {}, kind = 'result') {
    const url = webhook(kind);
    if (!url) { console.log('[TallyBatch] no TEAMS_WEBHOOK_FINANCE — skipping Teams post'); return false; }
    const o = { text: true, ...opts };
    if (config.DASHBOARD_URL) {
        o.actionUrl = String(config.DASHBOARD_URL).replace(/\/$/, '') + '/#finance-register';
        o.actionTitle = 'Open Voucher Register';
    }
    return postTeams(url, { blocks }, o);
}
const H = (text) => ({ type: 'header', text: { type: 'plain_text', text } });
const S = (text) => ({ type: 'section', text: { type: 'mrkdwn', text } });
const C = (text) => ({ type: 'context', elements: [{ type: 'mrkdwn', text }] });

// ── batch reference: TB-YYYYMMDD-n, unique per day ───────────────────────────────────────────────
async function nextRef() {
    const d = istToday().replace(/-/g, '');
    const { data } = await supabase.from('tally_push_batches_ecom')
        .select('ref').like('ref', `TB-${d}-%`).order('ref', { ascending: false }).limit(1);
    const n = data && data[0] ? (parseInt(String(data[0].ref).split('-').pop(), 10) || 0) + 1 : 1;
    return `TB-${d}-${n}`;
}

// ── pre-flight: make the masters current, so validation reflects Tally as it is right now ─────────
// A ledger renamed at 6 PM must not let a 23:50 push create it afresh under Suspense.
async function refreshMasters(waitMs = 120000) {
    if (tally.MODE() === 'direct') {
        try { const r = await tally.syncMastersDirect(); return { ok: true, mode: 'direct', counts: r.counts }; }
        catch (e) { return { ok: false, error: e.message }; }
    }
    // Bridge mode: ask the agent, then wait for masters_synced_at to move.
    const { data: before } = await supabase.from('tally_bridge_status_ecom').select('masters_synced_at').eq('id', 1).maybeSingle();
    const was = before && before.masters_synced_at ? new Date(before.masters_synced_at).getTime() : 0;
    await supabase.from('tally_bridge_status_ecom').update({ sync_requested: true }).eq('id', 1);
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
        await new Promise(s => setTimeout(s, 5000));
        const { data } = await supabase.from('tally_bridge_status_ecom').select('masters_synced_at, last_seen_at').eq('id', 1).maybeSingle();
        const now = data && data.masters_synced_at ? new Date(data.masters_synced_at).getTime() : 0;
        if (now > was) return { ok: true, mode: 'bridge' };
    }
    return { ok: false, error: 'The bridge agent did not refresh the masters in time — is it running on the Tally PC?' };
}

async function bridgeIsLive() {
    if (tally.MODE() === 'direct') return true;
    const { data } = await supabase.from('tally_bridge_status_ecom').select('last_seen_at, tally_reachable').eq('id', 1).maybeSingle();
    if (!data || !data.last_seen_at) return false;
    return Date.now() - new Date(data.last_seen_at).getTime() < 120000 && !!data.tally_reachable;
}

// ── build the batch ──────────────────────────────────────────────────────────────────────────────
// `source` scopes which drafts are eligible. The NIGHTLY run takes only 'manual' entries: a bank
// statement import can leave ~1000 drafts, and sweeping those into one Teams card would produce an
// unreadable approval and a push nobody can supervise. Imported vouchers are posted deliberately
// instead, from the import screen, in controlled batches.
async function buildBatch({ trigger = 'cron', createdBy = null, source = null, limit = BATCH_MAX } = {}) {
    // Never build a second batch while one is still awaiting a decision — that would ask twice for
    // overlapping vouchers and make "approve" ambiguous.
    const { data: open } = await supabase.from('tally_push_batches_ecom')
        .select('id, ref, status').in('status', ['awaiting_approval', 'approved', 'pushing']).limit(1);
    if (open && open.length) return { skipped: true, reason: `batch ${open[0].ref} is still ${open[0].status}`, batch: open[0] };

    let q = supabase.from('tally_vouchers_ecom').select('*', { count: 'exact' })
        .eq('status', 'draft').order('created_at', { ascending: true });
    if (source) q = q.eq('source', source);
    const { data: drafts, error, count: totalWaiting } = await q.limit(Math.min(limit, BATCH_MAX));
    if (error) throw new Error(error.message);
    if (!drafts || !drafts.length) return { skipped: true, reason: 'no drafts to push', empty: true };
    // How many eligible drafts did NOT fit in this batch — reported so nobody assumes it was everything.
    const leftOver = Math.max(0, (totalWaiting || drafts.length) - drafts.length);

    const sync = await refreshMasters();
    if (!sync.ok) return { skipped: true, reason: sync.error, syncFailed: true, count: drafts.length };

    const company = await tally.resolveCompany();
    const known = await tally.knownLedgerSet(company);
    const today = istToday();

    const ready = [], blocked = [];
    for (const v of drafts) {
        const errs = [];
        if (v.company && v.company !== company)
            errs.push(`drafted for company "${v.company}" but Tally has "${company}" open`);
        if (v.voucher_date > today) errs.push(`dated ${dmy(v.voucher_date)}, which is in the future`);
        const chk = T.validateVoucher({
            voucherType: v.voucher_type, date: v.voucher_date, company,
            partyLedger: v.party_ledger, entries: v.entries,
        }, known);
        errs.push(...chk.errors);
        // Bill references only make sense on bill-wise ledgers (else Tally silently ignores them and
        // the payment sits on account instead of settling the invoice).
        (v.entries || []).forEach((e, i) => {
            if (e.bill_ref && !known.has(e.ledger)) errs.push(`Row ${i + 1}: unknown ledger for the bill reference`);
        });
        if (errs.length) blocked.push({ v, error: errs[0], all: errs });
        else ready.push(v);
    }

    // Blocked vouchers stay `draft` so that fixing them puts them in the next run automatically.
    for (const b of blocked) {
        await supabase.from('tally_vouchers_ecom')
            .update({ validation_error: b.all.join('; ') }).eq('id', b.v.id).eq('status', 'draft');
    }

    if (!ready.length) {
        const batch = { ref: await nextRef(), company, status: 'empty', trigger, created_by: createdBy,
            voucher_count: 0, total_amount: 0, blocked_count: blocked.length,
            blocked: blocked.map(b => blockedRow(b)), finished_at: new Date().toISOString() };
        const { data: row } = await supabase.from('tally_push_batches_ecom').insert(batch).select('*').single();
        await notifyAllBlocked(row);
        return { skipped: true, reason: 'every draft failed validation', batch: row, blocked: blocked.length };
    }

    const ref = await nextRef();
    const total = ready.reduce((s, v) => s + Number(v.total_amount || 0), 0);
    const { data: batch, error: bErr } = await supabase.from('tally_push_batches_ecom').insert({
        ref, company, trigger, created_by: createdBy,
        status: REQUIRE_APPROVAL() ? 'awaiting_approval' : 'approved',
        voucher_count: ready.length, total_amount: total,
        blocked_count: blocked.length, blocked: blocked.map(b => blockedRow(b)),
        expires_at: new Date(Date.now() + BATCH_TTL_H * 3600 * 1000).toISOString(),
        approved_by: REQUIRE_APPROVAL() ? null : 'auto',
        approved_at: REQUIRE_APPROVAL() ? null : new Date().toISOString(),
        approval_source: REQUIRE_APPROVAL() ? null : 'auto',
    }).select('*').single();
    if (bErr) throw new Error(bErr.message);

    // Claim each voucher into the batch under a status filter, so a concurrent manual push can't also
    // take it. Anything we lose the race for simply isn't in this batch.
    let claimed = 0;
    for (const v of ready) {
        const { data } = await supabase.from('tally_vouchers_ecom')
            .update({ status: 'awaiting_approval', batch_id: batch.id, validation_error: null })
            .eq('id', v.id).eq('status', 'draft').select('id');
        if (data && data.length) claimed++;
    }
    if (claimed !== ready.length) {
        const actual = ready.filter((_, i) => i < claimed).reduce((s, v) => s + Number(v.total_amount || 0), 0);
        await supabase.from('tally_push_batches_ecom')
            .update({ voucher_count: claimed, total_amount: actual }).eq('id', batch.id);
        batch.voucher_count = claimed; batch.total_amount = actual;
    }

    const vouchers = ready.slice(0, claimed);
    if (REQUIRE_APPROVAL()) await notifyApproval(batch, vouchers, blocked, leftOver);
    else { await approveBatch(batch.id, 'auto', 'auto'); }
    return { ok: true, batch, count: claimed, blocked: blocked.length };
}

const blockedRow = (b) => ({
    id: b.v.id, type: b.v.voucher_type, date: b.v.voucher_date,
    amount: Number(b.v.total_amount || 0), by: b.v.created_by || null, error: b.error,
});

// ── Teams: approval request ──────────────────────────────────────────────────────────────────────
async function notifyApproval(batch, vouchers, blocked, leftOver = 0) {
    const byType = {};
    vouchers.forEach(v => { byType[v.voucher_type] = byType[v.voucher_type] || { n: 0, t: 0 };
        byType[v.voucher_type].n++; byType[v.voucher_type].t += Number(v.total_amount || 0); });
    const byUser = {};
    vouchers.forEach(v => { const k = v.created_by || 'unknown'; byUser[k] = (byUser[k] || 0) + 1; });

    const lines = vouchers.slice(0, 15).map(v =>
        `• \`${dmy(v.voucher_date)}\`  *${v.voucher_type}*  ${v.party_ledger || (v.entries[0] && v.entries[0].ledger) || ''} — *${money(v.total_amount)}*` +
        (v.created_by ? `  _(${v.created_by})_` : ''));
    if (vouchers.length > 15) lines.push(`_…and ${vouchers.length - 15} more_`);

    const blocks = [
        H('🧾 Tally push — approval needed'),
        S(`*${batch.ref}*  ·  ${batch.company}\n*${batch.voucher_count}* voucher${batch.voucher_count === 1 ? '' : 's'} ready  ·  total *${money(batch.total_amount)}*`),
        S(Object.entries(byType).map(([t, x]) => `*${t}* ${x.n} · ${money(x.t)}`).join('    ')),
        C('Entered by ' + Object.entries(byUser).map(([u, n]) => `${u} (${n})`).join(', ')),
        S(lines.join('\n')),
    ];
    if (blocked.length) {
        blocks.push(S(`⚠️ *Blocked — NOT in this batch (${blocked.length})*\nThese stay as drafts; fix them and they join the next run.\n` +
            blocked.slice(0, 8).map(b => `• \`${dmy(b.v.voucher_date)}\` *${b.v.voucher_type}* ${money(b.v.total_amount)} — ${b.error}`).join('\n') +
            (blocked.length > 8 ? `\n_…and ${blocked.length - 8} more_` : '')));
    }
    blocks.push(S(`Reply **yes** to push, or **no** to cancel.  _(or_ \`approve ${batch.ref}\` _/_ \`reject ${batch.ref}\`_)_`));
    if (leftOver) blocks.push(S(`_${leftOver} more draft(s) did not fit in this batch (cap ${BATCH_MAX}) — they will be offered on the next run._`));
    blocks.push(C(`Expires in ${BATCH_TTL_H}h · ${istNow()} IST · nothing has been sent to Tally yet`));
    await teamsCard(blocks, {}, 'approval');
}

async function notifyAllBlocked(batch) {
    await teamsCard([
        H('⚠️ Tally push — nothing could be pushed'),
        S(`*${batch.ref}*  ·  every one of the *${batch.blocked_count}* draft voucher(s) failed validation, so no batch was created.`),
        S((batch.blocked || []).slice(0, 10).map(b => `• \`${dmy(b.date)}\` *${b.type}* ${money(b.amount)} — ${b.error}`).join('\n')),
        C(`They remain drafts — fix them in Finance → Data Entry and the next run will pick them up. ${istNow()} IST`),
    ]);
}

// ── approve / reject ─────────────────────────────────────────────────────────────────────────────
// A status-filtered update means two admins approving at once can't both win.
async function approveBatch(batchId, who, source = 'dashboard') {
    const { data: rows } = await supabase.from('tally_push_batches_ecom')
        .update({ status: 'approved', approved_by: who, approved_at: new Date().toISOString(),
                  approval_source: source, started_at: new Date().toISOString() })
        .eq('id', batchId).eq('status', 'awaiting_approval').select('*');
    if (!rows || !rows.length) return { ok: false, reason: 'that batch is no longer awaiting approval' };
    const batch = rows[0];

    if (!tally.POST_ENABLED()) {
        await supabase.from('tally_push_batches_ecom')
            .update({ status: 'failed', error: 'TALLY_POST_ENABLED is not true', finished_at: new Date().toISOString() }).eq('id', batch.id);
        await teamsCard([H('🛑 Tally push blocked'), S(`*${batch.ref}* was approved, but posting is switched off on the server (\`TALLY_POST_ENABLED\`). Nothing was sent.`)]);
        return { ok: false, reason: 'posting is disabled on the server' };
    }

    // Build each voucher's XML now and move it to `queued` for the agent (or post inline in direct mode).
    const { data: vs } = await supabase.from('tally_vouchers_ecom').select('*').eq('batch_id', batch.id).eq('status', 'awaiting_approval');
    let queued = 0;
    for (const v of vs || []) {
        const reference = v.reference || T.refMarker(v.id);
        let xml;
        try {
            xml = T.buildVoucherXml({ voucherType: v.voucher_type, date: v.voucher_date, company: v.company,
                partyLedger: v.party_ledger, reference, narration: v.narration, entries: v.entries });
        } catch (e) {
            await supabase.from('tally_vouchers_ecom').update({ status: 'failed', error: e.message }).eq('id', v.id);
            continue;
        }
        const { data } = await supabase.from('tally_vouchers_ecom')
            .update({ status: 'queued', reference, request_xml: xml, error: null,
                      attempts: (v.attempts || 0) + 1, idempotency_key: 'v:' + v.id, posted_by: who })
            .eq('id', v.id).eq('status', 'awaiting_approval').select('id');
        if (data && data.length) queued++;
    }
    await supabase.from('tally_push_batches_ecom').update({ status: 'pushing' }).eq('id', batch.id);

    // Direct mode has no agent — post them here and let the watcher report as usual.
    if (tally.MODE() === 'direct') await pushQueuedDirect(batch.id);
    return { ok: true, ref: batch.ref, queued };
}

async function rejectBatch(batchId, who, source = 'dashboard') {
    const { data: rows } = await supabase.from('tally_push_batches_ecom')
        .update({ status: 'rejected', rejected_by: who, rejected_at: new Date().toISOString(), finished_at: new Date().toISOString() })
        .eq('id', batchId).eq('status', 'awaiting_approval').select('*');
    if (!rows || !rows.length) return { ok: false, reason: 'that batch is no longer awaiting approval' };
    const batch = rows[0];
    await supabase.from('tally_vouchers_ecom')
        .update({ status: 'draft', batch_id: null }).eq('batch_id', batch.id).eq('status', 'awaiting_approval');
    await teamsCard([
        H('🛑 Tally push cancelled'),
        S(`*${batch.ref}* rejected by *${who}*. All ${batch.voucher_count} voucher(s) are back to draft — nothing was sent to Tally.`),
        C(istNow() + ' IST'),
    ]);
    return { ok: true, ref: batch.ref };
}

// Direct mode: post the batch's queued vouchers inline, reusing tally.js's single result-writer.
async function pushQueuedDirect(batchId) {
    const { data: vs } = await supabase.from('tally_vouchers_ecom')
        .select('id, request_xml').eq('batch_id', batchId).eq('status', 'queued');
    for (const v of vs || []) {
        const claimed = await supabase.from('tally_vouchers_ecom').update({ status: 'posting' }).eq('id', v.id).eq('status', 'queued').select('id');
        if (!claimed.data || !claimed.data.length) continue;
        try { await tally.applyResult(v.id, T.parseImportResponse(await tally.tallyPost(v.request_xml)), null, null); }
        catch (e) {
            await tally.applyResult(v.id, { ok: false, raw: '',
                error: `Could not reach Tally (${e.message}) — unknown outcome, verify in Tally before retrying.` }, null, null);
        }
        await new Promise(s => setTimeout(s, 400));
    }
}

// ── watcher: report a batch once every voucher in it reaches a terminal state ─────────────────────
// A cron, not a hook inside /bridge/ack: if the agent dies mid-batch this still notices and reports.
async function checkOpenBatches() {
    const { data: batches } = await supabase.from('tally_push_batches_ecom')
        .select('*').in('status', ['pushing']).eq('result_notified', false);
    for (const b of batches || []) {
        const { data: vs } = await supabase.from('tally_vouchers_ecom')
            .select('id, status, voucher_type, total_amount, tally_voucher_number, tally_masterid, error, voucher_date')
            .eq('batch_id', b.id);
        const pending = (vs || []).filter(v => ['queued', 'posting', 'awaiting_approval'].includes(v.status));
        const stuckFor = Date.now() - new Date(b.started_at || b.created_at).getTime();
        // Still in flight — but if it has been stuck for over an hour, say so rather than stay silent.
        if (pending.length) {
            if (stuckFor > 60 * 60 * 1000 && !b.error) {
                await supabase.from('tally_push_batches_ecom').update({ error: 'stalled' }).eq('id', b.id);
                await teamsCard([H('⏳ Tally push is stalled'),
                    S(`*${b.ref}* — ${pending.length} of ${b.voucher_count} voucher(s) still not posted after an hour. Is the bridge agent running on the Tally PC?`),
                    C(istNow() + ' IST')]);
            }
            continue;
        }
        const posted = (vs || []).filter(v => v.status === 'posted');
        const failed = (vs || []).filter(v => v.status === 'failed');
        await supabase.from('tally_push_batches_ecom').update({
            status: failed.length ? 'failed' : 'done',
            posted_count: posted.length, failed_count: failed.length,
            result_notified: true, finished_at: new Date().toISOString(),
        }).eq('id', b.id);
        await notifyResult(b, posted, failed);
    }
}

async function notifyResult(batch, posted, failed) {
    const nums = {};
    posted.forEach(v => { const k = v.voucher_type; (nums[k] = nums[k] || []).push(v.tally_voucher_number || v.tally_masterid || '?'); });
    const blocks = failed.length
        ? [H('⚠️ Tally push finished with failures'),
           S(`*${batch.ref}*  ·  posted *${posted.length}*  ·  failed *${failed.length}*  of ${batch.voucher_count}`),
           S(failed.slice(0, 10).map(v => `✗ \`${dmy(v.voucher_date)}\` *${v.voucher_type}* ${money(v.total_amount)} — ${v.error || 'unknown error'}`).join('\n'))]
        : [H('✅ Tally push complete'),
           S(`*${batch.ref}*  ·  posted *${posted.length}* of ${batch.voucher_count}  ·  ${money(batch.total_amount)}`)];
    if (posted.length) blocks.push(C('Tally voucher nos — ' + Object.entries(nums).map(([t, a]) => `${t}: ${a.join(', ')}`).join(' · ')));
    blocks.push(C(`Approved by ${batch.approved_by || '—'}${batch.approval_source ? ' via ' + batch.approval_source : ''} · ${istNow()} IST`));
    if (failed.length) blocks.push(C('Failed vouchers stay in the register with Tally\'s own error — fix and retry from Finance → Voucher Register.'));
    await teamsCard(blocks);
}

// ── expiry: an unapproved batch must not linger and must never double-post ────────────────────────
async function expireStaleBatches() {
    const { data: batches } = await supabase.from('tally_push_batches_ecom')
        .select('*').eq('status', 'awaiting_approval').lt('expires_at', new Date().toISOString());
    for (const b of batches || []) {
        await supabase.from('tally_push_batches_ecom')
            .update({ status: 'expired', finished_at: new Date().toISOString() }).eq('id', b.id);
        // Vouchers go back to draft, so the next run includes them — they are never lost or duplicated.
        await supabase.from('tally_vouchers_ecom')
            .update({ status: 'draft', batch_id: null }).eq('batch_id', b.id).eq('status', 'awaiting_approval');
        await teamsCard([H('⌛ Tally push expired'),
            S(`*${b.ref}* was not approved within ${BATCH_TTL_H}h. Its ${b.voucher_count} voucher(s) are back to draft and will be offered again on the next run.`),
            C(istNow() + ' IST')]);
    }
}

// ── the nightly job ──────────────────────────────────────────────────────────────────────────────
async function runNightly() {
    if (!ENABLED()) { console.log('[TallyBatch] disabled (TALLY_BATCH_CRON_ENABLED is not true)'); return { skipped: true, reason: 'disabled' }; }
    console.log('[TallyBatch] nightly run starting…');
    if (!(await bridgeIsLive())) {
        const { count } = await supabase.from('tally_vouchers_ecom').select('id', { count: 'exact', head: true }).eq('status', 'draft');
        console.warn('[TallyBatch] bridge offline — holding');
        if (count) await teamsCard([H('🔌 Tally bridge offline'),
            S(`Tonight's push was skipped: the bridge agent on the Tally PC has not checked in. *${count}* draft voucher(s) are waiting and nothing has been lost.`),
            C('Start tally-bridge/agent.js on the Tally PC (and keep Tally open). ' + istNow() + ' IST')]);
        return { skipped: true, reason: 'bridge offline', drafts: count || 0 };
    }
    try {
        // 'manual' only — imported statements are posted from the import screen, not swept up here.
        const r = await buildBatch({ trigger: 'cron', source: 'manual' });
        if (r.skipped) {
            console.log('[TallyBatch] skipped —', r.reason);
            if (r.empty && NOTIFY_EMPTY()) await teamsCard([H('🧾 Tally push — nothing to send'), S('No draft vouchers today.'), C(istNow() + ' IST')]);
            if (r.syncFailed) await teamsCard([H('⚠️ Tally push skipped'), S(`Could not refresh Tally's ledger list, so ${r.count} draft(s) were not validated: ${r.reason}`), C(istNow() + ' IST')]);
        } else console.log(`[TallyBatch] ${r.batch.ref}: ${r.count} awaiting approval, ${r.blocked} blocked`);
        return r;
    } catch (e) {
        console.error('[TallyBatch] nightly error:', e.message);
        await teamsCard([H('❌ Tally push failed to start'), S('The nightly job errored: ' + e.message), C(istNow() + ' IST')]);
        return { error: e.message };
    }
}

// ── Teams keyword entry point (called by teams_listener.js) ───────────────────────────────────────
// `who` is the Teams display name. Approval is admin-only, but Teams gives us no role — so the finance
// channel itself IS the authorisation boundary: only admins should be members of it. That is stated in
// the README and the docs, and every approval is recorded with the name that triggered it.
async function handleTeamsKeyword(text, who) {
    const t = String(text || '').trim().toLowerCase();
    const explicit = t.match(/^(approve|reject)\s+(tb-\d{8}-\d+)$/i);
    let action = null, ref = null;
    if (explicit) { action = explicit[1].toLowerCase() === 'approve' ? 'yes' : 'no'; ref = explicit[2].toUpperCase(); }
    else if (['yes', 'y', 'confirm', 'approve'].includes(t)) action = 'yes';
    else if (['no', 'n', 'cancel', 'reject'].includes(t)) action = 'no';
    if (!action) return { ok: false, reason: 'not a finance keyword' };

    let q = supabase.from('tally_push_batches_ecom').select('*').eq('status', 'awaiting_approval');
    q = ref ? q.eq('ref', ref) : q.order('created_at', { ascending: false }).limit(1);
    const { data } = await q;
    const batch = data && data[0];
    if (!batch) return { ok: false, reason: ref ? `no batch ${ref} awaiting approval` : 'no Tally batch is awaiting approval' };

    if (action === 'yes') {
        await teamsCard([H('🔄 Approved — pushing to Tally'), S(`*${batch.ref}* approved by *${who}*. Posting ${batch.voucher_count} voucher(s) now; the result follows.`)], {}, 'approval');
        return await approveBatch(batch.id, who, 'teams');
    }
    return await rejectBatch(batch.id, who, 'teams');
}

// ── HTTP ─────────────────────────────────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
    if (req.user && req.user.role === 'admin') return next();
    return res.status(403).json({ success: false, error: 'Only an admin can approve or push a Tally batch.' });
}

// GET /tally/batches — the batch history (any finance user may look).
router.get('/tally/batches', async (req, res) => {
    try {
        const { data, error } = await supabase.from('tally_push_batches_ecom')
            .select('*').order('created_at', { ascending: false }).limit(Math.min(parseInt(req.query.limit, 10) || 50, 200));
        if (error) throw new Error(error.message);
        res.json({ success: true, rows: data || [], canApprove: !!(req.user && req.user.role === 'admin') });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// GET /tally/batches/:id — one batch plus its vouchers.
router.get('/tally/batches/:id', async (req, res) => {
    try {
        const { data: batch } = await supabase.from('tally_push_batches_ecom').select('*').eq('id', req.params.id).maybeSingle();
        if (!batch) return res.status(404).json({ success: false, error: 'Batch not found' });
        const { data: vouchers } = await supabase.from('tally_vouchers_ecom')
            .select(tally.VOUCHER_COLS).eq('batch_id', batch.id).order('created_at', { ascending: true });
        res.json({ success: true, batch, vouchers: vouchers || [], canApprove: !!(req.user && req.user.role === 'admin') });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/tally/batches/:id/approve', requireAdmin, async (req, res) => {
    try {
        const r = await approveBatch(req.params.id, (req.user && req.user.sub) || 'admin', 'dashboard');
        if (!r.ok) return res.status(409).json({ success: false, error: r.reason });
        res.json({ success: true, ...r });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/tally/batches/:id/reject', requireAdmin, async (req, res) => {
    try {
        const r = await rejectBatch(req.params.id, (req.user && req.user.sub) || 'admin', 'dashboard');
        if (!r.ok) return res.status(409).json({ success: false, error: r.reason });
        res.json({ success: true, ...r });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// POST /tally/batches/build — run the nightly job now (admin). Used to test without waiting for 23:50.
router.post('/tally/batches/build', requireAdmin, async (req, res) => {
    try {
        res.json({ success: true, result: await buildBatch({
            trigger: 'manual', createdBy: (req.user && req.user.sub) || null,
            source: req.body && req.body.source ? String(req.body.source) : null,
            limit: req.body && req.body.limit ? Math.min(parseInt(req.body.limit, 10) || BATCH_MAX, BATCH_MAX) : BATCH_MAX,
        }) });
    }
    catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// The batch currently awaiting a yes/no, or null. Used by the Teams listener to route a bare "yes"
// when the finance channel is shared with another approval flow.
async function hasPendingBatch() {
    const { data } = await supabase.from('tally_push_batches_ecom')
        .select('id, ref, voucher_count, total_amount').eq('status', 'awaiting_approval')
        .order('created_at', { ascending: false }).limit(1);
    return (data && data[0]) || null;
}

module.exports = { router, runNightly, buildBatch, approveBatch, rejectBatch,
                  checkOpenBatches, expireStaleBatches, handleTeamsKeyword, teamsCard, hasPendingBatch };
