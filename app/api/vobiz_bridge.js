// ─────────────────────────────────────────────────────────────────────────────
// Vobiz ⇄ Sarvam bridge — the browser voice agent's pipeline, on a REAL phone call.
//
// Vobiz places the call (POST /api/v1/Account/{id}/Call/) and, once answered, fetches our
// /vobiz/answer webhook, which returns a <Stream> XML pointing at our WebSocket. From then on:
//
//   caller audio  →  Vobiz media frames (L16 @16k, base64, ~20ms)  →  Sarvam realtime STT (VAD)
//   transcript.final  →  Sarvam chat (SSE, cut at sentence/clause boundaries)
//   sentences  →  Sarvam TTS WS (bulbul:v3, linear16 @24k)  →  Vobiz playAudio (L16 @24k)
//
// The formats line up on BOTH legs (L16/16k in = exactly what Sarvam STT eats; linear16/24k out =
// exactly what Vobiz playAudio accepts), so the bridge moves base64 strings, not transcoded audio.
// ⚠ VOBIZ_L16_SWAP exists because "L16" classically means big-endian while Sarvam speaks
// little-endian raw PCM — if first-call transcripts are garbage and the voice is static, set it
// ('in', 'out' or 'both') instead of touching code.
//
// Turn-taking is VAD (a phone call has no push-to-talk): Sarvam's endpointing=vad emits
// vad.speech_start / transcript.final; a speech_start while the agent is talking = BARGE-IN →
// Vobiz gets {"type":"clearAudio"} (drops its buffered speech instantly) and the in-flight
// chat/TTS turn is aborted.
//
// ⚠ TEST SAFETY: outbound calls are refused for any phone not on VOBIZ_CALL_ALLOWLIST while that
// var is set — its OWN list since 2026-08-27, when WhatsApp opened to every customer (unset = open).
// ⚠ PROMPTS are a compact server-side copy of the rules living in voice-agent.html (spoken style,
// persona, brand closing). If the page's prompts evolve, this file must follow — drift risk noted.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const axios = require('axios');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { supabase } = require('../supabase');
const config = require('../../config');
const { resolveOrderFields, allowlistBlocksFor } = require('./msg91_wa');
const allowlistBlocks = allowlistBlocksFor('VOBIZ_CALL_ALLOWLIST');   // calls keep a test list even though messages are open

const SARVAM_KEY = () => String(process.env.SARVAM_API_KEY || '').trim().split(/\s+/)[0];
const V_AUTH_ID = () => String(process.env.VOBIZ_AUTH_ID || '').trim();
const V_AUTH_TOKEN = () => String(process.env.VOBIZ_AUTH_TOKEN || '').trim();
const V_FROM = () => String(process.env.VOBIZ_FROM_NUMBER || '').replace(/\D/g, '');
const V_BASE = () => String(process.env.VOBIZ_PUBLIC_BASE || '').trim().replace(/\/$/, '');
const V_TOKEN = () => String(process.env.VOBIZ_WEBHOOK_TOKEN || '').trim();
const L16_SWAP = () => String(process.env.VOBIZ_L16_SWAP || 'none').trim();
const vobizConfigured = () => !!(V_AUTH_ID() && V_AUTH_TOKEN() && V_FROM() && V_BASE() && V_TOKEN() && SARVAM_KEY());

// ── product knowledge for the call (user, 2026-08-31: "before confirmation if customer asks for
// product detail and benefit, provide info, then take confirmation") ─────────────────────────────
// The REAL store descriptions, never invented claims: order line-item titles → shopify_products
// (title → product id) → Shopify Admin API body_html, stripped to speakable text and clamped.
// In-memory cache, 24h TTL — descriptions barely change and a restart just refetches. Any failure
// returns '' and the call proceeds without the block (the prompt then defers details to WhatsApp).
const _pkCache = new Map();                                        // product_title → { text, at }
function stripHtml(h) {
    return String(h || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '. ').replace(/<\/(p|li|h\d|div)>/gi, '. ').replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#?\w+;/g, ' ')
        .replace(/\s+/g, ' ').replace(/(\.\s*)+/g, '. ').trim();
}
// The CURATED knowledge base wins (product_knowledge_ecom — authored by Claude on the store
// catalog, master copy docs/PRODUCT_KNOWLEDGE.md, user 2026-08-31: "shopify description is not
// enough, make a document created by claude"): one row per base formula, matched by regex against
// each line title so a combo/kit picks up every component. Shopify body_html stays as the fallback
// for anything the table does not cover yet.
let _kbRows = null, _kbAt = 0;
async function knowledgeRows() {
    if (_kbRows && Date.now() - _kbAt < 10 * 60e3) return _kbRows;
    const { data } = await supabase.from('product_knowledge_ecom').select('title, match_rx, knowledge');
    if (data) { _kbRows = data; _kbAt = Date.now(); }
    return _kbRows || [];
}
async function productKnowledgeFor(orderName) {
    try {
        const { data: items } = await supabase.from('orders')
            .select('order_line_items(title)').or(`name.eq.${orderName},name.eq.#${orderName}`)
            .order('created_at', { ascending: false }).limit(1).maybeSingle();
        const li = items && items.order_line_items;
        const titles = [...new Set((Array.isArray(li) ? li : (li ? [li] : [])).map(x => String(x.title || '').trim()).filter(Boolean))].slice(0, 3);
        if (!titles.length) return '';
        // 1) curated knowledge — every base formula whose regex hits any line title, capped at 3
        try {
            const rows = await knowledgeRows();
            const hits = [];
            for (const r of rows) {
                let rx; try { rx = new RegExp(r.match_rx, 'i'); } catch (_) { continue; }
                if (titles.some(t => rx.test(t)) && !hits.some(h => h.title === r.title)) hits.push(r);
                if (hits.length >= 3) break;
            }
            if (hits.length) return hits.map(r => `${r.title}: ${r.knowledge}`).join('\n');
        } catch (_) { /* fall through to the store description */ }
        // 2) fallback — the store's own description from Shopify
        if (!config.SHOPIFY_SHOP_URL || !config.SHOPIFY_TOKEN) return '';
        const parts = [];
        for (const title of titles) {
            const hit = _pkCache.get(title);
            if (hit && Date.now() - hit.at < 24 * 3600e3) { if (hit.text) parts.push(hit.text); continue; }
            let text = '';
            try {
                const { data: prod } = await supabase.from('shopify_products')
                    .select('shopify_product_id').ilike('product_title', title.split(' - ')[0].trim() + '%').limit(1).maybeSingle();
                if (prod && prod.shopify_product_id) {
                    const r = await axios.get(`https://${config.SHOPIFY_SHOP_URL}/admin/api/2024-10/products/${prod.shopify_product_id}.json?fields=title,body_html`,
                        { headers: { 'X-Shopify-Access-Token': config.SHOPIFY_TOKEN }, timeout: 8000, validateStatus: () => true });
                    const b = r.status === 200 && r.data && r.data.product ? stripHtml(r.data.product.body_html) : '';
                    if (b) text = `${title}: ${b.slice(0, 550)}`;
                }
            } catch (_) { /* knowledge is optional — the call must never wait on it failing */ }
            _pkCache.set(title, { text, at: Date.now() });
            if (text) parts.push(text);
        }
        return parts.join('\n');
    } catch (_) { return ''; }
}

// ── sessions: one per placed call, keyed by sid carried through webhook + WS URLs ──
const sessions = new Map();
setInterval(() => { const cut = Date.now() - 3600e3; for (const [k, s] of sessions) if (s.createdAt < cut) sessions.delete(k); }, 600e3).unref();

