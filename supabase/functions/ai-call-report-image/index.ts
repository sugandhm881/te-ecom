// ─────────────────────────────────────────────────────────────────────────────
// ai-call-report-image — renders the Call Insights page as a PNG (Satori JSX→SVG + resvg-wasm
// SVG→PNG), uploads it to the public `reports` bucket and returns the URL.
//
// REWRITTEN 2026-09-09 (user: "i want report in image format not table format"). It previously drew
// the old COD-only report's order table; it now draws the Call Insights layout the dashboard shows —
// the KPI row, "Where the calls went", and the two outcome groups — because that is the report now.
//
// Why an image at all: an Adaptive Card cannot scroll horizontally and is ~360px on Teams mobile, so
// anything wide either truncates or reflows to one word per line. The image scales to the screen and
// pinch-zooms via `allowExpand`. The card still carries a one-line text headline so the report is
// searchable and readable in a notification preview — the image is the report, not the only copy.
//
// ⚠️ GLYPHS. The Roboto latin subset has no rupee sign, no emoji, no en/em dash and no middle dot.
// Anything outside printable ASCII renders as a blank box, so `ascii()` strips it and every label
// here is written in plain ASCII on purpose — "-" not "—", "/" not "·". Do not paste a nicer dash in.
// ─────────────────────────────────────────────────────────────────────────────
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'
import satori from 'https://esm.sh/satori@0.10.13'
import { Resvg, initWasm } from 'https://esm.sh/@resvg/resvg-wasm@2.6.2'

let wasmReady = false
async function ensureWasm() {
  if (!wasmReady) { await initWasm(fetch('https://unpkg.com/@resvg/resvg-wasm@2.6.2/index_bg.wasm')); wasmReady = true }
}

// THE WELCOME-SCREEN PALETTE (user, 2026-09-09: "make these of our welcome screen color code for
// report as background"). The login / welcome popup is the brand's dark-premium violet:
//   linear-gradient(165deg, #211d54, #111536 60%, #0b0f26) over #14173a surfaces, indigo accents.
// A report posted into Teams sits beside those screens in people's heads, so it wears the same clothes.
//
// ⚠️ Every colour here had to move, not just the background. The light theme's ink (#0f172a) and
// muted (#94a3b8) are invisible on a near-black ground, and the light tones (#059669, #e11d48) go
// muddy — the dark theme needs the LIFTED variants (#34d399, #fb7185) to hold the same meaning.
const BG = '#0b0f26', BG_GRAD = 'linear-gradient(165deg, #211d54 0%, #111536 60%, #0b0f26 100%)'
const CARD = '#14173a', BORDER = 'rgba(99,102,241,0.28)'
const INK = '#e6e9f7', BODY = '#c3c9e8', MUT = '#7c85ad', SUB = '#9aa3c4'
const INDIGO = '#818cf8', GOOD = '#34d399', BAD = '#fb7185', WARN = '#fbbf24', GREY = '#64748b'

const h = (type: string, style: any, children?: any) => ({ type, props: children !== undefined ? { style, children } : { style } })
const ascii = (s: any) => String(s ?? '').replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim()

type Tile = { n: string | number; pct?: string; label: string; sub?: string; tone?: string }

// '' is the DEFAULT rail, and it is indigo on screen — INK made every neutral tile look
// alarming, like a black bar across the top of half the report.
const TONE: Record<string, string> = { good: GOOD, bad: BAD, warn: WARN, mute: GREY, '': INDIGO }

