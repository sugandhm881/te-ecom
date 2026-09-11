'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// WHAT ANSWERED THE PHONE, WHEN IT WAS NOT THE CUSTOMER (user, 2026-09-11: "these kind of message
// 'The person you're trying to reach isn't available' — make sure these kind of calls go in no answer
// instead of transcript saved and go spoken but not recorded and unclear").
//
// ONE definition, read in two places:
//   · LIVE, by vobiz_bridge — to hang up on a machine the moment it identifies itself, and to write its
//     words as `Machine:` rather than `Customer:`;
//   · ON HISTORY, by Call Insights — transcripts saved before this module existed carry the machine's
//     words as `Customer:` lines, and would otherwise go on counting as a person speaking for ever.
// Two copies of this list would drift, and the dashboard would disagree with the call it describes.
//
// Measured on 2026-09-10: 17 of 93 AI calls had a machine speaking as the customer (569 s of line
// time); 15 of the 30 "Spoke, no outcome recorded" were machines; 13 of those 17 flipped the call's
// language; and one voicemail box (TE25-47195) was rung five times, ~32 s each, without once being
// recognised — because the recogniser wrote the English announcement IN DEVANAGARI ("द पर्सन यू आर
// ट्राइंग टू रीच इज़ नॉट अवेलेबल"), and the old pattern only read English letters.
//
// ⚠️ PRECISION OVER RECALL. A false match on a real customer HANGS UP ON THEM. Every phrase here is
// something a network or a phone says ABOUT the customer — "the person you are trying to reach", "at
// the tone", "forwarded to voicemail" — never what a customer says about themselves. "I am busy",
// "call me later", "not now" are the customer's own words and must never match: those are a callback.
// ─────────────────────────────────────────────────────────────────────────────

// UNREACHABLE — terminal. The customer is not coming: hang up, file no answer, let the retry ladder run.
// ⚠️ A strict SUPERSET of the VOICEMAIL_RX the bridge carried from 2026-08-31 to 2026-09-11 — every
// phrase that used to hang up still does, so nothing the agent caught before is missed now.
const UNREACHABLE = [
    // — English, as the carrier or the phone says it —
    "person (?:you.?re|you are|your) trying to (?:reach|call)",   // "you're", "you are", and STT's "your"
    'at the tone', 'after the (?:beep|tone)', 'record your message', 'please record',
    'customer you (?:are|have) (?:called|calling)', 'number you (?:have )?dial(?:l)?ed',
    'is not reachable', 'switched off', 'coverage area', 'not answering (?:the|your) call',
    '(?:forwarded|diverted|transferred) to (?:the )?voice ?mail', 'voice ?mail (?:box|service)',
    'true ?caller voice ?mail',
    // Apple call screening's LAST line — the person heard who was calling and declined. Its OPENING
    // lines are WAITING, below: the customer may still pick up after hearing the reason.
    "(?:i.?m|i am) sorry,? (?:but )?this person (?:is not|isn.?t) available",
    // — the same English written IN DEVANAGARI by the recogniser: the pattern that slipped through —
    'ट्राइंग टू (?:रीच|कॉल)', 'वॉइस ?मेल', 'एट द टोन', 'ऑन द टोन', 'आफ्टर द (?:बीप|टोन)',
    '(?:रि|रे)कॉर्ड योर मैसेज', 'पर्सन.{0,40}(?:नॉट अवेलेबल|अवेलेबल नहीं|उपलब्ध नहीं)',
    // — Hindi carrier announcements —
    'जिस व्यक्ति', 'ग्राहक.{0,20}(?:व्यस्त|उपलब्ध नहीं|पहुंच)', 'संदेश रिकॉर्ड',
    'संपर्क.{0,40}उपलब्ध नहीं', 'स्विच ऑफ है', 'पहु(?:ं|ँ)च से बाहर है', 'कवरेज क्षेत्र',
];

// WAITING — a machine holding the line for a human who may still come: Apple's screening opening, a
// network "your call is on hold". NOT a hang-up (the bridge keeps its existing 60 s wait for these,
// exactly as before) — but the words are the machine's, so they never count as the customer speaking
// and never choose the call's language.
// "रीज़न" is spelled three ways in Unicode (ज, ज + nukta, precomposed ज़), so all three are listed.
const WAITING = [
    'record your name and reason', 'reason for (?:your )?calling', 'see if (?:this|the) person is available',
    'put your call on hold',
    '^[\\s,.]*(?:thanks|thank you)?[\\s,.]*please (?:stay|wait) (?:on|in) (?:the )?line[\\s.]*$',
    'री(?:ज़?|ज़)न फॉर कॉलिंग', 'पुट योर कॉल ऑन होल्ड', 'स्टे ऑन द लाइन',
    '(?:कॉल|call) (?:को |ko )?होल्ड पर रख', 'hold par rakh',
];

const UNREACHABLE_RX = new RegExp(UNREACHABLE.join('|'), 'i');
const WAITING_RX = new RegExp(WAITING.join('|'), 'i');

// 'unreachable' | 'waiting' | null. UNREACHABLE is checked first, so the existing precedence holds: any
// line the old voicemail pattern hung up on still hangs up, even if it also sounds like a hold.
function machineKind(text) {
    const t = String(text || '');
    if (UNREACHABLE_RX.test(t)) return 'unreachable';
    if (WAITING_RX.test(t)) return 'waiting';
    return null;
}
const isMachineLine = (text) => machineKind(text) !== null;

module.exports = { UNREACHABLE_RX, WAITING_RX, machineKind, isMachineLine };