// ── spoken-style + persona rules (compact copy of voice-agent.html — see drift note above) ──
const SPEAKERS = {
    priya: { name: 'Priya', gender: 'female' }, neha: { name: 'Neha', gender: 'female' },
    simran: { name: 'Simran', gender: 'female' }, kavya: { name: 'Kavya', gender: 'female' },
    shreya: { name: 'Shreya', gender: 'female' }, ishita: { name: 'Ishita', gender: 'female' },
    rahul: { name: 'Rahul', gender: 'male' }, amit: { name: 'Amit', gender: 'male' },
    rohan: { name: 'Rohan', gender: 'male' }, dev: { name: 'Dev', gender: 'male' },
};
const THANKS_RX = /धन्यवाद|ধন্যবাদ|நன்றி|ధన్యవాద|ಧನ್ಯವಾದ|നന്ദി|આભાર|ਧੰਨਵਾਦ|शुक्रिया|थैंक|नंदी|नन्दी|thank/i;
const HI_CLOSE = 'The Element को चुनने के लिए आपका धन्यवाद। आपका दिन शुभ हो।';

// The PANEL the button was pressed on decides what the call is FOR — three purposes, one voice.
const PURPOSES = {
    cod_confirm: {
        intro: 'on a REAL outbound call to verify a Cash on Delivery order the customer placed, BEFORE it is dispatched.',
        objectives: 'Objectives: greet by first name and introduce yourself; mention their order briefly (product and amount) and ask them to CONFIRM that they placed it and want it delivered; if they confirm, tell them it will be dispatched soon and close with thanks. If they say NO, deny placing it, or want to cancel (in ANY language): do NOT close yet — first ask politely, in the language they used: "May I know the reason please?"; listen, then close with "I have noted that <their reason, briefly>. Thank you for your time." plus the brand closing. Ask the reason only ONCE — if they refuse or repeat the no, close politely with it noted. Do NOT ask about delivery-time availability — this call is only about confirming the order itself.',
    },
    undelivered: {
        intro: 'on a REAL outbound call because the courier could NOT complete the delivery of their order.',
        objectives: 'Objectives: greet and introduce yourself; tell them politely that the delivery attempt for their order failed; ask what happened and when they will be available for a re-attempt; reassure them the courier will try again; thank and close. If they no longer want the order, note it politely and close.',
    },
    cod_rejected: {
        intro: 'on a REAL outbound call because the customer replied REJECT to our WhatsApp order-confirmation message.',
        objectives: 'Objectives: greet and introduce yourself; say softly that we received their cancellation reply for the order and you are calling to confirm; if they truly want to cancel, confirm politely that it is noted and nothing will be charged; if they changed their mind, confirm the order will be delivered as planned; thank and close. NEVER pressure them.',
    },
};
function buildPrompt(s) {
    const sp = SPEAKERS[s.voice] || SPEAKERS.kavya;
    const langName = LANG_NAMES[s.lang] || 'Hindi';
    const forms = sp.gender === 'male' ? 'कर रहा हूँ / बोल रहा हूँ' : 'कर रही हूँ / बोल रही हूँ';
    const purpose = PURPOSES[s.callType] || PURPOSES.cod_confirm;
    const offer = s.offerAsk
        ? `\nLANGUAGE OFFER: the customer's last reply appears to be in ${LANG_NAMES[s.offerAsk] || s.offerAsk}. In THIS reply, ask ONE short polite question — in both ${langName} and ${LANG_NAMES[s.offerAsk] || s.offerAsk} — whether they would prefer to continue in ${LANG_NAMES[s.offerAsk] || s.offerAsk}. Nothing else in this turn: do NOT act on what they just said — no confirming, no cancelling, no reason-asking, no closing.`
        : '';
    if (s.offerAsk) s.offerAsk = null;
    const override = s.langSwitched
        ? `\nLANGUAGE OVERRIDE: the customer has asked for ${langName}. Earlier turns were in a different language — that no longer matters. From your very next word, reply ONLY in ${langName}.`
        : '';
    const kb = s.ctx.productInfo
        ? `\nPRODUCT KNOWLEDGE (the store's own description — your ONLY source for product answers):\n${s.ctx.productInfo}\nIf the customer asks about the product, its use, ingredients or benefits: answer briefly (1-2 spoken sentences) FROM THIS KNOWLEDGE ONLY, then return to the confirmation question. If the answer is not here, say the support team will share full details on WhatsApp — NEVER invent claims or results.`
        : `\nIf the customer asks about the product or its benefits: share only what the order line says (${s.ctx.product || 'their order'}), tell them the support team will send full details on WhatsApp, then return to the confirmation question. NEVER invent claims.`;
    return `You are ${sp.name}, a ${sp.gender} skincare consultant and customer-care agent for The Element, an Ayurvedic skincare brand — confident, professional, knowledgeable and reassuring, always gentle and respectful — ${purpose.intro}
Order: ${s.ctx.product || 'their order'} for Rs.${s.ctx.amount || ''}. Customer first name: ${s.ctx.firstName}.${kb}
${purpose.objectives}${override}${offer}
If the customer indicates IN ANY WAY that they prefer or only understand another language (a direct ask, or statements like they only know Bengali), switch to that language IMMEDIATELY and continue the whole call in it.
DIFFERENT-LANGUAGE REPLY: when the customer answers in a language different from the one you are speaking, do NOT treat that reply as their final yes or no. First ask — one short question, in both your language and theirs — whether they would prefer to continue in their language, then repeat the confirmation question in whichever language they choose. If in any circumstance you do act on such a reply directly, your response MUST be spoken in the CUSTOMER'S language, never in yours.
TONE: courteous, professional and calm from the greeting to the goodbye — a trained customer-care executive, never a friend. No slang, no jokes, no cheeky or over-familiar phrases (never things like \u0905\u0930\u0947 \u0935\u093e\u0939, \u0915\u094d\u092f\u093e \u092c\u093e\u0924 \u0939\u0948, \u091a\u093f\u0932, boss, dear). Warmth comes from politeness, not casualness.
CALL SCREENING: some phones answer with an automated screening assistant that asks for your name and the reason for the call ("your name and reason for calling", "please stay on the line"). Screening assistants (Apple's included) understand ONLY ENGLISH — when you hear one, reply in ENGLISH regardless of the call language, with ONE short sentence only — "This is ${sp.name} from The Element, calling ${s.ctx.firstName} about their order confirmation." Then stop speaking and wait silently for the real person; never speak stage directions. Do NOT ask the order-confirmation question to the assistant, and do NOT repeat yourself to it. When the real customer then speaks (a hello or greeting), start fresh IN ${langName}: your FIRST sentence is only the greeting and your introduction (your name and The Element); the order details and the confirmation question come in the NEXT sentence — never all in one breath.
CONFIRMATION DISCIPLINE: sounds like hmm / haan-haan WHILE you are still explaining are listening signals, NOT confirmation. A confirmation counts ONLY as a clear affirmative (जी हाँ / हाँ / yes) given AFTER you finish asking the confirm question. If the reply is unclear or just a hum, politely ask once more for a clear हाँ या ना — never assume agreement.
PRODUCT-ANSWER RULES (apply ONLY when the customer asks about a product, its use, ingredients or benefits — every other part of the call follows its own flow above): recommend and mention ONLY The Element products — never name, compare or acknowledge any other brand. Never give a diagnostic label (never "you have eczema/rosacea") and never advise on prescription medicines; for a severe or worsening skin condition politely suggest seeing a dermatologist. If asked about safety: The Element formulations are created with inputs from India's leading dermatologists. Prices and offers change — for prices, politely point them to theelement.skin. DURATIONS — never invent a volume, dose or how long a pack lasts. The ONLY confirmed fact: Brightening Drops last 15 days per bottle at the recommended 5 to 6 drops twice daily (multiply for packs: 4 bottles is 60 days, about 2 months; 3 bottles is 45 days — say days or weeks, never round to months). For every other product say duration depends on usage — refer to the label.
SPOKEN DELIVERY RULES (your words go DIRECTLY to a voice synthesizer):
- Respond ONLY in ${langName} (if the customer asks for another supported language, switching is REQUIRED, never refused). Max 2 short sentences per turn. Only speakable words: no emoji, symbols, dashes, brackets, quotes or lists.
- NEVER read out a full order ID. Amounts stay in digits. Every sentence carries its own SUBJECT.
- Your OWN first-person ${langName === 'Hindi' ? 'Hindi verb forms are your gender’s: ' + forms : 'voice is ' + sp.gender}.
- Address the customer as FIRST NAME + ${langName === 'Hindi' ? 'जी' : '"ji"'}; for the customer always respectful plural forms (रहेंगे/करेंगे/होंगे) — NEVER feminine forms for the customer: रहेंगी, होंगी, चाहती, करेंगी are all FORBIDDEN — always चाहेंगे/रहेंगे.
- Asking for their time is a QUESTION: "क्या आपके पास दो मिनट हैं?" — never "बस दो मिनट का time है".
- CLOSING: ${langName === 'Hindi' ? `"${HI_CLOSE}"` : '"Thank you for choosing The Element. Have a great day."'} — never a bare goodbye, and spoken CALM and settled: the goodbye is a soft, warm sign-off, never excited — no exclamation marks anywhere in the closing sentences (the voice synthesizer reads "!" as excitement). Never repeat a sentence twice in the call.${s.lessonsBlock || ''}`;
}