// One tile: a big figure, its share, its name — the same object the page draws.
function tile(t: Tile, w: number) {
  const colour = TONE[t.tone || ''] ?? INK
  const kids: any[] = [
    h('div', { display: 'flex', flexDirection: 'row', alignItems: 'baseline' }, [
      h('div', { display: 'flex', fontSize: 30, fontWeight: 700, color: t.tone ? colour : INK, lineHeight: 1 }, ascii(t.n)),
      ...(t.pct ? [h('div', { display: 'flex', fontSize: 14, fontWeight: 700, color: MUT, marginLeft: 7 }, ascii(t.pct))] : []),
    ]),
    h('div', { display: 'flex', fontSize: 13.5, color: SUB, marginTop: 7, lineHeight: 1.3 }, ascii(t.label)),
  ]
  if (t.sub) kids.push(h('div', { display: 'flex', fontSize: 11.5, color: MUT, marginTop: 5, lineHeight: 1.3 }, ascii(t.sub)))
  // the 3px accent rail, exactly as the KPI cards carry on screen
  return h('div', {
    display: 'flex', flexDirection: 'column', width: w, backgroundColor: CARD,
    border: `1px solid ${BORDER}`, borderTop: `3px solid ${colour}`, borderRadius: 12,
    paddingLeft: 15, paddingRight: 15, paddingTop: 13, paddingBottom: 15,
  }, kids)
}

function tileRow(items: Tile[], innerW: number, perRow: number, gap = 12) {
  const w = Math.floor((innerW - gap * (perRow - 1)) / perRow)
  const rows: any[] = []
  for (let i = 0; i < items.length; i += perRow) {
    const slice = items.slice(i, i + perRow)
    rows.push(h('div', { display: 'flex', flexDirection: 'row', gap, marginTop: i ? gap : 0 },
      slice.map((t) => tile(t, w))))
  }
  return h('div', { display: 'flex', flexDirection: 'column' }, rows)
}

const heading = (text: string, top = 26) =>
  h('div', { display: 'flex', fontSize: 17, fontWeight: 700, color: INK, marginTop: top, marginBottom: 12 }, ascii(text))

const subHeading = (text: string) =>
  h('div', { display: 'flex', fontSize: 11.5, fontWeight: 700, color: MUT, marginTop: 16, marginBottom: 9, letterSpacing: 0.6 }, ascii(text).toUpperCase())

