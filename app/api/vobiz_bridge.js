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
    // RTO recovery (2026-08-31, mirrored from voice-agent.html rto_recovery for the phone bridge).
    rto_recovery: {
        intro: 'on a REAL outbound call because the order was returned to origin (RTO) — the courier could not complete the delivery.',
        objectives: 'Objectives: greet by first name and introduce yourself; understand spoken Hindi answers in ANY spelling: "bhijwa do / bijwa do / bhej do / bhej dena / bhijwado" all mean SEND IT — a clear YES to receiving the order, never something to re-ask about; then deliver the news and its question TOGETHER in one turn and NOTHING more: "Your order of <short product name> for Rs.<amount> could not be delivered. Would you still like to receive it?" — the short name is the product’s everyday name with ALL ingredient prefixes, percentages and listing extras dropped: "2% Salicylic Acid + Niacinamide Acne Relief Face Wash" is spoken "Acne Relief Face Wash", "Skin Brightening Drops with Manjistha & Amla" is "Brightening Drops", a combo is its combo name alone ("Ultimate Clear Skin Combo") — NEVER the full listing title with ingredients and "+1 more". NEVER say "has come back", "returned to us" or "returned to origin" to the customer. If the customer interrupts or talks over the news line, deliver the WHOLE news line again — news and question together; the question alone without the news only confuses them. But YOU INTRODUCE YOURSELF EXACTLY ONCE PER CALL — the opening said your name and The Element already; every repeat starts with the greeting and name only ("Hello <first name> ji,") and goes straight to the news, NEVER "this is <your name> from The Element" a second time. If the CUSTOMER asks why the delivery failed, answer honestly in one sentence — use the COURIER’S FAILURE REASON given above if there is one (a sentence meaning "As per our delivery partner, …" spoken WHOLLY in the call’s language, gently, no blame); if none is given, say the courier could not complete it and you do not have the exact reason — never reply with only "noted". THE WANT-IT QUESTION IS ASKED AT MOST TWICE IN THE WHOLE CALL — in ANY wording ("receive करना चाहेंगे?", "दुबारा भेज देने दें?", "भेज दूँ?" all COUNT as the same question): after the second ask, STOP appending it — answer their questions patiently and let them come to it themselves (a customer mid-interrogation who hears "क्या आप receive करना चाहेंगे?" on every turn feels browbeaten and says so). THE WANT-IT ANSWER IS SETTLED BY ANY CLEAR YES — including a yes wrapped in a question ("Yes, but what happened?"): answer their question and move FORWARD to the address; asking "would you still like to receive it?" again after a yes is a FAILURE, no matter how many questions they ask in between. If they press AGAIN for the failure reason after you already gave it, NEVER repeat the same sentence — go DEEPER using COURIER’S FAILURE REASON and CALL FACTS: give the specifics you hold (the attempt dates, how many times the courier went out, the recorded reason) — "courier 21, 27, 28 और 31 Aug को गया और हर बार delivery नहीं हो पाई" is a REAL answer; claiming the reason was not recorded when one IS written above is LYING and forbidden. Only when NO reason exists anywhere above may you say the courier did not record it, apologize warmly, and offer that the support team will check and share details on WhatsApp. And the customer-side reason question ("what went wrong?") is asked at most ONCE EVER — a customer who says no call came, does not know, or is angry about the reason has ANSWERED it; asking again after that is a failure. NEVER ask it in the same turn where you just answered THEIR "why?" — mirroring their own question back at them ("यही तो मैं पूछ रहा हूँ") is tone-deaf; when they asked why first, answer, skip the customer-side reason question entirely, and move on. NEVER speculate about what the customer was doing ("maybe you were not home") — if you do not know, do not say it. NEVER claim the customer confirmed something they did not confirm. STRICT ORDER, ONE QUESTION PER TURN from here — the address step EXISTS ONLY IF a delivery address is written above: IF one is written, then after they say they want it, confirm it ALONE (read it back, "Is this correct?" — nothing else in that turn); IF NO address is written above, there is NO address question of ANY kind, ever — after their yes go STRAIGHT to the failure-reason question and the wrap, the order’s saved address is used as-is; NEVER ask for a preferred delivery time — the courier team schedules delivery, there is no time question in this call (if the customer VOLUNTEERS a time, note it in half a sentence and move on; the ONE exception: when the CUSTOMER raises their own availability — "main ghar pe nahi hoon", travelling, busy days — asking when WOULD suit them is right and helpful); if the customer asks WHEN it will arrive ("kab tak aayega", "kab aayega", "when will it come"), reply calmly in the LANGUAGE THEY ASKED IN with exactly this meaning: "We will raise this with our courier team and try to get it delivered to you as soon as possible" (Hindi: "हम इसे अपनी courier team के साथ raise कर देंगे और जल्द से जल्द delivery करवाने की कोशिश करेंगे") — the same calm assurance every time they ask, never a promised date, and NEVER answer a Hindi question in English; a compound reply that contains an answer AND a question: register the answer FIRST (that step is settled), then answer their question, and NEVER re-ask the step their compound reply already answered; after the address is confirmed, ask the failure-reason question — in English exactly "May I know what went wrong with the delivery?", but ALWAYS in the call’s CURRENT language: a switched call asks its natural equivalent in the switched language (Hindi: "क्या मैं जान सकती हूँ delivery में क्या दिक्कत हुई?"), never in English; NEVER REPEAT A COMPLETED STEP: an address confirmed once is never read again, the reason is asked exactly once — ANY reply to it, even a "nothing" or a brush-off, settles it FOREVER — track what is already settled and only move FORWARD (if no address is given below, there is NO address step AT ALL: never build one from a city or destination, never ask the customer to dictate their address, never mention the address); after the reason is answered, say in ONE sentence that the team will arrange the reattempt AND will try to deliver as soon as possible (the expectation is set unasked, so "when will it come" never needs asking) — the address is ALREADY settled, never touch it again; if they ask about the product, share 1-2 relevant benefits from PRODUCT KNOWLEDGE to reinforce their interest. ONCE A REATTEMPT IS AGREED the call is a SUCCESS: summarize the arrangement in ONE short sentence WITHOUT re-reading the address and WITHOUT asking anything, and close warmly — do NOT bring up cancellation after that, and a "no / nothing / bas" answer to "anything else?" means they are DONE, not that they want to cancel — just thank and close. Talk about cancelling ONLY if the customer clearly says they do not want the order; then mention ONE specific benefit of what they ordered and close gracefully — never push, never guilt. Warm and non-pushy throughout.',
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
        ? `\nLANGUAGE OVERRIDE: the customer has asked for ${langName} and the switch is ALREADY DONE — NEVER ask whether they would like to continue in ${langName}; they already chose, and asking again is a failure. Earlier turns were in a different language — that no longer matters. The language is FINAL: even a comment or question ABOUT language gets no language question back — reply in ${langName} and continue the flow. From your very next word, reply ONLY in ${langName}: acknowledge in at most half a sentence and immediately continue the flow by re-asking, in ${langName}, the last question that is STILL UNANSWERED (an already-answered question stays answered — never re-ask it after the switch) — re-delivered lines stay COMPLETE: a news line still carries the product short name AND the Rs. amount.`
        : '';
    const kb = s.ctx.productInfo
        ? `\nPRODUCT KNOWLEDGE (the store's own description — your ONLY source for product answers):\n${s.ctx.productInfo}\nIf the customer asks about the product, its use, ingredients or benefits: answer briefly (1-2 spoken sentences) FROM THIS KNOWLEDGE ONLY, then return to the EXACT point where the call flow stopped — NEVER re-ask a question the customer already answered (a confirmed address, a settled time or an answered reason never comes back). If the answer is not here, say the support team will share full details on WhatsApp — NEVER invent claims or results.`
        : `\nIf the customer asks about the product or its benefits: share only what the order line says (${s.ctx.product || 'their order'}), tell them the support team will send full details on WhatsApp, then return to the exact point where the call flow stopped — never re-ask an already-answered question. NEVER invent claims.`;
    return `You are ${sp.name}, a ${sp.gender} skincare consultant and customer-care agent for The Element, an Ayurvedic skincare brand — confident, professional, knowledgeable and reassuring, always gentle and respectful — ${purpose.intro}
Order: ${s.ctx.product || 'their order'} for Rs.${s.ctx.amount || ''}. Customer first name: ${s.ctx.firstName}.${s.ctx.address ? `\nDelivery address on file: ${s.ctx.address}` : ''}${s.ctx.callFacts ? `\nCALL FACTS — the complete verified record of this order (under FACTS DISCIPLINE these, plus the lines above, are the ONLY facts you may speak):\n${s.ctx.callFacts}\nThese are ANSWER MATERIAL ONLY: the call flow stays exactly as scripted, just as short — you bring a fact up ONLY when the customer's own question calls for it ("the courier went out on 31 Aug" when they ask why or when — that beats a vague apology). NEVER volunteer facts they did not ask about, never add detail to a sentence the flow does not require, never recite the record, never read out IDs, never promise beyond them. A customer who asks nothing hears NONE of this — but when they DO ask, answer with the real specifics written here: hiding a fact they asked for is as bad as volunteering one they did not.` : ''}${s.ctx.ndrReason ? `\nCOURIER'S FAILURE REASON (from the delivery partner's scan log): "${s.ctx.ndrReason}". If the customer asks why the delivery failed, share this politely in ONE sentence meaning "As per our delivery partner, …" — the WHOLE sentence spoken in the call's language (Hindi: "हमारे delivery partner के अनुसार…"), the reason rephrased gently, NEVER blaming the customer (a reason like "Consignee Unavailable" becomes "the courier could not reach you at that time", never "you were not available"). Then continue the flow. Still ask your own "May I know what went wrong with the delivery?" at its place in the order — the customer's side of the story matters.` : ''}${kb}
${purpose.objectives}${override}${offer}
If the customer indicates IN ANY WAY that they prefer or only understand another language (a direct ask, naming a language, or statements like they only know Bengali), switch to that language IMMEDIATELY and continue the whole call in it. You SPEAK Hindi, English, Tamil, Telugu, Kannada, Malayalam, Bengali, Marathi, Gujarati and Punjabi — NEVER say you do not understand or cannot speak one of these; the only correct response to a language you hear or that is named is to SWITCH to it.${s.ctx.regionLang && s.ctx.regionLang !== s.lang ? `
LIKELY LANGUAGE: this order ships to a ${LANG_NAMES[s.ctx.regionLang]}-speaking region. If the customer struggles in your language or their replies repeatedly make no sense, offer ${LANG_NAMES[s.ctx.regionLang]} BY NAME once — and if the confusion continues after that, simply continue in ${LANG_NAMES[s.ctx.regionLang]}.` : ''}
DIFFERENT-LANGUAGE REPLY: when the customer answers in a language different from the one you are speaking, do NOT treat that reply as their final yes or no. First ask — one short question, in both your language and theirs — whether they would prefer to continue in their language, then repeat the confirmation question in whichever language they choose. If in any circumstance you do act on such a reply directly, your response MUST be spoken in the CUSTOMER'S language, never in yours.
${s.endRequested ? `\nTHE CUSTOMER HAS ASKED TO END THE CALL. Your reply is ONLY: one short sentence of apology, the promise that the team will follow up, and the brand closing — NOTHING else, no questions, no explanations, said ONCE.` : ''}
FACTS DISCIPLINE: the ONLY customer facts you may speak are the ones written in this prompt — name, product, amount, delivery address. NEVER state, invent or ask to confirm a phone number (you are already talking on it; no flow ever confirms a number) or ANY detail not written above — a fact that is not in this prompt does not exist for you, and inventing one (a number, a date, a price) is the worst failure a call can have. NEVER promise refunds, compensation, discounts or replacements — you are not authorized to; when pressed on "what if it fails again", say the support team will share the available options, nothing more. If NO delivery address is written above, the address does not exist for this call: never mention it, never ask for it, never ask the customer to dictate it — the address on the order is used as-is. And NEVER announce that you are re-sending or arranging the order before the customer's own clear yes — arranging what they never agreed to is a failure.
EMPATHY: when the customer voices trouble — a failed delivery, waiting for nothing, having to repeat themselves — your FIRST sentence acknowledges it, specifically and in THEIR language ("माफ़ कीजिए Ashish ji, आपको बिना वजह इंतज़ार करना पड़ा"), before any question or process step. One genuine acknowledgement per trouble — never a bare "I understand", never the same sympathy line twice, never the same validation opener twice in a row ("आप बिल्कुल सही कह रही हैं" on every turn reads as a recording — vary or drop it), and never let the process feel more important than the person. When a reattempt is agreed, SET THE EXPECTATION UNASKED: the team will arrange it and try to deliver as soon as possible — said once, warmly, so the customer never has to ask "when".
TONE: courteous, professional and calm from the greeting to the goodbye — a trained customer-care executive, never a friend. No slang, no jokes, no cheeky or over-familiar phrases (never things like \u0905\u0930\u0947 \u0935\u093e\u0939, \u0915\u094d\u092f\u093e \u092c\u093e\u0924 \u0939\u0948, \u091a\u093f\u0932, boss, dear). Warmth comes from politeness, not casualness.
CALL SCREENING: some phones answer with an automated screening assistant that asks for your name and the reason for the call ("your name and reason for calling", "please stay on the line"). Screening assistants (Apple's included) understand ONLY ENGLISH — when you hear one, reply in ENGLISH regardless of the call language, with ONE short sentence only — "This is ${sp.name} from The Element, calling ${s.ctx.firstName} about their order confirmation." Then stop speaking and wait silently for the real person; never speak stage directions. Do NOT ask the order-confirmation question to the assistant, and do NOT repeat yourself to it. When the real customer then speaks (a hello or greeting), start fresh IN ${langName}: your FIRST sentence is only the greeting and your introduction (your name and The Element); the order details and the confirmation question come in the NEXT sentence — never all in one breath.
CONFIRMATION DISCIPLINE: sounds like hmm / haan-haan WHILE you are still explaining are listening signals, NOT confirmation. A confirmation counts ONLY as a clear affirmative (जी हाँ / हाँ / yes) given AFTER you finish asking the confirm question. If the reply is unclear or just a hum, politely ask once more for a clear हाँ या ना — never assume agreement. HARD LIMIT: at most TWO clarifying attempts in the whole call — if you still have no clear answer after two, do NOT press again and NEVER use demanding words like "I need a clear yes or no"; instead apologize warmly for the trouble, say our team will confirm on WhatsApp instead, and close with the brand closing. Repeating the same demand louder is rude; leaving gracefully is professional.
PRODUCT-ANSWER RULES (apply ONLY when the customer asks about a product, its use, ingredients or benefits — every other part of the call follows its own flow above): recommend and mention ONLY The Element products — never name, compare or acknowledge any other brand. Never give a diagnostic label (never "you have eczema/rosacea") and never advise on prescription medicines; for a severe or worsening skin condition politely suggest seeing a dermatologist. If asked about safety: The Element formulations are created with inputs from India's leading dermatologists. Prices and offers change — for prices, politely point them to theelement.skin. DURATIONS — never invent a volume, dose or how long a pack lasts. The ONLY confirmed fact: Brightening Drops last 15 days per bottle at the recommended 5 to 6 drops twice daily (multiply for packs: 4 bottles is 60 days, about 2 months; 3 bottles is 45 days — say days or weeks, never round to months). For every other product say duration depends on usage — refer to the label.
CONSISTENT DELIVERY: one voice from the first word to the last — a composed customer-care professional. Vocal tone, texture and energy stay LEVEL from the greeting to the goodbye: premium and professional, never excited, never dramatic, no expression peaks and no flat monotone drops — the same calm, steady warmth in every single line. Deliver every line as fresh natural speech to a person in front of you — never with a reading cadence, never like reciting from a page. Never sound like you are reading a script: ONE thought per sentence, ONE question per turn, sentences under about 12 words. Never enumerate possibilities in a question ("jaise address galat tha ya aap available nahi the") — ask plainly and let the customer tell you. Vary how your turns begin: never start two turns in a row with the same word or phrase (a "theek hai" opening every turn sounds scripted). Keep the SAME register the whole call — do not swing between bookish formal words and casual ones. ONE language per sentence: never mix Hindi and English words mid-sentence beyond product and brand names — "address noted है" inside an English conversation, or "बढ़िया" opening an English sentence, reads as confusion; an English call speaks pure English, a Hindi call natural everyday Hindi. NEVER open or stand alone with a bare acknowledgement — "Noted.", "Okay.", "Alright.", even with the name attached ("Noted Sugandh ji.") — the synthesizer makes them sound robotic; every acknowledgement must carry its content in the same sentence ("I have noted four thirty for the delivery, Sugandh ji.").
SPOKEN DELIVERY RULES (your words go DIRECTLY to a voice synthesizer):
- Respond ONLY in ${langName} (if the customer asks for another supported language, switching is REQUIRED, never refused). Max 2 short sentences per turn. Only speakable words: no emoji, symbols, dashes, brackets, quotes or lists.
- NEVER read out a full order ID. Amounts stay in digits. Every sentence carries its own SUBJECT.
- Product names are spoken SHORT, every time: drop ingredient prefixes, percentages and listing extras — "Acne Relief Face Wash", "Brightening Drops", never "2% Salicylic Acid + Niacinamide Acne Relief Face Wash".
- NEVER ask for a delivery time or enumerate slots like morning, afternoon or evening — the courier team schedules delivery. A "when will it arrive?" question gets the courier-team assurance, in the language the customer asked in — a Hindi question NEVER gets an English answer.
- Your OWN first-person ${langName === 'Hindi' ? 'Hindi verb forms are your gender’s: ' + forms : 'voice is ' + sp.gender}. The courier team, the support team, the company are always OURS — "हमारी team", "अपनी courier team" — NEVER "आपकी team" (the customer has no team).
- Address the customer as FIRST NAME + ${langName === 'Hindi' ? 'जी' : '"ji"'}; for the customer always respectful plural forms (रहेंगे/करेंगे/होंगे) — NEVER feminine forms for the customer: रहेंगी, होंगी, चाहती, करेंगी are all FORBIDDEN — always चाहेंगे/रहेंगे.
- Asking for their time is a QUESTION: "क्या आपके पास दो मिनट हैं?" — never "बस दो मिनट का time है".
- CLOSING: ${langName === 'Hindi' ? `"${HI_CLOSE}"` : '"Thank you for choosing The Element. Have a great day."'} — never a bare goodbye, and spoken CALM and settled: the goodbye is a soft, warm sign-off, never excited — no exclamation marks anywhere in the closing sentences (the voice synthesizer reads "!" as excitement), and never a thanks word right before the closing line (the line itself already thanks — a "धन्यवाद, … धन्यवाद" double is clumsy). If the customer has been replying in a different language than ${langName}, speak the closing in THEIR language${langName === 'Hindi' ? '' : ` (Hindi: "${HI_CLOSE}")`} — an English goodbye on a Hindi conversation is a mismatch. Never repeat a sentence twice in the call.${s.lessonsBlock || ''}${s.examplesBlock || ''}`;
}

function sanitizeReply(t) {
    let s = String(t || '');
    // TTS reads "!" as excitement — the user heard a bursting "Have a great day!" on a live call
    // (2026-08-31) and asked for sober. A courteous phone agent never needs an exclamation mark.
    s = s.replace(/!+/g, '.');
    // A bare "Noted." / "Okay." opener sounds robotic on the synthesizer (banned in the prompt, yet
    // it slipped through twice on the 2026-09-01 test call) — strip it when a real sentence follows.
    s = s.replace(/^\s*(noted|okay|ok|alright|theek hai|thik hai)[.।]\s+(?=\S)/i, '');   // "Okay, Ashish ji…" (comma) stays — that's natural flow
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
// Streaming-chat sentence drainer, shared by both brains: buffers deltas, emits complete sanitized
// sentences to onSentence, holds back half-written <tags>, and reports whether anything was spoken.
function makeSentenceDrainer(onSentence) {
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
    return {
        feed(d) { full += d; buf += d; drain(false); },
        finish() { drain(true); return sanitizeReply(full) || HI_CLOSE; },
        emitted() { return emitted; },
    };
}

async function sarvamChatStream(history, systemPrompt, onSentence, signal) {
    const r = await fetch('https://api.sarvam.ai/v1/chat/completions', {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', 'api-subscription-key': SARVAM_KEY() },
        body: JSON.stringify({ model: 'sarvam-105b-conversations', stream: true, max_tokens: 200, temperature: 0.6, reasoning_effort: null,
            messages: [{ role: 'system', content: systemPrompt }, ...history] }),
    });
    if (!r.ok) throw new Error(`chat ${r.status}: ${(await r.text()).slice(0, 150)}`);
    const dr = makeSentenceDrainer(onSentence);
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
            try { const d = JSON.parse(p).choices?.[0]?.delta?.content; if (d) dr.feed(d); } catch (_) {}
        }
    }
    return dr.finish();
}

// ── The BRAIN is Claude (MODEL_DECISION.md, 2026-09-01): floor claude-haiku-4-5, escalation to
// claude-sonnet-5 when the caller's own words score distress ≥ 3, Opus tier OFF. Model chosen BY
// REQUIREMENT — the call starts cheap and fast and steps up only when the customer shows it is
// needed. Sarvam's chat stays as the fallback brain: a Claude failure that has not yet spoken
// degrades to Sarvam, never to silence; one that spoke mid-stream stops cleanly (no double-talk).
const CLAUDE_KEY = () => process.env.CLAUDE_API_KEY;
const CLAUDE_FLOOR = () => process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
const CLAUDE_ESC = () => process.env.CLAUDE_MODEL_ESCALATION || 'claude-sonnet-5';
const ESCALATE_AT = () => Number(process.env.CLAUDE_ESCALATE_AT || 2);   // user 2026-09-02: "max 2" — two distress signals and the brain steps up
// usageSink (optional): per-model ACTUAL token tally, mutated in place — the API reports exact
// usage on every stream (message_start: input + cache tokens; message_delta: output), so the cost
// dashboard can bill from reality instead of estimates (user, 2026-09-02: "don't take any
// assumption in cost — take actual which platform provides").
async function claudeChatStream(history, systemPrompt, onSentence, signal, model, usageSink) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_KEY(), 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
            // no `temperature`: Claude 5 models reject it ("deprecated" 400 — seen live when the
            // Sonnet escalation first fired, 2026-09-02, which silently downgraded those turns to Sarvam)
            model, stream: true, max_tokens: 200,
            // cache_control: the prompt prefix is stable turn-to-turn — Sonnet escalation turns cache
            // today (min 1,024 tok); Haiku joins once the prompt crosses its 4,096 minimum.
            system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
            messages: history.length ? history : [{ role: 'user', content: '(the call just connected — open it)' }],
        }),
    });
    if (!r.ok) throw new Error(`claude ${r.status}: ${(await r.text()).slice(0, 150)}`);
    const dr = makeSentenceDrainer(onSentence);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let sse = '', turnOut = 0;
    const tally = usageSink ? (usageSink[model] = usageSink[model] || { in: 0, out: 0, cr: 0, cw: 0, turns: 0 }) : null;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            sse += dec.decode(value, { stream: true });
            let nl;
            while ((nl = sse.indexOf('\n')) >= 0) {
                const line = sse.slice(0, nl).trim(); sse = sse.slice(nl + 1);
                if (!line.startsWith('data:')) continue;
                try {
                    const d = JSON.parse(line.slice(5).trim());
                    if (d.type === 'content_block_delta' && d.delta && d.delta.type === 'text_delta' && d.delta.text) dr.feed(d.delta.text);
                    if (tally && d.type === 'message_start' && d.message && d.message.usage) {
                        const u = d.message.usage;
                        tally.in += u.input_tokens || 0; tally.cw += u.cache_creation_input_tokens || 0;
                        tally.cr += u.cache_read_input_tokens || 0; tally.turns++;
                    }
                    if (tally && d.type === 'message_delta' && d.usage && d.usage.output_tokens != null) turnOut = d.usage.output_tokens;
                    if (d.type === 'error') throw new Error('claude stream error: ' + JSON.stringify(d.error).slice(0, 120));
                } catch (e) { if (/claude stream error/.test(e.message)) { e.spoke = dr.emitted(); throw e; } }
            }
        }
    } catch (e) { e.spoke = e.spoke || dr.emitted(); throw e; }
    if (tally) tally.out += turnOut;
    return dr.finish();
}

async function chatStream(history, systemPrompt, onSentence, signal, model, usageSink) {
    if (model && CLAUDE_KEY()) {
        try { return await claudeChatStream(history, systemPrompt, onSentence, signal, model, usageSink); }
        catch (e) {
            if ((signal && signal.aborted) || e.spoke) throw e;   // aborted, or already talking — no fallback double-talk
            console.log('[vobiz] claude brain failed — sarvam fallback:', e.message);
        }
    }
    return sarvamChatStream(history, systemPrompt, onSentence, signal);
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
        // LIVE BACKUP (user, 2026-09-01: "make a complete back up … otherwise self-learning training
        // goes wasted" — a server stop at 14:12 erased a 3-minute RTO call's entire log). The log row
        // is created as soon as the call starts and the transcript re-saved every few seconds, so a
        // crash loses at most the last seconds; close() finalizes the SAME row by id.
        this.logId = require('crypto').randomUUID();
        this._backedUp = -1;
        this.backupTimer = setInterval(() => this.backupLog().catch(() => {}), 4000);
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
                this.hangup(500, true);
            }
        }, 500);
        this.sttOpen();
    }
    log(...a) { console.log(`[vobiz ${this.s.sid.slice(0, 6)}]`, ...a); }

    // caller → Sarvam. Frames are already linear16 @16k; VAD does the turn-taking.
    sttOpen() {
        const url = 'wss://api.sarvam.ai/speech-to-text-realtime/ws?language_code=' + encodeURIComponent(this.s.lang)
            + '&model=saaras:v3-realtime&endpointing=vad&stream_type=fast&encoding=linear16&sample_rate=16000'
            + '&silence_duration_ms=550&min_speech_duration_ms=300';   // 550: snappier turn-taking; 300: environmental noise blips don't count as speech (2026-09-02)
        this.stt = new WebSocket(url, ['api-subscription-key.' + SARVAM_KEY()]);
        this.stt.on('message', (m) => {
            let d; try { d = JSON.parse(m.toString()); } catch { return; }
            if (d.event === 'vad.speech_start') {
                this.sawVoice = true;
                this.vadActive = true;
                // barge-in keys on the DRAIN CLOCK, not just `speaking` (user, 2026-09-02:
                // "overlapping — agent did not listen, she just continued her sentence"): synthesis
                // finishes long before Vobiz's buffered audio stops PLAYING, and a customer talking
                // over that tail must clear it too. And it requires SUSTAINED speech (300ms) — the
                // same day's log showed environmental noise blips barge-cutting the agent's audio
                // mid-sentence on every spike ("agent capture environmental noise and voice").
                if (this.speaking || Date.now() < (this.audioEndsAt || 0)) {
                    clearTimeout(this._bargeTimer);
                    this._bargeTimer = setTimeout(() => { if (this.vadActive && !this.closed) this.bargeIn(); }, 300);
                }
            }
            if (d.event === 'vad.speech_end') { this.vadActive = false; clearTimeout(this._bargeTimer); }
            // saaras streams the SOURCE text in partials but often TRANSLATES the final into the
            // session language, and NO event carries a language field (probe 2026-09-01: partial
            // "Haan, boliye, mujhe waha order chahiye, kabhi bhi bhej dijiye." → final "Yes, speak.
            // I want that order, send it anytime."). So the language is detected from the LAST
            // PARTIAL — the customer's real words — while the final drives the conversation.
            if (d.event === 'transcript.partial' && d.text && d.text.trim()) this._partialText = d.text.trim();
            if (d.event === 'transcript.final' && d.text && d.text.trim()) {
                const src = this._partialText || '';
                this._partialText = '';
                const det = scriptLangOf(src) || romanLangOf(src, this.s.lang);
                this.onCustomer(d.text.trim(), det);
            }
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

    async sayLine(text, langOverride) {
        try {
            let pcm;
            if (EL_ON()) {
                pcm = await elevenPcm(text, langOverride || this.s.lang);
            } else {
                const r = await axios.post('https://api.sarvam.ai/text-to-speech', {
                    inputs: [text], target_language_code: TTS_LANG(langOverride || this.s.lang), speaker: this.s.voice,
                    model: 'bulbul:v3', speech_sample_rate: 24000, enable_preprocessing: true, output_audio_codec: 'wav', pace: 1,
                }, { headers: { 'api-subscription-key': SARVAM_KEY(), 'Content-Type': 'application/json' }, timeout: 15000 });
                const b64 = r.data && r.data.audios && r.data.audios[0];
                pcm = b64 ? Buffer.from(b64, 'base64').subarray(44).toString('base64') : null;
            }
            if (!pcm || this.closed) return;
            this.s.transcript.push('Agent: ' + text);
            this.speaking = true;
            this.playToCaller(pcm);
            const durMs = Math.round(Buffer.from(pcm, 'base64').length / 48) + 500;
            setTimeout(() => { if (!this.turnAbort) this.speaking = false; }, durMs);
        } catch (e) { this.log('sayLine failed:', e.message); }
    }

    bargeIn() {
        this.log('barge-in — customer spoke over the agent');
        this.audioEndsAt = Date.now();             // clearAudio empties Vobiz's buffer — the drain clock resets
        try { this.vobiz.send(JSON.stringify({ event: 'clearAudio', streamId: this.streamId })); } catch (_) {}
        if (this.turnAbort) { try { this.turnAbort.abort(); } catch (_) {} this.turnAbort = null; }
        if (this.ttsWs) { try { this.ttsWs.close(); } catch (_) {} this.ttsWs = null; }
        this.speaking = false;
    }

    playToCaller(b64linear16) {
        if (!this.streamId) return;                // start event not seen yet — nothing to address
        let buf = Buffer.from(b64linear16, 'base64');
        // DRAIN CLOCK (user, 2026-09-02: "after customer confirm time slot … call cut when agent is
        // talking"): Vobiz buffers everything we send, so synthesis finishing ≠ the customer having
        // HEARD it. Every byte queued extends audioEndsAt (48 bytes/ms @24k mono 16-bit); nothing may
        // cut the call before this clock runs out.
        this.audioEndsAt = Math.max(this.audioEndsAt || Date.now(), Date.now()) + Math.round(buf.length / 48);
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
        // ElevenLabs mode opens no Sarvam socket — the turn synthesizes in one buffered call below.
        const elOn = EL_ON();
        const tts = elOn ? null : new WebSocket('wss://api.sarvam.ai/text-to-speech/ws?model=bulbul:v3', ['api-subscription-key.' + SARVAM_KEY()]);
        this.ttsWs = tts;
        const ttsReady = !tts ? Promise.resolve(false) : new Promise((res) => {
            tts.on('open', () => {
                tts.send(JSON.stringify({ type: 'config', data: { speaker: this.s.voice, target_language_code: this.s.lang, output_audio_codec: 'linear16', speech_sample_rate: 24000, enable_preprocessing: true, pace: 1 } }));
                res(true);
            });
            tts.on('error', () => res(false));
        });
        if (tts) tts.on('message', (m) => {
            try { const d = JSON.parse(m.toString()); const b64 = (d.data && d.data.audio) || d.audio;
                if (b64) { lastChunkAt = Date.now(); this.playToCaller(b64); } } catch (_) {}
        });
        try {
            const wsOk = await ttsReady;
            // ONE flush per turn, not one per sentence (user, 2026-09-01: "sounds like she is reading
            // something and then telling me… I want absolutely flawless"): each flush is an independent
            // synthesis, so per-sentence flushing reset the prosody at every full stop — line, pause,
            // line, the reading cadence. Replies are capped at 2 short sentences, so buffering the
            // whole turn costs a few hundred ms and buys one natural connected utterance.
            const pending = [];
            // Proof-of-brain + the TTFT measurement MODEL_DECISION.md calls its open item: every turn
            // logs which model answered and how fast its first sentence arrived.
            const brainModel = this.chatModel();
            const t0 = Date.now(); let ttftDone = false;
            // FAST LANE (user, 2026-09-02: "maximum less delay"): the FIRST sentence flushes to the
            // synthesizer the moment it exists — the voice starts while the rest of the reply is
            // still being written. The remaining sentences go as ONE second flush, so the turn keeps
            // at most one prosody seam (after sentence 1), never the old per-sentence choppiness.
            let firstFlushed = false;
            const say = (sentence) => {
                if (!ttftDone) { ttftDone = true; this.log(`brain ${brainModel || 'sarvam'} — first sentence in ${Date.now() - t0}ms`); }
                const spoken = toSpokenText(sentence);
                if (!spoken) return;
                if (!firstFlushed && wsOk && tts && tts.readyState === 1 && !abort.signal.aborted) {
                    firstFlushed = true; sentAny = true;
                    tts.send(JSON.stringify({ type: 'text', data: { text: spoken } }));
                    tts.send(JSON.stringify({ type: 'flush' }));
                } else pending.push(spoken);
            };
            const prompt = buildPrompt(this.s);
            const messages = userMsgOrNull ? this.history
                : [{ role: 'user', content: `Open the call now. Greet ${this.s.ctx.firstName} warmly, introduce yourself by your first name, and ask if they have two minutes. 1-2 short sentences.` }];
            const text = await chatStream(messages, prompt, say, abort.signal, brainModel, (this.s.claudeUsage = this.s.claudeUsage || {}));
            if (wsOk && tts.readyState === 1 && pending.length && !abort.signal.aborted) {
                sentAny = true;
                tts.send(JSON.stringify({ type: 'text', data: { text: pending.join(' ') } }));
                tts.send(JSON.stringify({ type: 'flush' }));
            } else if (pending.length && !abort.signal.aborted) {
                // No Sarvam socket here: ElevenLabs primary (when enabled) with Sarvam REST as its
                // fallback, or plain Sarvam REST when the socket died — a synthesis failure degrades,
                // never silences (the 33s "agent turn that never played" on the third RTO test).
                try {
                    let pcm = null;
                    if (elOn) {
                        try { pcm = await elevenPcm(pending.join(' '), this.s.lang); }
                        catch (e) { this.log('elevenlabs failed — Sarvam REST fallback:', e.message); }
                    }
                    if (!pcm) {
                        const r = await axios.post('https://api.sarvam.ai/text-to-speech', {
                            inputs: [pending.join(' ')], target_language_code: TTS_LANG(this.s.lang), speaker: this.s.voice,
                            model: 'bulbul:v3', speech_sample_rate: 24000, enable_preprocessing: true, output_audio_codec: 'wav', pace: 1,
                        }, { headers: { 'api-subscription-key': SARVAM_KEY(), 'Content-Type': 'application/json' }, timeout: 15000 });
                        const b64 = r.data && r.data.audios && r.data.audios[0];
                        if (b64) pcm = Buffer.from(b64, 'base64').subarray(44).toString('base64');
                    }
                    if (pcm && !this.closed && !abort.signal.aborted) {
                        this.playToCaller(pcm);
                        // hold the turn open while the audio drains, so barge-in keeps working
                        const durMs = Math.min(Math.round(Buffer.from(pcm, 'base64').length / 48), 20000);
                        await new Promise(res => { const t = setTimeout(res, durMs); abort.signal.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true }); });
                    }
                } catch (e) { this.log('REST turn fallback failed:', e.message); }
            }
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
            try { tts && tts.close(); } catch (_) {}
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
            if (Date.now() < (this.audioEndsAt || 0) + 4000) return;   // goodbye still PLAYING (+4s to respond)
            if (this.vadActive && el < 18000) return;     // they are mid-sentence — let them finish
            clearInterval(this.goodbyeTimer); this.goodbyeTimer = null;
            this.log('no response after the goodbye — ending call');
            this.hangup(200);
        }, 500);
    }

    hangup(delayMs, force) {
        // Never cut while queued speech is still playing (force = voicemail/silent-line cuts, where
        // nothing worth hearing is in the buffer). +400ms pad for the last frame's network ride.
        const drain = force ? 0 : Math.max(0, (this.audioEndsAt || 0) - Date.now() + 400);
        setTimeout(() => {
            if (this.closed) return;
            this.log('conversation complete — hanging up');
            this.killCallLeg();
            try { this.vobiz.close(); } catch (_) {}
        }, (delayMs || 0) + drain);
    }

    // The Stream XML carries, so Vobiz does NOT end the phone leg when our
    // socket closes (user, 2026-09-01: "after hang up call is not cutting on phone — its continued").
    // Ending the call for real is an API job: DELETE the live call. Idempotent — a 404 means the leg
    // is already down.
    killCallLeg() {
        // callId comes from the stream's start event — on a broken stream that event never arrives,
        // and the silent no-op left the CUSTOMER'S phone connected (2026-09-02 silent call: no
        // frames, no callId, no kill). The originate response's request_uuid is the same call uuid
        // and is known from second zero — always available as the fallback.
        const uuid = this.callId || this.s.vuuid;
        if (!uuid || this.legKilled) { if (!uuid) this.log('call leg kill skipped — no call uuid known'); return; }
        this.legKilled = true;
        axios.delete(`https://api.vobiz.ai/api/v1/Account/${V_AUTH_ID()}/Call/${uuid}/`,
            { headers: { 'X-Auth-ID': V_AUTH_ID(), 'X-Auth-Token': V_AUTH_TOKEN() }, timeout: 10000, validateStatus: () => true })
            .then(r => this.log('call leg hangup API:', r.status))
            .catch(e => this.log('call leg hangup API failed:', e.message));
    }

    async playOpening() {
        this.speaking = true;
        let pcm = null;
        try { pcm = await Promise.race([(this.s.openingPick ? this.s.openingPick() : this.s.openingPcmP), new Promise(res => setTimeout(() => res(null), 3000))]); } catch (_) {}
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

    onCustomer(text, sttLang) {
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
            this.hangup(200, true);
            return;
        }
        const SCREENER_RX = /screening|name and reason|reason for calling|stay on the line|स्क्रीनिंग|रीजन फॉर|स्टे ऑन द|कॉलिंग/i;
        if (SCREENER_RX.test(text)) {
            this.screenerSeen = true;           // a robot answered — the REAL customer hasn't talked yet
            this.log('screening assistant detected — waiting for the human (60s cap)');
        } else {
            this.presence = true;               // a genuine human utterance — countdown over
        }
        // STT NOISE GUARD (seen live 2026-09-01: one "utterance" of ~130 repeats of the same phrase —
        // an STT hallucination on line noise). A long transcript whose vocabulary is tiny relative to
        // its length is machine garbage, never speech: drop it entirely so it reaches neither the
        // transcript nor the model, and clamp any single utterance to 400 chars as the backstop.
        {
            const words = text.trim().split(/\s+/);
            if (words.length > 15) {
                const uniq = new Set(words.map(w => w.toLowerCase())).size;
                if (uniq / words.length < 0.25) { this.log('stt noise dropped (' + words.length + ' words, ' + uniq + ' unique)'); return; }
            }
            if (text.length > 400) text = text.slice(0, 400);
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
        } else {
            // DIRECT SWITCH — no confirmation question (user, 2026-09-02: "stop [the ask], switch
            // directly on that language; capture the customer's language efficiently"). The first
            // reliable sighting flips every layer at once. Detection order: the language detected
            // from the STT PARTIALS (the customer's REAL words — finals often arrive TRANSLATED to
            // English, making a Hindi speaker "look English" in text), then script letters on the
            // final, then the roman lexicon (two clearly-Hindi Latin words). One sighting = switch.
            const seen = (sttLang && sttLang !== this.s.lang ? sttLang : null) || scriptLangOf(text) || romanLangOf(text, this.s.lang);
            if (seen && seen !== this.s.lang) this.switchLanguage(seen);
        }
        // END-ON-REQUEST (call 18, 2026-09-02: the customer said "प्लीज़ कॉल रखिए" TWICE and got two
        // full closings instead of a hangup): the ask to end the call is honored on the very next
        // turn — one apology + closing, then the goodbye machinery cuts.
        if (/कॉल रख|फ़?ोन रख|call rakh|hang ?up|band kar|बंद कर|काट (दो|दीजिए)|nahi baat karn|नहीं बात करन|बहस( |बाज़)?ी? नहीं/i.test(text)) {
            this.s.endRequested = true;
            this.closingDone = false;               // the next turn IS the closing — let it speak once
        }
        // DISTRESS SCORE (MODEL_DECISION.md): the caller's own words drive the model ladder — each
        // frustration marker (or a third consecutive bare "hello?") is +1; at ESCALATE_AT the brain
        // steps up from the Haiku floor to Sonnet for the REST of the call (sticky).
        if (DISTRESS_RX.test(text)) this.s.distress = (this.s.distress || 0) + 1;
        if (/^(hello|हेलो)[\s.,!?…हेलो]*$/i.test(text.trim())) {
            this.s.helloRun = (this.s.helloRun || 0) + 1;
            if (this.s.helloRun >= 3) { this.s.distress = (this.s.distress || 0) + 1; this.s.helloRun = 0; }
        } else this.s.helloRun = 0;
        if ((this.s.distress || 0) >= ESCALATE_AT() && !this.s.escalated && CLAUDE_KEY()) {
            this.s.escalated = true;
            this.log(`distress ${this.s.distress} — brain escalated to ${CLAUDE_ESC()}`);
        }
        if (this.turnAbort) this.bargeIn();     // they answered before the agent finished
        this.speakTurn(text).catch(e => this.log('turn error:', e.message));
    }

    // Which brain answers this turn: no Claude key → Sarvam (null); otherwise the Haiku floor, or
    // the Sonnet escalation once distress crossed the threshold. Opus tier is OFF by decision.
    chatModel() {
        if (!CLAUDE_KEY()) return null;
        return this.s.escalated ? CLAUDE_ESC() : CLAUDE_FLOOR();
    }

    // Did the agent's most recent line actually offer this language? (name match via LANG_REQUEST,
    // which carries both the English and native spellings.)
    lastAgentAskedLang(code) {
        const last = [...this.s.transcript].reverse().find(l => /^Agent:/i.test(l)) || '';
        return LANG_REQUEST.some(([rx, c]) => c === code && rx.test(last));
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

    // The in-flight safety net: same row close() will finalize, refreshed while the call runs.
    async backupLog() {
        if (this.closed || this.s.transcript.length === this._backedUp) return;
        this._backedUp = this.s.transcript.length;
        const { error } = await supabase.from('agent_call_logs').upsert({
            id: this.logId,
            order_id: this.s.ctx.order_name || null,
            customer_name: this.s.ctx.customer_name || null,
            call_type: (this.s.callType || 'cod_confirm') + '_vobiz',
            language: this.s.lang,
            transcript: this.s.transcript.join('\n'),
            summary: `⏳ call in progress (live backup, ${Math.round((Date.now() - this.startedAt) / 1000)}s so far)`,
            exchanges: Math.ceil(this.s.transcript.length / 2),
            recording_url: this.s.recordingUrl || null,
        });
        if (error) this.log('live backup failed:', error.message);
    }

    async close(reason) {
        if (this.closed) return;
        this.closed = true;
        this.killCallLeg();                     // whatever ended the session, the phone leg dies with it
        if (this.presenceTimer) clearInterval(this.presenceTimer);
        if (this.goodbyeTimer) clearInterval(this.goodbyeTimer);
        if (this.backupTimer) clearInterval(this.backupTimer);
        this.log('call closed:', reason);
        try { this.stt && this.stt.close(); } catch (_) {}
        try { this.ttsWs && this.ttsWs.close(); } catch (_) {}
        if (this.turnAbort) { try { this.turnAbort.abort(); } catch (_) {} }
        try {
            const mech = `${Math.round((Date.now() - this.startedAt) / 1000)}s call to ${this.s.phone} (${reason})`
                + (this.s.ctx.calledBy ? ` · manual call by ${this.s.ctx.calledBy}` : (this.s.auto ? ' · auto engine' : ''));
            let summary = mech;
            if (this.s.transcript.length >= 2) {
                try { summary = (await summarizeCall(this.s.transcript.join('\n'), this.s.callType)) + '\n' + mech; }
                catch (e) { this.log('summarizer failed:', e.message); }
            }
            await supabase.from('agent_call_logs').upsert({
                id: this.logId,                     // finalizes the live-backup row instead of adding a duplicate
                order_id: this.s.ctx.order_name || null,
                customer_name: this.s.ctx.customer_name || null,
                call_type: (this.s.callType || 'cod_confirm') + '_vobiz',
                language: this.s.lang,
                transcript: this.s.transcript.join('\n'),
                summary,
                exchanges: Math.ceil(this.s.transcript.length / 2),
                recording_url: this.s.recordingUrl || null,
                cost_meta: this.s.claudeUsage && Object.keys(this.s.claudeUsage).length ? { claude: this.s.claudeUsage } : null,
            });
            // RTO-recovery calls leave their result ON THE ORDER (training review 2026-08-31: "मैं team
            // से बात करके arrange करवा दूँगी" went nowhere — no note, no flag, the 4:30 PM slot lost in
            // the transcript). The note lands in order_notes, which the Support order modal shows.
            if ((this.s.callType || '') === 'rto_recovery' && this.s.ctx.order_id && this.s.transcript.length >= 2) {
                const first = String(summary || '').split('\n').slice(0, 2).join(' · ');
                const { error: noteErr } = await supabase.from('order_notes').insert({
                    order_id: String(this.s.ctx.order_id),
                    agent_id: '00000000-0000-4000-8000-00000000a1ca',   // the AI voice agent's fixed id (column is uuid; no FK)
                    content: `🤖 AI RTO call: ${first}`.slice(0, 500),
                });
                if (noteErr) this.log('rto note failed:', noteErr.message);
            }
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
            // AUTO rto_recovery calls feed the RTO engine's ladder the same way (user spec 2026-09-02).
            // SUBSTANTIVE turns only (first live day: a 10s "Hello / Hello" call counted 2 turns, the
            // summarizer glitched on the tiny transcript, and the word "cancellation" in its refusal
            // text got the order marked CANCELLED) — bare greetings are not engagement.
            if (this.s.auto && (this.s.callType || '') === 'rto_recovery' && this.s.ctx.order_name) {
                require('./vobiz_auto_calls').handleRtoCallOutcome({
                    orderName: this.s.ctx.order_name, summary,
                    customerTurns: this.s.transcript.filter(l => /^customer:/i.test(l)
                        && !/^customer:\s*(hello|hi|हेलो|हैलो|haan|हाँ|ji|जी)[\s.,!?।]*$/i.test(l.trim())).length,
                }).catch(e => this.log('rto outcome handling failed:', e.message));
            }
        } catch (e) { this.log('log save failed:', e.message); }
    }
}

// TRAINING EXAMPLES from reviewed calls, in the prompt (MODEL_DECISION.md: "adding ~1,840 tokens of
// training examples … fixes the two worst-scoring behaviours and pushes the prompt past 4,096 so
// Haiku caches"). Loaded once per call like the lessons block; a fetch failure costs nothing.
let _exCache = { at: 0, byType: {} };
async function trainingExamplesBlock(callType) {
    try {
        if (Date.now() - _exCache.at > 5 * 60e3) {
            const { data } = await supabase.from('agent_training_examples').select('*').eq('active', true);
            _exCache = { at: Date.now(), byType: {} };
            for (const e of (data || [])) (_exCache.byType[e.call_type] = _exCache.byType[e.call_type] || []).push(e);
        }
        const rows = _exCache.byType[callType] || [];
        const parts = rows.map(e => {
            if (e.example_type === 'good' && e.good_dialogue) return `GOOD EXAMPLE${e.note ? ` (${e.note})` : ''}:\n${e.good_dialogue}`;
            if (e.example_type === 'bad' && e.bad_dialogue) return `BAD EXAMPLE — never do this:\n${e.bad_dialogue}${e.correction ? `\nINSTEAD:\n${e.correction}` : ''}${e.reason ? `\nWhy: ${e.reason}` : ''}`;
            if (e.example_type === 'verbatim' && e.verbatim_text) return `PROVEN LINE${e.verbatim_moment ? ` (${e.verbatim_moment})` : ''}: "${e.verbatim_text}"`;
            return '';
        }).filter(Boolean);
        if (!parts.length) return '';
        return ('\nTRAINING EXAMPLES — real moments from reviewed calls. Imitate the GOOD, never repeat the BAD:\n' + parts.join('\n---\n')).slice(0, 9000);
    } catch (_) { return ''; }
}

// Everything the store knows about the order, gathered BEFORE the call (user, 2026-09-02: "fetch
// all data regarding order shipment delivery … that will help make the call smooth and flawless in
// terms of data"). One readable block; FACTS DISCIPLINE makes it the closed world of speakable facts.
const IST_DAY = (d) => { try { return d ? new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short' }) : null; } catch (_) { return null; } };
async function callFactsFor(orderName) {
    const lines = [];
    try {
        const nm = String(orderName || '').replace(/^#/, '').trim();
        if (!nm) return '';
        const { data: o } = await supabase.from('orders').select('created_at, financial_status, gateway, total_price')
            .in('name', [nm, '#' + nm]).limit(1).maybeSingle();
        if (o) lines.push(`Order placed on ${IST_DAY(o.created_at)} · payment: ${/paid$/.test(String(o.financial_status || '')) && !/partially/.test(String(o.financial_status || '')) ? 'prepaid' : 'Cash on Delivery'}${o.gateway ? ` (via ${o.gateway})` : ''} · total Rs. ${o.total_price}`);
        const { data: sj } = await supabase.from('shipment_journey_ecom')
            .select('courier, outcome, attempts, ndr_count, ndr_reasons, dispatched_at, last_ofd_at, ofd_dates, first_edd, dest_city, dest_state, rto_at')
            .eq('order_name', nm).order('updated_at', { ascending: false }).limit(1).maybeSingle();
        if (sj) {
            if (sj.courier) lines.push(`Courier: ${sj.courier}${sj.dispatched_at ? ` · dispatched ${IST_DAY(sj.dispatched_at)}` : ''}${sj.first_edd ? ` · first promised delivery ${IST_DAY(sj.first_edd)}` : ''}`);
            const ofds = Array.isArray(sj.ofd_dates) ? sj.ofd_dates.filter(Boolean) : [];
            if (ofds.length) lines.push(`Out for delivery on: ${ofds.map(IST_DAY).filter(Boolean).join(', ')} (${ofds.length} attempt${ofds.length === 1 ? '' : 's'})`);
            else if (sj.last_ofd_at) lines.push(`Last out-for-delivery: ${IST_DAY(sj.last_ofd_at)}`);
            const reasons = Array.isArray(sj.ndr_reasons) ? sj.ndr_reasons.filter(Boolean) : [];
            if (reasons.length) lines.push(`Courier's reported reason(s), oldest first: ${reasons.join(' · ')}`);
            if (sj.rto_at) lines.push(`Marked returning to origin on ${IST_DAY(sj.rto_at)}`);
            // destination city/state deliberately EXCLUDED: call 18 improvised an address-confirmation
            // step out of "Destination: Amritsar, Punjab" on an order whose flow had no address step
        }
    } catch (_) { /* facts are best-effort — a fetch failure never blocks the call */ }
    return lines.length ? lines.map(l => '- ' + l).join('\n') : '';
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
    trainingExamplesBlock(PURPOSES[callType] ? callType : 'cod_confirm')
        .then(b => { const s = sessions.get(sid); if (s) s.examplesBlock = b; }).catch(() => {});
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
// ── ElevenLabs TTS — optional voice provider (2026-09-01, "can you connect to elevenlabs") ──
// VOBIZ_TTS=elevenlabs + ELEVENLABS_API_KEY switches the agent's VOICE to ElevenLabs; everything
// else — Sarvam STT, the chat model, every prompt rule — is untouched. eleven_flash_v2_5 speaks all
// ten call languages with ONE voice, so the same voice survives a mid-call Hindi switch.
// pcm_24000 out = exactly the L16@24k that playToCaller feeds Vobiz — no transcoding.
const EL_KEY = () => process.env.ELEVENLABS_API_KEY;
const EL_ON = () => String(process.env.VOBIZ_TTS || '').toLowerCase() === 'elevenlabs' && !!EL_KEY();
const EL_VOICE = () => process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL';
const EL_MODEL = () => process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5';
async function elevenPcm(text, lang) {
    const r = await axios.post(`https://api.elevenlabs.io/v1/text-to-speech/${EL_VOICE()}?output_format=pcm_24000`,
        { text, model_id: EL_MODEL(), language_code: String(lang || 'en').slice(0, 2) },
        { headers: { 'xi-api-key': EL_KEY(), 'Content-Type': 'application/json' }, responseType: 'arraybuffer', timeout: 20000, validateStatus: () => true });
    if (r.status >= 400) throw new Error('elevenlabs ' + r.status + ': ' + Buffer.from(r.data || []).toString().slice(0, 120));
    return Buffer.from(r.data).toString('base64');   // raw L16 @24k mono
}

async function synthOpening(s) {
    if (EL_ON()) return elevenPcm(s.openingText, s.lang);
    const r = await axios.post('https://api.sarvam.ai/text-to-speech', {
        inputs: [s.openingText], target_language_code: TTS_LANG(s.lang), speaker: s.voice,
        model: 'bulbul:v3', speech_sample_rate: 24000, enable_preprocessing: true, output_audio_codec: 'wav', pace: 1,
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
// Hindi-belt / North India states open in HINDI (user, 2026-09-02: "all North India states call
// should go default as Hindi, rest all states default English") — the mid-call switch ladder still
// handles everything else.
const HINDI_BELT_RX = /delhi|haryana|punjab|uttar ?pradesh|uttarakhand|uttaranchal|himachal|jammu|kashmir|ladakh|rajasthan|bihar|jharkhand|madhya ?pradesh|chhattisgarh|chandigarh|\bUP\b|\bMP\b|\bHR\b|\bDL\b|\bRJ\b|\bBR\b|\bPB\b|\bUK\b|\bHP\b|\bCG\b|\bJH\b/i;
async function langForOrder(orderId) {
    try {
        const { data: addr } = await supabase.from('order_shipping_addresses')
            .select('province').eq('order_id', orderId).maybeSingle();
        if (addr && HINDI_BELT_RX.test(String(addr.province || ''))) return 'hi-IN';
    } catch (_) {}
    return 'en-IN';                                     // everywhere else opens in English
}
// The REGION still matters as a HINT (Kannada call lesson, 2026-09-01): when the customer's speech
// comes back as Latin gibberish (the transcriber can't render a language the call isn't set to),
// script detection is blind — but a Karnataka order almost certainly speaks Kannada. The prompt
// gets this as a fallback suggestion, never as the opening language.
async function regionLangForOrder(orderId) {
    try {
        const { data: addr } = await supabase.from('order_shipping_addresses')
            .select('province').eq('order_id', orderId).maybeSingle();
        const state = String((addr && addr.province) || '');
        for (const [rx, lang] of REGION_LANG) if (rx.test(state)) return lang;
    } catch (_) {}
    return null;
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
    // A short reply that simply NAMES a language IS the request ("Yes, Kannada Nayate" — live call
    // 2026-09-01, the cue-word gate blocked the switch and the agent then claimed not to know
    // Kannada). Longer sentences still need a cue so a passing mention cannot flip the call.
    const short = String(text).trim().split(/\s+/).length <= 4;
    if (!short && !LANG_CUE.test(text)) return null;
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

// The language OFFER, spoken MECHANICALLY (2026-09-01: the prompt-instructed ask was skipped by the
// model on two consecutive live calls — the offer now bypasses the LLM entirely, like HELLO_CHECK).
// Bilingual on purpose: the customer who triggered it may not have understood the call language.
const NATIVE_OFFER = {
    'hi-IN': 'क्या आप हिंदी में बात करना चाहेंगे?',
    'bn-IN': 'আপনি কি বাংলায় কথা বলতে চান?',
    'ta-IN': 'தமிழில் தொடரலாமா?',
    'te-IN': 'తెలుగులో మాట్లాడాలనుకుంటున్నారా?',
    'kn-IN': 'ಕನ್ನಡದಲ್ಲಿ ಮಾತನಾಡೋಣವೇ?',
    'ml-IN': 'മലയാളത്തിൽ സംസാരിക്കണോ?',
    'mr-IN': 'आपण मराठीत बोलूया का?',
    'gu-IN': 'શું આપણે ગુજરાતીમાં વાત કરીએ?',
    'pa-IN': 'ਕੀ ਅਸੀਂ ਪੰਜਾਬੀ ਵਿੱਚ ਗੱਲ ਕਰੀਏ?',
};
const offerLine = (code) => NATIVE_OFFER[code]
    ? `Would you prefer to continue in ${LANG_NAMES[code]}? ${NATIVE_OFFER[code]}`
    : null;

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
// Sarvam STT in ENGLISH mode writes Hindi speech in LATIN letters ("Kya bol rahe ho?") — no
// Devanagari, so scriptLangOf never saw it and the language offer never fired (lost RTO call,
// 2026-09-01: the customer's Hindi confusion got English repeats until they said the word "Hindi").
// Two clearly-Hindi words in one utterance = the customer is speaking Hindi.
// Frustration markers in either language — the distress scorer's vocabulary (precision over recall;
// a false escalation only costs the Haiku→Sonnet price gap, a missed one costs a bad call).
const DISTRESS_RX = /बार[- ]?बार|baar[- ]?baar|हर बार|har baar|कितनी बार|kitni baar|again and again|doing nothing|वही बोल|वही बात|same thing|not understand|samajh nahi|समझ नहीं|kya bol rahe|what are you saying|गुस्सा|angry|frustrat|बकवास|bakwas|nonsense|complaint|शिकायत|shikayat|pareshan|परेशान|irritat|ridiculous|stupid|bekaar|बेकार|time waste|टाइम वेस्ट|फालतू|faltu|जबरदस्ती|zabardasti|फ़?ोन पर फ़?ोन|phone pe phone|ख़?राब (सर्विस|service)|kharab service|poor service|worst|कैसे (काम )?चलेगा|kaise (kaam )?chalega|how did this happen|waiting for (the last |so many )?\d+ days|\d+ दिन( से)? (वेट|इंतज़ार)/i;
const ROMAN_HI_RX = /\b(kya|nahi|nahin|nhi|haan|theek|thik|acha|accha|achha|bolo|boliye|bhejo|bhej|bhejiye|bhijwa|bijwa|bhijwado|bijwado|dijiye|kijiye|batao|bataiye|raha|rahi|rahe|karo|karein|kariye|karna|mein|hain|hoon|aap|kaun|kab|kabhi|kyun|kyu|matlab|samajh|sahi|chahiye|abhi|baat|bhasha|yeh|woh|sakta|sakte|sakti|hoga|hogi)\b/gi;
function romanLangOf(text, currentLang) {
    if (currentLang !== 'en-IN') return null;
    const hits = (String(text).match(ROMAN_HI_RX) || []).length;
    return hits >= 2 ? 'hi-IN' : null;
}
const AFFIRM_RX = /\u0939\u093e\u0901|\u091c\u0940|yes|ok|\u0a39\u0a3e\u0a02|\u09b9\u09cd\u09af\u09be\u0981|\u0b86\u0bae\u0bcd|\u0b86\u0bae\u093e|\u0c05\u0c35\u0c41\u0c28\u0c41|\u0cb9\u0ccc\u0ca6\u0cc1|\u0d05\u0d24\u0d46|\u0ab9\u0abe/i;

const LANG_NAMES = { 'hi-IN': 'Hindi', 'en-IN': 'English', 'ta-IN': 'Tamil', 'kn-IN': 'Kannada', 'ml-IN': 'Malayalam',
    'te-IN': 'Telugu', 'bn-IN': 'Bengali', 'mr-IN': 'Marathi', 'gu-IN': 'Gujarati', 'pa-IN': 'Punjabi' };

const TTS_LANG = (l) => (['hi-IN', 'ta-IN', 'kn-IN', 'ml-IN', 'te-IN', 'bn-IN', 'mr-IN', 'gu-IN', 'pa-IN', 'en-IN'].includes(l) ? l : 'hi-IN');
function armOpening(s) {
    // TWO LANES, in parallel (user, 2026-09-02: "call ringing early and speak start lately"):
    //   fast lane — the vetted template synthesizes IMMEDIATELY, ready well inside the first ring;
    //   brain lane — Claude writes the greeting ("don't depend on fixed speech") and pre-synthesizes
    //   it, hard-capped at 4s. At ANSWER, openingPick() takes Claude's version only if it is FULLY
    //   ready (text + audio); otherwise the template speaks with zero added delay.
    const tmpl = openingLine(s);
    s.openingText = tmpl;
    const tmplPcmP = tmpl ? synthOpening(s).catch(e => { console.log('[vobiz] opening pre-synth failed (will fall back to live turn):', e.message); return null; }) : Promise.resolve(null);
    let brainReady = null;                      // {text, pcm} once BOTH are done
    if (CLAUDE_KEY()) {
        (async () => {
            try {
                let text = '';
                const ac = new AbortController();
                const cap = setTimeout(() => ac.abort(), 4000);
                await claudeChatStream(
                    [{ role: 'user', content: `Open the call now. Greet ${s.ctx.firstName} warmly — always "${s.ctx.firstName} ji", never the bare name — introduce yourself by your first name and The Element, and ask if they have two minutes. 1-2 short natural sentences in ${LANG_NAMES[s.lang] || 'English'} — never a word more.` }],
                    buildPrompt(s), (t) => { text += (text ? ' ' : '') + t; }, ac.signal, CLAUDE_FLOOR(), (s.claudeUsage = s.claudeUsage || {}));
                clearTimeout(cap);
                text = text.trim();
                if (!text) return;
                const pcm = await synthOpening({ ...s, openingText: text }).catch(() => null);
                if (pcm) brainReady = { text, pcm };
            } catch (e) { console.log('[vobiz] claude opening failed — template opening:', e.message); }
        })();
    }
    s.openingPick = () => {
        if (brainReady) { s.openingText = brainReady.text; return Promise.resolve(brainReady.pcm); }
        return tmplPcmP;
    };
    s.openingPcmP = tmplPcmP;                   // compat for anything still reading the old field
}

// ── place a call — ONE path for the dashboard button (/vobiz/call) and the high-value auto-caller
// (vobiz_auto_calls.js). Returns { success, sid } or { error, code, gated } — gated marks an
// allowlist refusal so the auto-caller can leave the order retryable instead of failed.
async function placeOrderCall(b) {
    if (!vobizConfigured()) return { error: 'Vobiz not configured — set VOBIZ_AUTH_ID / VOBIZ_AUTH_TOKEN / VOBIZ_FROM_NUMBER / VOBIZ_PUBLIC_BASE / VOBIZ_WEBHOOK_TOKEN in .env', code: 400 };
    // RTO recovery is UNDER TEST (user, 2026-09-01: "don't do any mess on live") — it dials only
    // where VOBIZ_RTO_ENABLED=true is set (the dev .env). On live the flag is absent, so even a
    // direct API call cannot place an RTO call until the user flips it there deliberately.
    if (b.call_type === 'rto_recovery' && String(process.env.VOBIZ_RTO_ENABLED || '') !== 'true')
        return { error: 'RTO recovery calls are disabled here (still under test) — set VOBIZ_RTO_ENABLED=true to enable', code: 403 };
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
    if (b._by) ctx.calledBy = String(b._by);                        // manual dial — WHO pressed the button (2026-09-01)
    if (orderRow) ctx.order_id = orderRow.id;
    if (orderRow) ctx.regionLang = await regionLangForOrder(orderRow.id);                       // for the outcome note (order_notes is keyed by it)
    if (b.order_name) ctx.productInfo = await productKnowledgeFor(String(b.order_name).replace(/^#/, '').trim());
    if (b.order_name) ctx.callFacts = await callFactsFor(b.order_name);   // the order's full verified story, every call type
    // RTO calls get the real shipping address so "let me confirm the address" is a real offer, not an
    // empty one (2026-08-31 training review: the agent offered to confirm an address it did not have).
    if (b.call_type === 'rto_recovery' && orderRow) {
        // The REAL failure reason from the courier's scan log (user, 2026-09-01: "Check AWB Scan Log
        // of Undelivered/NDR Reason … As per our delivery partner, <actual reason> — refine polite"),
        // so "why was it not delivered?" gets the actual answer, not "I have noted that".
        try {
            const nm = String(b.order_name || '').replace(/^#/, '').trim();
            const { data: sj } = await supabase.from('shipment_journey_ecom')
                .select('ndr_reasons').eq('order_name', nm).order('updated_at', { ascending: false }).limit(1).maybeSingle();
            const rs = (sj && Array.isArray(sj.ndr_reasons)) ? sj.ndr_reasons.filter(Boolean) : [];
            if (rs.length) ctx.ndrReason = String(rs[rs.length - 1]).slice(0, 120);   // latest attempt's reason
        } catch (_) { /* reason is optional */ }
        // The full address is spoken ON CALL only when the courier's reason blames the ADDRESS
        // (user, 2026-09-02: "please avoid to tell complete address — only tell and confirm when NDR
        // reason is Wrong Address or same reason in other word"). No address in the prompt = the flow
        // skips the address step entirely (existing skip rule) — privacy by default.
        if (/address|पता|premises|location|unlocatable|not found|incorrect|incomplete|wrong/i.test(ctx.ndrReason || '')) {
            try {
                const { data: a } = await supabase.from('order_shipping_addresses')
                    .select('address1, address2, city, province, zip').eq('order_id', orderRow.id).maybeSingle();
                if (a) ctx.address = [a.address1, a.address2, a.city, a.province, a.zip].filter(Boolean).join(', ').slice(0, 220);
            } catch (_) { /* address is optional */ }
        }
    }
    const lang = b.lang || (orderRow ? await langForOrder(orderRow.id) : 'en-IN');
    const sid = createSession({ phone, ctx, lang, voice: b.voice || 'kavya', callType: b.call_type, auto: !!b.auto });
    armOpening(sessions.get(sid));            // synthesize the greeting while the phone rings
    const answerUrl = `${V_BASE()}/api/vobiz/answer?token=${V_TOKEN()}&sid=${sid}`;
    const r = await axios.post(`https://api.vobiz.ai/api/v1/Account/${V_AUTH_ID()}/Call/`, {
        from: V_FROM(), to: '91' + phone,
        answer_url: answerUrl, answer_method: 'POST',
        hangup_url: `${V_BASE()}/api/vobiz/hangup?token=${V_TOKEN()}&sid=${sid}`,
        // Ring a FULL minute before giving up (user, 2026-09-01: "complete ringing till hangup") —
        // explicit instead of the platform default, so an unanswered-but-ringing call shows ~60s in
        // every log and nobody is hung up on mid-ring. A carrier busy/refusal still ends it early.
        ring_timeout: 60,
    }, { headers: { 'X-Auth-ID': V_AUTH_ID(), 'X-Auth-Token': V_AUTH_TOKEN(), 'Content-Type': 'application/json' }, timeout: 20000, validateStatus: () => true });
    if (r.status >= 300) return { error: `Vobiz ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`, code: 502 };
    // the originate's request_uuid IS the call uuid — kept on the session so the leg can be killed
    // even when the media stream (and its start event) never materializes
    const sess = sessions.get(sid);
    if (sess && r.data) sess.vuuid = r.data.request_uuid || r.data.call_uuid || null;
    return { success: true, sid, phone, vobiz: r.data };
}

// ── HTTP: place a call ──
router.post('/vobiz/call', async (req, res) => {
    try {
        const r = await placeOrderCall({ ...(req.body || {}), _by: (req.user && req.user.sub) || null });
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
async function summarizeCall(transcriptText, callType) {
    // RTO calls carry different facts worth keeping: did they agree to a reattempt, why did delivery
    // fail, what time slot did they give — the COD vocabulary lost all three ("confirmed cancel none").
    const sys = callType === 'rto_recovery'
        ? 'You summarize RTO-recovery phone calls (an order came back undelivered; the agent asked if the customer wants it re-sent). Reply in English only, max 2 short lines: line 1 = RESULT (reattempt agreed / cancelled / no answer / unclear): then the failure reason in a few words. Line 2 = the exact preferred delivery time or address correction the customer gave, or "none" — a customer saying any time is fine IS an answer: write "anytime", never "none", for it. If the transcript is too short or the customer only said hello, output exactly "RESULT: no answer: customer never engaged. none" — NEVER ask for more transcript, never explain yourself, never use the words cancel or confirm in that case.'
        : 'You summarize customer support phone calls. Reply in English only, max 2 short lines: line 1 = OUTCOME (confirmed / wants cancel / will reattempt / no clear answer / other): then 5-10 words of detail. Line 2 = promise or follow-up needed, or "none".';
    // Claude first (ai.js — the configured provider; 2026-09-02: a Sarvam summarizer failure left a
    // call with no RESULT line at all), Sarvam as fallback, the mechanical line beyond that.
    try {
        const out = await require('./ai').aiComplete([
            { role: 'system', content: sys },
            { role: 'user', content: transcriptText.slice(0, 4000) },
        ], { temperature: 0.2, maxTokens: 120 });
        if (out) return sanitizeReply(out).slice(0, 400);
    } catch (_) { /* fall through to Sarvam */ }
    const r = await fetch('https://api.sarvam.ai/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'api-subscription-key': SARVAM_KEY() },
        body: JSON.stringify({ model: 'sarvam-105b-conversations', max_tokens: 120, temperature: 0.2, reasoning_effort: null,
            messages: [
                { role: 'system', content: sys },
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
    // NEVER-CONNECTED hangup (user, 2026-09-01: "why wait 7 minutes — do it instantly"): the carrier
    // refused/timed out before any answer, so no session close will ever run. Vobiz tells us within
    // seconds via this webhook — hand it to the engine NOW; the 7-minute sweep stays as the backstop
    // for a lost webhook.
    else if (s && !s.call && s.auto && ['cod_confirm', 'rto_recovery'].includes(s.callType || '') && s.ctx.order_name) {
        require('./vobiz_auto_calls').handleUnansweredHangup(s.ctx.order_name, s.callType)
            .catch(e => console.log('[vobiz] unanswered-hangup handling failed:', e.message));
    }
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