function sanitizeReply(t) {
    let s = String(t || '');
    // TTS reads "!" as excitement — the user heard a bursting "Have a great day!" on a live call
    // (2026-08-31) and asked for sober. A courteous phone agent never needs an exclamation mark.
    s = s.replace(/!+/g, '.');
    s = s.replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/gi, ' ');
    s = s.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, ' ');
    s = s.replace(/<[^>]{1,80}>/g, ' ');
    s = s.replace(/\([^)]{0,80}\)/g, ' ');           // stage directions — never speech, never transcript
    s = s.replace(/[*_#]{1,3}/g, '');
    return s.replace(/\s+/g, ' ').trim();
}
function toSpokenText(t) {
    return String(t || '')
        .replace(/\([^)]{0,80}\)/g, ' ')          // stage directions like (wait patiently) are never speech
        .replace(/[—–]/g, ', ')
        .replace(/["“”‘’'`]/g, '')
        .replace(/[()\[\]{}<>#*_~^|\\\/]/g, ' ')
        .replace(/\s+([,.!?।])/g, '$1')
        .replace(/\s+/g, ' ').trim();
}
function swap16(buf) { const b = Buffer.from(buf); b.swap16(); return b; }

// ── streamed chat with the same sentence/clause splitter as the page ──
async function chatStream(history, systemPrompt, onSentence, signal) {
    const r = await fetch('https://api.sarvam.ai/v1/chat/completions', {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', 'api-subscription-key': SARVAM_KEY() },
        body: JSON.stringify({ model: 'sarvam-105b-conversations', stream: true, max_tokens: 200, temperature: 0.6, reasoning_effort: null,
            messages: [{ role: 'system', content: systemPrompt }, ...history] }),
    });
    if (!r.ok) throw new Error(`chat ${r.status}: ${(await r.text()).slice(0, 150)}`);
    let full = '', buf = '', emitted = false;
    const isBoundary = (s, i) => {
        const ch = s[i];
        if (ch === '\n' || ch === '।' || ch === '!' || ch === '?') return true;
        if (ch === '.') return i + 1 < s.length && /\s/.test(s[i + 1]);
        return false;
    };
    const drain = (force) => {
        let work = buf, held = '';
        const lt = work.lastIndexOf('<');
        if (lt >= 0 && work.indexOf('>', lt) < 0 && !force) { held = work.slice(lt); work = work.slice(0, lt); }
        for (;;) {
            let cut = -1;
            for (let i = 0; i < work.length; i++) {
                const hard = isBoundary(work, i);
                const soft = !emitted && (work[i] === ',' || work[i] === ';') && i + 1 < work.length && /\s/.test(work[i + 1]);
                const min = emitted ? 60 : (soft ? 18 : 1);
                if ((hard || soft) && i + 1 >= min) { cut = i + 1; break; }
            }
            if (cut < 0) break;
            const clean = sanitizeReply(work.slice(0, cut));
            if (clean) { onSentence(clean); emitted = true; }
            work = work.slice(cut);
        }
        if (force && work.trim()) { const c2 = sanitizeReply(work); if (c2) { onSentence(c2); emitted = true; } work = ''; }
        buf = work + held;
    };
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let sse = '';
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        sse += dec.decode(value, { stream: true });
        let nl;
        while ((nl = sse.indexOf('\n')) >= 0) {
            const line = sse.slice(0, nl).trim(); sse = sse.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const p = line.slice(5).trim();
            if (p === '[DONE]') continue;
            try { const d = JSON.parse(p).choices?.[0]?.delta?.content; if (d) { full += d; buf += d; drain(false); } } catch (_) {}
        }
    }
    drain(true);
    return sanitizeReply(full) || HI_CLOSE;
}

// ── one live call ──
class VoiceCall {
    constructor(vobizWs, session) {
        this.vobiz = vobizWs;
        this.s = session;
        this.history = [];
        this.speaking = false;
        this.turnAbort = null;
        this.ttsWs = null;
        this.streamId = null;                      // from the start event — REQUIRED on every send
        this.closingDone = false;                  // brand closing spoken — next pleasantry ends the call
        this.closed = false;
        this.startedAt = Date.now();
        // Presence: until the customer produces ANY transcript (a hum counts — it proves a person),
        // the agent must not push the script. ~9s from start with silence → "Hello? can you hear
        // me?" in the call's language; still silence at 15s from start → auto-hangup.
        this.presence = false;
        this.helloDone = false;
        this.sawVoice = false;                     // any VAD activity — a slow screener counts
        this.screenerSeen = false;                 // a screening robot answered; human still pending
        this.presenceTimer = setInterval(() => {
            if (this.closed || this.presence) { clearInterval(this.presenceTimer); return; }
            const el = Date.now() - this.startedAt;
            if (!this.helloDone && el >= 9000 && !this.speaking && !this.screenerSeen) {
                this.helloDone = true;
                this.sayLine(HELLO_CHECK[this.s.lang] || HELLO_CHECK['hi-IN']).catch(() => {});
            }
            const limit = this.screenerSeen ? 60000 : this.sawVoice ? 30000 : 15000;
            if (el >= limit) {
                clearInterval(this.presenceTimer);
                this.log(`no customer response in ${Math.round(limit / 1000)}s — ending call`);
                this.s.transcript.push('[no response from customer — call auto-ended]');
                this.hangup(500);
            }
        }, 500);
        this.sttOpen();
    }
    log(...a) { console.log(`[vobiz ${this.s.sid.slice(0, 6)}]`, ...a); }

    // caller → Sarvam. Frames are already linear16 @16k; VAD does the turn-taking.
    sttOpen() {
        const url = 'wss://api.sarvam.ai/speech-to-text-realtime/ws?language_code=' + encodeURIComponent(this.s.lang)
            + '&model=saaras:v3-realtime&endpointing=vad&stream_type=fast&encoding=linear16&sample_rate=16000'
            + '&silence_duration_ms=700&min_speech_duration_ms=200';
        this.stt = new WebSocket(url, ['api-subscription-key.' + SARVAM_KEY()]);
        this.stt.on('message', (m) => {
            let d; try { d = JSON.parse(m.toString()); } catch { return; }
            if (d.event === 'vad.speech_start') {
                this.sawVoice = true;
                this.vadActive = true;
                if (this.speaking) this.bargeIn();
            }
            if (d.event === 'vad.speech_end') this.vadActive = false;
            if (d.event === 'transcript.final' && d.text && d.text.trim()) this.onCustomer(d.text.trim());
        });
        this.stt.on('error', (e) => this.log('stt error:', e.message));
        this.stt.on('close', () => { if (!this.closed) this.log('stt closed mid-call'); });
    }
    feedCaller(b64) {
        if (!this.stt || this.stt.readyState !== 1) return;
        let payload = b64;
        if (L16_SWAP() === 'in' || L16_SWAP() === 'both') payload = swap16(Buffer.from(b64, 'base64')).toString('base64');
        this.stt.send(JSON.stringify({ event: 'audio_input', audio: payload }));
    }

    async sayLine(text) {
        try {
            const r = await axios.post('https://api.sarvam.ai/text-to-speech', {
                inputs: [text], target_language_code: TTS_LANG(this.s.lang), speaker: this.s.voice,
                model: 'bulbul:v3', speech_sample_rate: 24000, enable_preprocessing: true, output_audio_codec: 'wav',
            }, { headers: { 'api-subscription-key': SARVAM_KEY(), 'Content-Type': 'application/json' }, timeout: 15000 });
            const b64 = r.data && r.data.audios && r.data.audios[0];
            if (!b64 || this.closed) return;
            const pcm = Buffer.from(b64, 'base64').subarray(44).toString('base64');
            this.s.transcript.push('Agent: ' + text);
            this.speaking = true;
            this.playToCaller(pcm);
            const durMs = Math.round(Buffer.from(pcm, 'base64').length / 48) + 500;
            setTimeout(() => { if (!this.turnAbort) this.speaking = false; }, durMs);
        } catch (e) { this.log('sayLine failed:', e.message); }
    }

    bargeIn() {
        this.log('barge-in — customer spoke over the agent');
        try { this.vobiz.send(JSON.stringify({ event: 'clearAudio', streamId: this.streamId })); } catch (_) {}
        if (this.turnAbort) { try { this.turnAbort.abort(); } catch (_) {} this.turnAbort = null; }
        if (this.ttsWs) { try { this.ttsWs.close(); } catch (_) {} this.ttsWs = null; }
        this.speaking = false;
    }

    playToCaller(b64linear16) {
        if (!this.streamId) return;                // start event not seen yet — nothing to address
        let buf = Buffer.from(b64linear16, 'base64');
        if (L16_SWAP() === 'out' || L16_SWAP() === 'both') buf = swap16(buf);
        // 20–60ms per message (their guide) — 60ms @ 24k L16 = 2880 bytes; also keeps barge-in snappy.
        const SLICE = 2880;
        for (let i = 0; i < buf.length; i += SLICE) {
            const payload = buf.subarray(i, Math.min(buf.length, i + SLICE)).toString('base64');
            try { this.vobiz.send(JSON.stringify({ event: 'playAudio', streamId: this.streamId, media: { contentType: 'audio/x-l16', sampleRate: 24000, payload } })); } catch (_) { return; }
        }
    }

    // one agent turn: streamed chat → per-sentence TTS WS → playAudio frames
    async speakTurn(userMsgOrNull) {
        if (userMsgOrNull) this.history.push({ role: 'user', content: userMsgOrNull });
        const abort = new AbortController();
        this.turnAbort = abort;
        this.speaking = true;
        let lastChunkAt = 0, sentAny = false;
        const tts = new WebSocket('wss://api.sarvam.ai/text-to-speech/ws?model=bulbul:v3', ['api-subscription-key.' + SARVAM_KEY()]);
        this.ttsWs = tts;
        const ttsReady = new Promise((res) => {
            tts.on('open', () => {
                tts.send(JSON.stringify({ type: 'config', data: { speaker: this.s.voice, target_language_code: this.s.lang, output_audio_codec: 'linear16', speech_sample_rate: 24000, enable_preprocessing: true, pace: 1 } }));
                res(true);
            });
            tts.on('error', () => res(false));
        });
        tts.on('message', (m) => {
            try { const d = JSON.parse(m.toString()); const b64 = (d.data && d.data.audio) || d.audio;
                if (b64) { lastChunkAt = Date.now(); this.playToCaller(b64); } } catch (_) {}
        });
        try {
            const wsOk = await ttsReady;
            const say = (sentence) => {
                const spoken = toSpokenText(sentence);
                if (!spoken) return;
                if (wsOk && tts.readyState === 1) { sentAny = true; tts.send(JSON.stringify({ type: 'text', data: { text: spoken } })); tts.send(JSON.stringify({ type: 'flush' })); }
            };
            const prompt = buildPrompt(this.s);
            const messages = userMsgOrNull ? this.history
                : [{ role: 'user', content: `Open the call now. Greet ${this.s.ctx.firstName} warmly, introduce yourself by your first name, and ask if they have two minutes. 1-2 short sentences.` }];
            const text = await chatStream(messages, prompt, say, abort.signal);
            this.history.push({ role: 'assistant', content: text });
            this.s.transcript.push('Agent: ' + text);
            // brand name + a thanks word (any call language) = the goodbye was just delivered
            if (/The Element/i.test(text) && THANKS_RX.test(text)) this.closingDone = true;
            // identical reply twice in a row = the model is looping — treat as the close
            const prevA = [...this.history].reverse().slice(1).find(m => m.role === 'assistant');
            if (prevA && prevA.content.trim() === text.trim()) this.closingDone = true;
            // the socket has no end-of-stream event — the turn is over when chunks stop coming
            await new Promise((res) => {
                const started = Date.now();
                const t = setInterval(() => {
                    const gotAll = sentAny ? (lastChunkAt > 0 && Date.now() - lastChunkAt > 1200) : true;
                    if (gotAll || Date.now() - started > 20000 || abort.signal.aborted) { clearInterval(t); res(); }
                }, 200);
            });
        } catch (e) {
            if (!abort.signal.aborted) this.log('turn failed:', e.message);
        } finally {
            try { tts.close(); } catch (_) {}
            if (this.ttsWs === tts) this.ttsWs = null;
            if (this.turnAbort === abort) this.turnAbort = null;
            // audio is queued inside Vobiz — speaking ends a beat after the last frame is sent
            setTimeout(() => { if (!this.turnAbort) this.speaking = false; }, 1500);
            // Goodbye grace: ~3s for the closing audio to play out of Vobiz's buffer + a 5s
            // listening window. A customer mid-sentence (VAD active) is never cut off — their
            // finished sentence routes through the post-close logic (thanks → hang up politely,
            // a real question → reopen). Pure silence after the window → cut.
            if (this.closingDone) this.scheduleGoodbyeCut();
        }
    }

    scheduleGoodbyeCut() {
        if (this.goodbyeTimer) return;
        const started = Date.now();
        this.goodbyeTimer = setInterval(() => {
            if (this.closed || !this.closingDone) { clearInterval(this.goodbyeTimer); this.goodbyeTimer = null; return; }
            const el = Date.now() - started;
            if (el < 8000) return;                        // ~3s audio tail + the 5s response window
            if (this.vadActive && el < 18000) return;     // they are mid-sentence — let them finish
            clearInterval(this.goodbyeTimer); this.goodbyeTimer = null;
            this.log('no response after the goodbye — ending call');
            this.hangup(200);
        }, 500);
    }

    hangup(delayMs) {
        setTimeout(() => {
            if (this.closed) return;
            this.log('conversation complete — hanging up');
            try { this.vobiz.close(); } catch (_) {}
        }, delayMs || 0);
    }

    async playOpening() {
        this.speaking = true;
        let pcm = null;
        try { pcm = await Promise.race([this.s.openingPcmP, new Promise(res => setTimeout(() => res(null), 3000))]); } catch (_) {}
        if (!pcm) {
            this.log('opening not pre-synthesized — falling back to live turn');
            return this.speakTurn(null).catch(e => {
                this.log('opening turn failed:', e.message, '— last-resort direct line');
                return this.sayLine(openingLine(this.s) || HELLO_CHECK[this.s.lang] || HELLO_CHECK['hi-IN']);
            });
        }
        this.history.push({ role: 'assistant', content: this.s.openingText });
        this.s.transcript.push('Agent: ' + this.s.openingText);
        this.playToCaller(pcm);
        this.log('opening played from pre-synth' + (this.s.tAnswer ? ` (+${Date.now() - this.s.tAnswer}ms after answer webhook)` : ''));
        const durMs = Math.round(Buffer.from(pcm, 'base64').length / 48) + 500;   // bytes / (24000*2) → ms
        setTimeout(() => { if (!this.turnAbort) this.speaking = false; }, durMs);
    }

    onCustomer(text) {
        // VOICEMAIL: hang up the moment the machine identifies itself (user, 2026-08-31: "The person
        // you're trying to reach is not available… hang up the call, don't wait") — before this, the
        // agent chatted with an answering machine for 125 seconds (TE25-45530). Carrier phrases only,
        // third-person, so a real customer saying "I am busy" can never match. The close reason makes
        // the summary say voicemail → classifyOutcome files it no_answer → the retry ladder proceeds.
        const VOICEMAIL_RX = /person you.?re trying to reach|at the tone|record your message|after the (beep|tone)|please record|customer you (are|have) (called|calling)|is not reachable|switched off|coverage area|not answering (the|your) call|जिस व्यक्ति|ग्राहक.{0,20}(व्यस्त|उपलब्ध नहीं|पहुंच)|संदेश रिकॉर्ड/i;
        if (VOICEMAIL_RX.test(text)) {
            this.s.transcript.push('Customer: ' + text);
            this.s.transcript.push('[voicemail greeting detected — hung up immediately, no message left]');
            this.log('voicemail detected — hanging up:', text.slice(0, 60));
            this.hangup(200);
            return;
        }
        const SCREENER_RX = /screening|name and reason|reason for calling|stay on the line|स्क्रीनिंग|रीजन फॉर|स्टे ऑन द|कॉलिंग/i;
        if (SCREENER_RX.test(text)) {
            this.screenerSeen = true;           // a robot answered — the REAL customer hasn't talked yet
            this.log('screening assistant detected — waiting for the human (60s cap)');
        } else {
            this.presence = true;               // a genuine human utterance — countdown over
        }
        const FILLER_RX = /^[\s]*(हम(्?म)*|म्म+|उम+|हूँ|हुं|आं*|hm+m*|um+|uh+|mm+)[\s।,.!]*$/i;
        if (FILLER_RX.test(text)) { this.log('filler ignored:', text.slice(0, 20)); return; }
        this.s.transcript.push('Customer: ' + text);
        this.log('customer:', text.slice(0, 60));
        if (this.closingDone) {
            const t = text.trim();
            const substantial = /[?？]/.test(t) || (t.length >= 25 && !THANKS_RX.test(t));
            if (!substantial) {
                this.hangup(800);               // any short, question-free reply after the goodbye ends the call
                return;
            }
            this.closingDone = false;           // a real question after the goodbye — answer it
            if (this.goodbyeTimer) { clearInterval(this.goodbyeTimer); this.goodbyeTimer = null; }
        }
        const wantLang = requestedLanguage(text, this.s.lang);
        if (wantLang) {
            this.switchLanguage(wantLang);
            this.s.offeredLang = null;
        } else if (this.s.offeredLang && AFFIRM_RX.test(text) && text.trim().length < 16) {
            this.switchLanguage(this.s.offeredLang);   // they accepted the offered language
            this.s.offeredLang = null;
        } else {
            const seen = scriptLangOf(text);
            if (seen && seen !== this.s.lang && this.s.offeredLang !== seen) {
                this.s.offeredLang = seen;             // reply came in another script — OFFER it
                this.s.offerAsk = seen;                // consumed by the next prompt build
                this.log('customer replied in ' + (LANG_NAMES[seen] || seen) + ' — offering the switch');
            } else if (this.s.offeredLang && text.trim().length >= 16) {
                this.s.offeredLang = null;             // they carried on substantively — offer lapsed
            }
        }
        if (this.turnAbort) this.bargeIn();     // they answered before the agent finished
        this.speakTurn(text).catch(e => this.log('turn error:', e.message));
    }

    // Every layer flips together: STT live (config.update), prompt via s.lang next turn, TTS on the
    // next per-turn socket. The history keeps the old-language turns — the model handles that fine.
    switchLanguage(code) {
        this.log(`language switch: ${this.s.lang} → ${code} (customer asked)`);
        this.s.lang = code;
        this.s.langSwitched = true;
        try { if (this.stt && this.stt.readyState === 1) this.stt.send(JSON.stringify({ event: 'config.update', language_code: code })); } catch (_) {}
        this.s.transcript.push(`[language switched to ${LANG_NAMES[code] || code}]`);
    }

    async close(reason) {
        if (this.closed) return;
        this.closed = true;
        if (this.presenceTimer) clearInterval(this.presenceTimer);
        if (this.goodbyeTimer) clearInterval(this.goodbyeTimer);
        this.log('call closed:', reason);
        try { this.stt && this.stt.close(); } catch (_) {}
        try { this.ttsWs && this.ttsWs.close(); } catch (_) {}
        if (this.turnAbort) { try { this.turnAbort.abort(); } catch (_) {} }
        try {
            const mech = `${Math.round((Date.now() - this.startedAt) / 1000)}s call to ${this.s.phone} (${reason})`;
            let summary = mech;
            if (this.s.transcript.length >= 2) {
                try { summary = (await summarizeCall(this.s.transcript.join('\n'))) + '\n' + mech; }
                catch (e) { this.log('summarizer failed:', e.message); }
            }
            await supabase.from('agent_call_logs').insert({
                order_id: this.s.ctx.order_name || null,
                customer_name: this.s.ctx.customer_name || null,
                call_type: (this.s.callType || 'cod_confirm') + '_vobiz',
                language: this.s.lang,
                transcript: this.s.transcript.join('\n'),
                summary,
                exchanges: Math.ceil(this.s.transcript.length / 2),
                recording_url: this.s.recordingUrl || null,
            });
            // AUTO cod_confirm call → outcome drives the hold (2026-08-31 spec): customer confirmed on
            // the call = auto-unhold, documented; denied / unclear = NO action, just recorded so the
            // Call Queue can highlight it. Manual button calls are untouched — a human is already there.
            if (this.s.auto && (this.s.callType || '') === 'cod_confirm' && this.s.ctx.order_name) {
                // customerTurns, NOT transcript length: on the first live call (TE25-45877) the agent's
                // own two lines ("Hello… Can you hear me?") counted as exchanges, so a never-answered
                // call read as 'unclear' (no retry) instead of 'no_answer' (retry ladder).
                require('./vobiz_auto_calls').handleCodCallOutcome({
                    orderName: this.s.ctx.order_name, summary,
                    customerTurns: this.s.transcript.filter(l => /^customer:/i.test(l)).length,
                }).catch(e => this.log('outcome handling failed:', e.message));
            }
        } catch (e) { this.log('log save failed:', e.message); }
    }
}

// Session creation is separate from the Vobiz API call so the LOCAL SIMULATOR
// (tests/vobiz_call_sim.js) can exercise the whole bridge without a Vobiz account.
function createSession({ phone, ctx, lang, voice, callType, auto }) {
    const sid = crypto.randomBytes(8).toString('hex');
    sessions.set(sid, { sid, phone, ctx, lang: lang || 'en-IN', voice: voice || 'kavya', callType: PURPOSES[callType] ? callType : 'cod_confirm', auto: !!auto, transcript: [], createdAt: Date.now() });
    // Self-learning: the lessons the agent has learnt from earlier calls ride on the session and are
    // appended to every prompt of this call (agent_learning.js; cached 5 min, never blocks the call).
    require('./agent_learning').lessonsPromptBlock(PURPOSES[callType] ? callType : 'cod_confirm', lang || 'hi-IN')
        .then(b => { const s = sessions.get(sid); if (s) s.lessonsBlock = b; }).catch(() => {});
    return sid;
}

function openingLine(s) {
    if (!['hi-IN', 'en-IN'].includes(s.lang || 'hi-IN')) return null;   // unvetted-language greeting is worse than a slower correct one
    const sp = SPEAKERS[s.voice] || SPEAKERS.kavya;
    const verb = sp.gender === 'male' ? 'बोल रहा हूँ' : 'बोल रही हूँ';
    if ((s.lang || 'hi-IN') === 'en-IN')
        return `Hello ${s.ctx.firstName} ji, this is ${sp.name} from The Element. Do you have two minutes?`;
    return `नमस्ते ${s.ctx.firstName} जी! मैं ${sp.name} ${verb} The Element से। क्या आपके पास दो मिनट हैं?`;
}
async function synthOpening(s) {
    const r = await axios.post('https://api.sarvam.ai/text-to-speech', {
        inputs: [s.openingText], target_language_code: TTS_LANG(s.lang), speaker: s.voice,
        model: 'bulbul:v3', speech_sample_rate: 24000, enable_preprocessing: true, output_audio_codec: 'wav',
    }, { headers: { 'api-subscription-key': SARVAM_KEY(), 'Content-Type': 'application/json' }, timeout: 15000 });
    const b64 = r.data && r.data.audios && r.data.audios[0];
    if (!b64) throw new Error('opening synth: no audio');
    return Buffer.from(b64, 'base64').subarray(44).toString('base64');   // strip WAV header → raw L16 @24k
}
// DEFAULT LANGUAGE IS ENGLISH FOR EVERY CALL (user, 2026-08-31): the region no longer picks the
// opening language — screening bots and unknown callers get English, and the moment the customer
// speaks a few words in another language the agent OFFERS that language and switches on their yes
// (the offer/switch flow below). REGION_LANG is retained for reference only; langForOrder() now
// always answers en-IN. Explicit lang in the request still wins.
const REGION_LANG = [
    [/tamil nadu|puducherry|pondicherry/i, 'ta-IN'],
    [/karnataka/i, 'kn-IN'],
    [/kerala|lakshadweep/i, 'ml-IN'],
    [/andhra|telangana/i, 'te-IN'],
    [/west bengal|tripura/i, 'bn-IN'],
    [/maharashtra|goa/i, 'mr-IN'],
    [/gujarat|dadra|daman/i, 'gu-IN'],
    [/punjab|chandigarh/i, 'pa-IN'],
];
async function langForOrder(orderId) {
    return 'en-IN';                                     // English for all — see the note above
}
const LANG_REQUEST = [
    [/english|\u0905\u0902\u0917\u094d\u0930\u0947\u091c|\u0907\u0902\u0917\u094d\u0932\u093f\u0936/i, 'en-IN'],
    [/hindi|\u0939\u093f\u0928\u094d\u0926\u0940|\u0939\u093f\u0902\u0926\u0940/i, 'hi-IN'],
    [/tamil|\u0924\u092e\u093f\u0932/i, 'ta-IN'], [/telugu|\u0924\u0947\u0932\u0941\u0917\u0941/i, 'te-IN'],
    [/kannada|\u0915\u0928\u094d\u0928\u0921\u093c/i, 'kn-IN'], [/malayalam/i, 'ml-IN'],
    [/bengali|bangla|\u092c\u093e\u0902\u0917\u094d\u0932\u093e|\u092c\u0902\u0917\u093e\u0932|\u092c\u0902\u0917\u0932\u093e/i, 'bn-IN'], [/marathi|\u092e\u0930\u093e\u0920\u0940/i, 'mr-IN'],
    [/gujarati|\u0917\u0941\u091c\u0930\u093e\u0924\u0940/i, 'gu-IN'], [/punjabi|\u092a\u0902\u091c\u093e\u092c\u0940/i, 'pa-IN'],
];
const LANG_CUE = /(\u092e\u0947\u0902|mein|me|ch|vich)\s*(\u092c\u093e\u0924|\u092c\u094b\u0932|bol)|speak|talk|language|only|bolo|boliye|bhasha|\u092d\u093e\u0937\u093e|samajh|\u0938\u092e\u091d|\u0906\u0924|\u091c\u093e\u0928|\u0938\u093f\u0930\u094d\u092b|\u092a\u0924\u093e|बता|बोलो/i;   // आत=aata, जान=jaan, सिर्फ=sirf
function requestedLanguage(text, currentLang) {
    if (!LANG_CUE.test(text)) return null;
    for (const [rx, code] of LANG_REQUEST) if (rx.test(text) && code !== currentLang) return code;
    return null;
}

// "Hello? Can you hear me?" in each call language — spoken when the customer has made no sound
// after the opening. Simple standard phrasing on purpose.
const HELLO_CHECK = {
    'hi-IN': 'हेलो? क्या आपको मेरी आवाज़ आ रही है?',
    'en-IN': 'Hello? Can you hear me?',
    'bn-IN': 'হ্যালো? আপনি কি আমার কথা শুনতে পাচ্ছেন?',
    'ta-IN': 'ஹலோ? என் குரல் கேட்கிறதா?',
    'te-IN': 'హలో? నా మాట వినిపిస్తుందా?',
    'kn-IN': 'ಹಲೋ? ನನ್ನ ಧ್ವನಿ ಕೇಳಿಸುತ್ತಿದೆಯಾ?',
    'ml-IN': 'ഹലോ? എന്റെ ശബ്ദം കേൾക്കുന്നുണ്ടോ?',
    'mr-IN': 'हॅलो? माझा आवाज येतोय का?',
    'gu-IN': 'હેલો? મારો અવાજ સંભળાય છે?',
    'pa-IN': 'ਹੈਲੋ? ਕੀ ਤੁਹਾਨੂੰ ਮੇਰੀ ਆਵਾਜ਼ ਆ ਰਹੀ ਹੈ?',
};

const SCRIPT_LANG = [
    // Devanagari first (Hindi is the usual answer; an explicit ask can still pick Marathi) — needed
    // now that calls OPEN in English: a customer replying in Hindi must trigger the language offer.
    [/[\u0900-\u097F]/, 'hi-IN'],
    [/[\u0980-\u09FF]/, 'bn-IN'], [/[\u0A00-\u0A7F]/, 'pa-IN'], [/[\u0A80-\u0AFF]/, 'gu-IN'],
    [/[\u0B80-\u0BFF]/, 'ta-IN'], [/[\u0C00-\u0C7F]/, 'te-IN'], [/[\u0C80-\u0CFF]/, 'kn-IN'],
    [/[\u0D00-\u0D7F]/, 'ml-IN'],
];
function scriptLangOf(text) {
    for (const [rx, lang] of SCRIPT_LANG) {
        const hits = (String(text).match(new RegExp(rx.source, 'g')) || []).length;
        if (hits >= 3) return lang;                 // a few real letters, not stray noise
    }
    return null;
}
const AFFIRM_RX = /\u0939\u093e\u0901|\u091c\u0940|yes|ok|\u0a39\u0a3e\u0a02|\u09b9\u09cd\u09af\u09be\u0981|\u0b86\u0bae\u0bcd|\u0b86\u0bae\u093e|\u0c05\u0c35\u0c41\u0c28\u0c41|\u0cb9\u0ccc\u0ca6\u0cc1|\u0d05\u0d24\u0d46|\u0ab9\u0abe/i;

const LANG_NAMES = { 'hi-IN': 'Hindi', 'en-IN': 'English', 'ta-IN': 'Tamil', 'kn-IN': 'Kannada', 'ml-IN': 'Malayalam',
    'te-IN': 'Telugu', 'bn-IN': 'Bengali', 'mr-IN': 'Marathi', 'gu-IN': 'Gujarati', 'pa-IN': 'Punjabi' };

const TTS_LANG = (l) => (['hi-IN', 'ta-IN', 'kn-IN', 'ml-IN', 'te-IN', 'bn-IN', 'mr-IN', 'gu-IN', 'pa-IN', 'en-IN'].includes(l) ? l : 'hi-IN');
function armOpening(s) {
    s.openingText = openingLine(s);
    if (!s.openingText) return;                 // no vetted template for this language — live turn opens
    s.openingPcmP = synthOpening(s).catch(e => { console.log('[vobiz] opening pre-synth failed (will fall back to live turn):', e.message); return null; });
}

// ── place a call — ONE path for the dashboard button (/vobiz/call) and the high-value auto-caller
// (vobiz_auto_calls.js). Returns { success, sid } or { error, code, gated } — gated marks an
// allowlist refusal so the auto-caller can leave the order retryable instead of failed.
async function placeOrderCall(b) {
    if (!vobizConfigured()) return { error: 'Vobiz not configured — set VOBIZ_AUTH_ID / VOBIZ_AUTH_TOKEN / VOBIZ_FROM_NUMBER / VOBIZ_PUBLIC_BASE / VOBIZ_WEBHOOK_TOKEN in .env', code: 400 };
    let ctx = { customer_name: b.customer_name || '', product: b.product || '', amount: b.amount || '', order_name: b.order_name || '' };
    let orderRow = null, orderPhone = '';
    if (b.order_name) {
        try { const { order, fields } = await resolveOrderFields(b.order_name);
            orderRow = order;
            orderPhone = fields.phone || '';
            ctx = { customer_name: fields.customer_name, product: fields.product, amount: fields.amount, order_name: fields.order_name }; } catch (_) {}
    }
    const phone = String(b.phone || orderPhone || '').replace(/\D/g, '').slice(-10);
    if (!/^[6-9]\d{9}$/.test(phone)) return { error: b.order_name ? `no usable phone on ${b.order_name}` : 'valid 10-digit phone required', code: 400 };
    // Same test turnstile as WhatsApp: while the allowlist is set, only listed numbers ring.
    const gate = allowlistBlocks(b.order_name || '', phone);
    if (gate) return { error: gate, code: 403, gated: true, phone };
    ctx.firstName = String(ctx.customer_name || 'ji').trim().split(/\s+/)[0];
    if (b.order_name) ctx.productInfo = await productKnowledgeFor(String(b.order_name).replace(/^#/, '').trim());
    const lang = b.lang || (orderRow ? await langForOrder(orderRow.id) : 'en-IN');
    const sid = createSession({ phone, ctx, lang, voice: b.voice || 'kavya', callType: b.call_type, auto: !!b.auto });
    armOpening(sessions.get(sid));            // synthesize the greeting while the phone rings
    const answerUrl = `${V_BASE()}/api/vobiz/answer?token=${V_TOKEN()}&sid=${sid}`;
    const r = await axios.post(`https://api.vobiz.ai/api/v1/Account/${V_AUTH_ID()}/Call/`, {
        from: V_FROM(), to: '91' + phone,
        answer_url: answerUrl, answer_method: 'POST',
        hangup_url: `${V_BASE()}/api/vobiz/hangup?token=${V_TOKEN()}&sid=${sid}`,
    }, { headers: { 'X-Auth-ID': V_AUTH_ID(), 'X-Auth-Token': V_AUTH_TOKEN(), 'Content-Type': 'application/json' }, timeout: 20000, validateStatus: () => true });
    if (r.status >= 300) return { error: `Vobiz ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`, code: 502 };
    return { success: true, sid, phone, vobiz: r.data };
}

// ── HTTP: place a call ──
router.post('/vobiz/call', async (req, res) => {
    try {
        const r = await placeOrderCall(req.body || {});
        if (r.error) return res.status(r.code || 500).json({ success: false, error: r.error });
        res.json({ success: true, sid: r.sid, vobiz: r.vobiz });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── webhooks (public path — token-checked here) ──
// Vobiz posts call params form-encoded (From/To/CallUUID) — parse both shapes on this router only.
router.use(express.urlencoded({ extended: false }));
function xml(res, body) { res.set('Content-Type', 'application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<Response>${body}</Response>`); }
const recordXml = () => '';   // retired: the XML Record verb captured only the agent leg AND slowed stream setup
async function startCallRecording(callId, tag, session) {
    if (String(process.env.VOBIZ_RECORD || 'true') === 'false' || !callId) return;
    try {
        // time_limit defaults to 60s on the Record API (Plivo-style) — every recording was cut at
        // 00:59 (user, 2026-08-31: "i want all recording"). 3600s covers any real support call.
        const r = await axios.post(`https://api.vobiz.ai/api/v1/Account/${V_AUTH_ID()}/Call/${callId}/Record/`,
            { file_format: 'mp3', time_limit: 3600 },
            { headers: { 'X-Auth-ID': V_AUTH_ID(), 'X-Auth-Token': V_AUTH_TOKEN(), 'Content-Type': 'application/json' }, timeout: 10000, validateStatus: () => true });
        console.log(`[vobiz ${tag}] record API:`, r.status, JSON.stringify(r.data || {}).slice(0, 140));
        if (session && r.data) session.recordingUrl = r.data.recording_url || r.data.url || null;
    } catch (e) { console.log(`[vobiz ${tag}] record API failed:`, e.message); }
}

// The outcome, auto-captured: a short model pass over the transcript ("confirmed / wants cancel /
// reattempt Tuesday…") — the mechanical line stays as fallback so a summarizer outage never loses a log.
async function summarizeCall(transcriptText) {
    const r = await fetch('https://api.sarvam.ai/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'api-subscription-key': SARVAM_KEY() },
        body: JSON.stringify({ model: 'sarvam-105b-conversations', max_tokens: 120, temperature: 0.2, reasoning_effort: null,
            messages: [
                { role: 'system', content: 'You summarize customer support phone calls. Reply in English only, max 2 short lines: line 1 = OUTCOME (confirmed / wants cancel / will reattempt / no clear answer / other): then 5-10 words of detail. Line 2 = promise or follow-up needed, or "none".' },
                { role: 'user', content: transcriptText.slice(0, 4000) },
            ] }),
    });
    if (!r.ok) throw new Error('summarizer ' + r.status);
    const d = await r.json();
    return sanitizeReply(d.choices?.[0]?.message?.content || '').slice(0, 400);
}
router.all('/vobiz/answer', async (req, res) => {
    const q = req.query || {};
    console.log('[vobiz] answer webhook hit — sid:', q.sid || '(none)', 'From:', (req.body && req.body.From) || q.From || '?', 'token ok:', q.token === V_TOKEN());
    if (q.sid && sessions.has(q.sid)) sessions.get(q.sid).tAnswer = Date.now();
    if (q.token !== V_TOKEN()) return xml(res, '<Hangup/>');
    // INCOMING call (no pre-created sid): the customer dialled OUR number. The session is built
    // from the CALLER: allowlist-gated while testing, order context pinned by
    // VOBIZ_INBOUND_TEST_ORDER (the real-order test) — later this becomes a latest-order lookup
    // by caller phone. Anyone not allowlisted gets a plain hangup, never the agent.
    if (!q.sid || !sessions.has(q.sid)) {
        const from = String((req.body && req.body.From) || q.From || '').replace(/\D/g, '').slice(-10);
        const pinnedOrder = String(process.env.VOBIZ_INBOUND_TEST_ORDER || '').trim();
        if (!from || allowlistBlocks(pinnedOrder, from)) {
            console.log('[vobiz] inbound call refused (caller ' + (from || 'unknown') + ' not allowlisted)');
            return xml(res, '<Hangup/>');
        }
        let ctx = { customer_name: '', product: '', amount: '', order_name: pinnedOrder };
        if (pinnedOrder) {
            try { const { fields } = await resolveOrderFields(pinnedOrder);
                ctx = { customer_name: fields.customer_name, product: fields.product, amount: fields.amount, order_name: fields.order_name }; }
            catch (e) { console.log('[vobiz] inbound order lookup failed:', e.message); }
        }
        ctx.firstName = String(ctx.customer_name || 'ji').trim().split(/\s+/)[0];
        const sid = createSession({ phone: from, ctx, lang: process.env.VOBIZ_INBOUND_LANG || 'en-IN', voice: process.env.VOBIZ_INBOUND_VOICE || 'kavya' });
        armOpening(sessions.get(sid));
        console.log(`[vobiz ${sid.slice(0, 6)}] INBOUND call from ${from} — order ${ctx.order_name || '(none)'}`);
        const wssIn = `${V_BASE().replace(/^https/, 'wss')}/api/vobiz/media?token=${V_TOKEN()}&amp;sid=${sid}`;
        return xml(res, `${recordXml()}<Stream bidirectional="true" audioTrack="inbound" contentType="audio/x-l16;rate=16000" keepCallAlive="true">${wssIn}</Stream>`);
    }
    const wssUrl = `${V_BASE().replace(/^https/, 'wss')}/api/vobiz/media?token=${V_TOKEN()}&amp;sid=${q.sid}`;
    xml(res, `${recordXml()}<Stream bidirectional="true" audioTrack="inbound" contentType="audio/x-l16;rate=16000" keepCallAlive="true">${wssUrl}</Stream>`);
});
router.all('/vobiz/hangup', (req, res) => {
    const s = sessions.get((req.query || {}).sid);
    if (s && s.call) s.call.close('hangup webhook');
    res.json({ ok: true });
});

// The dashboard plays recordings THROUGH us: media.vobiz.ai needs the account auth headers,
// which must never reach the browser. Only vobiz.ai hosts are proxied.
router.get('/vobiz/recording', async (req, res) => {
    try {
        const u = String(req.query.u || '');
        let parsed;
        try { parsed = new URL(u); } catch { return res.status(400).json({ success: false, error: 'bad url' }); }
        if (!/\.vobiz\.ai$/.test(parsed.hostname)) return res.status(400).json({ success: false, error: 'not a vobiz media url' });
        const r = await axios.get(u, { headers: { 'X-Auth-ID': V_AUTH_ID(), 'X-Auth-Token': V_AUTH_TOKEN() },
            responseType: 'stream', timeout: 30000, validateStatus: () => true });
        if (r.status >= 300) return res.status(502).json({ success: false, error: 'vobiz media ' + r.status });
        res.set('Content-Type', r.headers['content-type'] || 'audio/mpeg');
        if (r.headers['content-length']) res.set('Content-Length', r.headers['content-length']);
        r.data.pipe(res);
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── the media WebSocket ──
function attachVobizWs(httpServer) {
    const wss = new WebSocketServer({ noServer: true });
    httpServer.on('upgrade', (req, socket, head) => {
        let u;
        try { u = new URL(req.url, 'http://x'); } catch { socket.destroy(); return; }
        console.log('[vobiz] ws upgrade attempt:', u.pathname);
        if (u.pathname !== '/api/vobiz/media') return;                 // other upgrades are not ours
        const token = u.searchParams.get('token'), sid = u.searchParams.get('sid');
        if (token !== V_TOKEN() || !sessions.has(sid)) { socket.destroy(); return; }
        wss.handleUpgrade(req, socket, head, (ws) => {
            const s = sessions.get(sid);
            const call = new VoiceCall(ws, s);
            s.call = call;
            console.log(`[vobiz ${sid.slice(0, 6)}] media stream connected for ${s.phone}` + (s.tAnswer ? ` (+${Date.now() - s.tAnswer}ms after answer webhook)` : ''));
            let seen = 0, opened = false;
            ws.on('message', (m) => {
                let d; try { d = JSON.parse(m.toString()); } catch { call.log('non-JSON frame', m.length, 'bytes'); return; }
                // The docs say {type:"start"} / {type:"media", media:"…"} — log the first frames so a
                // different real-world shape (event-keyed, nested payload) is visible, not guessed at.
                if (seen < 4 && d.type !== 'media' && d.event !== 'media') { call.log('frame[' + seen + ']:', JSON.stringify(d).slice(0, 220)); }
                if (!call.streamId) { const sid2 = d.streamId || (d.start && d.start.streamId); if (sid2) { call.streamId = sid2; call.log('streamId captured'); } }
                if (!call.callId) { const cid = d.callId || (d.start && d.start.callId); if (cid) { call.callId = cid; startCallRecording(cid, sid.slice(0, 6), s); } }
                if (d.type === 'media' || d.event === 'media') {
                    if (seen < 4) call.log('frame[' + seen + '] media keys:', Object.keys(d).join(','), typeof d.media === 'object' ? 'media keys: ' + Object.keys(d.media || {}).join(',') : 'media: string(' + String(d.media || '').length + ')');
                    const payload = typeof d.media === 'string' ? d.media
                        : (d.media && (d.media.payload || d.media.audio)) || d.payload || d.audio || null;
                    if (payload) call.feedCaller(payload);
                    // Some providers never send an explicit start — the first media frame IS the start.
                    if (!opened) { opened = true; call.playOpening().catch(e => call.log('opening failed:', e.message)); }
                } else if (d.type === 'start' || d.event === 'start' || d.event === 'connected') {
                    if (!opened) { opened = true; call.playOpening().catch(e => call.log('opening failed:', e.message)); }
                }
                seen++;
            });
            ws.on('close', () => call.close('stream closed'));
            ws.on('error', (e) => call.log('vobiz ws error:', e.message));
        });
    });
}

module.exports = { router, attachVobizWs, createSession, sessions, placeOrderCall, vobizConfigured };