Deno.serve(async (req) => {
  try {
    const p = await req.json().catch(() => ({}))
    const label = ascii(p?.label || '')
    const kpis: Tile[] = Array.isArray(p?.kpis) ? p.kpis : []
    const funnel: Tile[] = Array.isArray(p?.funnel) ? p.funnel : []
    const answered: Tile[] = Array.isArray(p?.answered) ? p.answered : []
    const silent: Tile[] = Array.isArray(p?.silent) ? p.silent : []
    const byType: Tile[] = Array.isArray(p?.by_type) ? p.by_type : []
    const headline = ascii(p?.headline || '')
    const answeredLabel = ascii(p?.answered_label || 'Of the answered calls')
    const silentLabel = ascii(p?.silent_label || 'Nobody spoke')
    if (!kpis.length) return new Response(JSON.stringify({ error: 'kpis required' }), { status: 400 })

    const PAD = 44, width = 1440, innerW = width - PAD * 2

    // 3 across for the KPI block (user, 2026-09-09). Eight tiles land as 3 / 3 / 2, and that last row
    // is exactly the two averages - a semantic group, not a ragged remainder.
    const kpiPerRow = 3, funnelPerRow = 5, outPerRow = 5, typePerRow = 3
    const rowsOf = (n: number, per: number) => Math.max(1, Math.ceil(n / per))

    const body: any[] = [
      h('div', { display: 'flex', fontSize: 27, fontWeight: 700, color: INK }, `Call Insights - ${label}`),
      h('div', { display: 'flex', fontSize: 13.5, color: MUT, marginTop: 6 }, ascii(p?.subtitle || 'AI calls only')),
      ...(headline ? [h('div', {
        display: 'flex', fontSize: 15, color: BODY, lineHeight: 1.45, marginTop: 18, marginBottom: 4,
        backgroundColor: CARD, border: `1px solid ${BORDER}`, borderRadius: 12,
        paddingLeft: 16, paddingRight: 16, paddingTop: 13, paddingBottom: 13,
      }, headline)] : []),
      heading('The day in numbers', 20),
      tileRow(kpis, innerW, kpiPerRow),
      heading('Where the calls went'),
      tileRow(funnel, innerW, funnelPerRow),
      heading('Outcomes'),
      subHeading(answeredLabel),
      tileRow(answered, innerW, outPerRow),
      ...(silent.length ? [subHeading(silentLabel), tileRow(silent, innerW, outPerRow)] : []),
      ...(byType.length ? [heading('By call type'), tileRow(byType, innerW, typePerRow)] : []),
    ]

    // Satori needs an explicit height, and a short one CLIPS silently — budget from the real row counts
    // rather than a guess, then add a floor so a thin day still looks composed.
    const TILE_H = 104, TYPE_H = 104, GAP = 12, HEAD_H = 46, SUBHEAD_H = 32
    const block = (n: number, per: number, hh = TILE_H) => rowsOf(n, per) * hh + (rowsOf(n, per) - 1) * GAP
    const height = PAD * 2 + 58 + (headline ? 70 : 0)
      + HEAD_H + block(kpis.length, kpiPerRow)
      + HEAD_H + block(funnel.length, funnelPerRow)
      + HEAD_H + SUBHEAD_H + block(answered.length, outPerRow)
      + (silent.length ? SUBHEAD_H + block(silent.length, outPerRow) : 0)
      + (byType.length ? HEAD_H + block(byType.length, typePerRow, TYPE_H) : 0)
      + 10

    const [reg, bold] = await Promise.all([
      fetch('https://cdn.jsdelivr.net/npm/@fontsource/roboto@5.0.8/files/roboto-latin-400-normal.woff').then((r) => r.arrayBuffer()),
      fetch('https://cdn.jsdelivr.net/npm/@fontsource/roboto@5.0.8/files/roboto-latin-700-normal.woff').then((r) => r.arrayBuffer()),
    ])
    const fonts = [
      { name: 'Roboto', data: reg, weight: 400, style: 'normal' },
      { name: 'Roboto', data: bold, weight: 700, style: 'normal' },
    ] as any

    const root = h('div', {
      display: 'flex', flexDirection: 'column', width: '100%',
      // backgroundColor stays as the floor: if Satori ever declines the gradient the page is still dark,
      // rather than white text on white.
      backgroundColor: BG, backgroundImage: BG_GRAD,
      padding: PAD, fontFamily: 'Roboto', color: INK,
    }, body)

    const svg = await satori(root as any, { width, height, fonts })
    await ensureWasm()
    const png = new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng()

    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    // ⚠️ NAMED FOR THE DAY REPORTED, NOT THE DAY RENDERED. The schedule moved to 08:00 covering
    // YESTERDAY (2026-09-09), so the render date and the reported date are now DIFFERENT dates - using
    // 'today' here would file every morning's report under the wrong name and, worse, overwrite the
    // report for a day that had not happened yet. `label` is the reported date; today is only a floor
    // for a caller that sends none.
    const day = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(label)
      ? label
      : new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10)
    const path = `ai-calls/insights-${day}.png`
    const { error: upErr } = await sb.storage.from('reports')
      .upload(path, new Blob([png], { type: 'image/png' }), { contentType: 'image/png', upsert: true })
    if (upErr) throw new Error('storage upload: ' + upErr.message)
    const { data: pub } = sb.storage.from('reports').getPublicUrl(path)
    // cache-buster: the path is stable per day and Teams caches aggressively, so a re-send at 20:15
    // after a manual 13:00 run would otherwise show the morning's figures.
    return new Response(JSON.stringify({ ok: true, image_url: `${pub.publicUrl}?t=${Date.now()}`, width, height }),
      { headers: { 'Content-Type': 'application/json' } })
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as any)?.message || e) }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
})
