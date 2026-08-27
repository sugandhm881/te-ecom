// ─────────────────────────────────────────────────────────────────────────────
// LOCAL Vobiz-call simulator — proves the whole real-call bridge with NO Vobiz account.
//
// It stands in for Vobiz's side of the wire, byte-for-byte: spins a minimal server with only the
// bridge mounted, opens the media WebSocket exactly like Vobiz would (same URL, token, "start"
// message), streams a SYNTHESIZED customer (Sarvam TTS, 16 kHz L16, 20ms frames at real-time pace —
// VAD needs real pacing to hear the pauses), and records every playAudio frame the agent sends
// back into a WAV you can LISTEN to. What stays untested until a real call: Vobiz's own telephony
// leg and the L16 endianness question (VOBIZ_L16_SWAP).
//
// Run: node tests/vobiz_call_sim.js       (needs SARVAM_API_KEY in .env; ~60-90s)
// ─────────────────────────────────────────────────────────────────────────────
require('../app/secrets').load();   // .env.vault (AES-256-GCM) or plaintext .env
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocket } = require('ws');
const bridge = require('../app/api/vobiz_bridge');

const KEY = String(process.env.SARVAM_API_KEY || '').trim().split(/\s+/)[0];
const OUT = path.join(__dirname, 'out');
process.env.VOBIZ_WEBHOOK_TOKEN = process.env.VOBIZ_WEBHOOK_TOKEN || 'simtoken';
const TOKEN = String(process.env.VOBIZ_WEBHOOK_TOKEN).trim();

const CUSTOMER_LINES = [
    'जी बताइए।',
    'जी हाँ, बिल्कुल available रहूँगा।',
];

async function synthCustomer(text) {
    const r = await fetch('https://api.sarvam.ai/text-to-speech', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'api-subscription-key': KEY },
        body: JSON.stringify({ inputs: [text], target_language_code: 'hi-IN', speaker: 'neha', model: 'bulbul:v3', speech_sample_rate: 16000, output_audio_codec: 'wav' }),
    });
    const j = await r.json();
    if (!j.audios) throw new Error('customer synth failed: ' + JSON.stringify(j).slice(0, 150));
    const wav = Buffer.from(j.audios[0], 'base64');
    return wav.subarray(44);                                   // raw L16 @16k mono
}

function wavHeader(pcmBytes, rate) {
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + pcmBytes, 4); h.write('WAVE', 8);
    h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
    h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
    h.write('data', 36); h.writeUInt32LE(pcmBytes, 40);
    return h;
}

(async () => {
    if (!KEY) { console.error('SARVAM_API_KEY missing'); process.exit(1); }
    fs.mkdirSync(OUT, { recursive: true });

    console.log('synthesizing the customer voice…');
    const customerPcm = [];
    for (const line of CUSTOMER_LINES) customerPcm.push(await synthCustomer(line));

    // minimal host: ONLY the bridge — no crons, no full server
    const app = express();
    app.use(express.json());
    app.use('/api', bridge.router);
    const server = http.createServer(app);
    bridge.attachVobizWs(server);
    await new Promise(res => server.listen(0, res));
    const port = server.address().port;

    const sid = bridge.createSession({
        phone: '7289804108',
        ctx: { customer_name: 'Sugandh Kumar Mishra', firstName: 'Sugandh', product: 'Acne Relief Face Wash', amount: 1047, order_name: 'TE25-44586' },
        lang: 'hi-IN', voice: 'kavya',
    });

    const t0 = Date.now();
    const ts = () => 't+' + ((Date.now() - t0) / 1000).toFixed(1) + 's';
    const agentChunks = [];
    let lastAudioAt = 0, firstAudioAt = null, cleared = 0;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/vobiz/media?token=${TOKEN}&sid=${sid}`);
    const STREAM_ID = 'sim-stream-0001';
    ws.on('message', (m) => {
        let d; try { d = JSON.parse(m.toString()); } catch { return; }
        if (d.event === 'playAudio' && d.media && d.media.payload) {
            if (d.streamId !== STREAM_ID) { console.log(ts(), 'WRONG streamId on playAudio:', d.streamId); }
            if (firstAudioAt === null) { firstAudioAt = Date.now() - t0; console.log(ts(), 'FIRST agent audio (' + d.media.contentType + ' @' + d.media.sampleRate + ')'); }
            agentChunks.push(Buffer.from(d.media.payload, 'base64'));
            lastAudioAt = Date.now();
        }
        if (d.event === 'clearAudio') { cleared++; console.log(ts(), 'clearAudio (barge-in)'); }
    });
    await new Promise(res => ws.on('open', res));
    console.log(ts(), 'media stream connected (like Vobiz would)');
    ws.send(JSON.stringify({ sequenceNumber: 0, event: 'start', start: { callId: 'sim-call', streamId: STREAM_ID, accountId: 'sim', tracks: ['inbound'], mediaFormat: { encoding: 'audio/x-l16', sampleRate: 16000 } } }));

    // stream utterance PCM in 20ms frames at real-time pace, then trailing silence for the VAD
    const FRAME = 640;                                          // 320 samples @16k = 20ms
    const silence = Buffer.alloc(FRAME);
    let seq = 0;
    const mediaFrame = (buf) => JSON.stringify({ sequenceNumber: ++seq, streamId: STREAM_ID, event: 'media',
        media: { track: 'inbound', timestamp: Date.now(), chunk: seq, payload: buf.toString('base64') } });
    async function speakAsCustomer(pcm) {
        for (let i = 0; i < pcm.length; i += FRAME) {
            ws.send(mediaFrame(pcm.subarray(i, i + FRAME)));
            await new Promise(r => setTimeout(r, 19));
        }
        for (let i = 0; i < 60; i++) {                          // 1.2s silence → VAD end-of-turn
            ws.send(mediaFrame(silence));
            await new Promise(r => setTimeout(r, 19));
        }
    }
    const waitAgentDone = () => new Promise((res) => {
        const t = setInterval(() => {
            if (lastAudioAt > 0 && Date.now() - lastAudioAt > 2500) { clearInterval(t); res(); }
            if (Date.now() - t0 > 120000) { clearInterval(t); res(); }
        }, 250);
    });

    console.log(ts(), 'waiting for the agent to open the call…');
    await waitAgentDone();
    for (let i = 0; i < customerPcm.length; i++) {
        console.log(ts(), `customer speaks: "${CUSTOMER_LINES[i]}"`);
        lastAudioAt = 0;
        await speakAsCustomer(customerPcm[i]);
        await waitAgentDone();
    }

    ws.close();
    await new Promise(r => setTimeout(r, 1500));
    server.close();

    const pcmAll = Buffer.concat(agentChunks);
    const wavPath = path.join(OUT, 'vobiz_sim_agent.wav');
    fs.writeFileSync(wavPath, Buffer.concat([wavHeader(pcmAll.length, 24000), pcmAll]));

    const s = bridge.sessions.get(sid);
    console.log('\n──────── RESULT ────────');
    console.log('first agent audio:', firstAudioAt !== null ? firstAudioAt + 'ms after start' : 'NEVER (broken)');
    console.log('agent audio total:', (pcmAll.length / 2 / 24000).toFixed(1) + 's  →', wavPath);
    console.log('barge-ins:', cleared);
    console.log('transcript:');
    (s.transcript || []).forEach(l => console.log('  ' + l));
    process.exit(firstAudioAt === null || !(s.transcript || []).length ? 1 : 0);
})().catch(e => { console.error('SIM FAILED:', e.message); process.exit(1); });
