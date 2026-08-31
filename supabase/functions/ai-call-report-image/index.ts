// ai-call-report-image — renders the AI Calling Report's order-detail table as a PNG (Satori
// JSX→SVG + resvg-wasm SVG→PNG), uploads it to the public `reports` bucket and returns the URL.
// Exists because a Teams Adaptive Card table cannot scroll and shatters on mobile (2026-08-31:
// five columns rendered one letter per line on the phone app) — an image scales to the screen and
// pinch-zooms. Caller: app/api/ai_call_report.js (falls back to its 2-column card table when this
// errors, so a render failure can never sink the report). Same machinery as inventory-doi-image-teams.
// ⚠ Glyphs: the Roboto latin subset has no ₹ or emoji — amounts say "Rs", outcomes are colored
// text badges, and non-latin quote characters are stripped (call summaries are English by prompt).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'
import satori from 'https://esm.sh/satori@0.10.13'
import { Resvg, initWasm } from 'https://esm.sh/@resvg/resvg-wasm@2.6.2'

let wasmReady = false
async function ensureWasm() {
  if (!wasmReady) { await initWasm(fetch('https://unpkg.com/@resvg/resvg-wasm@2.6.2/index_bg.wasm')); wasmReady = true }
}

const BG = '#0f1117', HEAD = '#222838', BORDER = '#2a3142', ZEBRA = '#151824'
const TXT = '#e6e8ee', MUT = '#9aa3b2'
const GREEN = '#39d98a', RED = '#ff5470', ORANGE = '#ff9f43', VIOLET = '#a78bfa', BLUE = '#5b8def'
const h = (type: string, style: any, children?: any) => ({ type, props: children !== undefined ? { style, children } : { style } })

type Row = { order: string; amount: number; tries: number; outcome: string; said: string }
const OUTCOME: Record<string, { label: string; color: string }> = {
  confirmed: { label: 'CONFIRMED', color: GREEN },
  denied: { label: 'DENIED', color: RED },
  unclear: { label: 'NOT CONFIRMED', color: ORANGE },
  no_answer: { label: 'NO ANSWER', color: VIOLET },
  retrying: { label: 'RETRYING', color: BLUE },
}
const latin = (s: string) => String(s || '').replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim()
const nf = (n: number) => Math.round(n || 0).toLocaleString('en-IN')

//              Order  Amount  Tries  Outcome  Customer said
const widths = [150, 110, 70, 180, 430]
const headers = ['Order', 'Amount (Rs)', 'Tries', 'Outcome', 'Customer said']
const rowH = 54

function cell(txt: string, w: number, opts: any = {}) {
  return h('div', {
    display: 'flex', width: w, minHeight: rowH, alignItems: 'center',
    justifyContent: opts.right ? 'flex-end' : (opts.center ? 'center' : 'flex-start'),
    paddingLeft: 12, paddingRight: 12, paddingTop: 6, paddingBottom: 6,
    fontSize: opts.small ? 13.5 : 15, lineHeight: 1.35, borderBottom: `1px solid ${BORDER}`,
    color: opts.color || TXT, fontWeight: opts.bold ? 700 : 400, backgroundColor: opts.bg || 'transparent',
  }, txt)
}
function badgeCell(outcome: string, tries: number, bg: string) {
  const o = OUTCOME[outcome] || { label: latin(outcome).toUpperCase().slice(0, 14) || '—', color: MUT }
  const label = outcome === 'retrying' ? `RETRYING ${tries}/3` : o.label
  return h('div', { display: 'flex', width: widths[3], minHeight: rowH, alignItems: 'center', justifyContent: 'center', borderBottom: `1px solid ${BORDER}`, backgroundColor: bg }, [
    h('div', { display: 'flex', alignItems: 'center', paddingLeft: 10, paddingRight: 10, paddingTop: 3, paddingBottom: 3, borderRadius: 12, fontSize: 12, fontWeight: 700, color: '#0f1117', backgroundColor: o.color }, label),
  ])
}
function headerRow() {
  return h('div', { display: 'flex', flexDirection: 'row' },
    headers.map((t, i) => cell(t, widths[i], { bold: true, bg: HEAD, color: MUT, right: i === 1, center: i === 2 || i === 3 })))
}
function dataRow(r: Row, zebra: boolean) {
  const bg = zebra ? ZEBRA : 'transparent'
  return h('div', { display: 'flex', flexDirection: 'row' }, [
    cell(latin(r.order), widths[0], { bg, bold: true }),
    cell(nf(r.amount), widths[1], { bg, right: true }),
    cell(String(r.tries || 1), widths[2], { bg, center: true, color: MUT }),
    badgeCell(r.outcome, r.tries || 1, bg),
    cell(latin(r.said).slice(0, 160) || '—', widths[4], { bg, color: MUT, small: true }),
  ])
}

Deno.serve(async (req) => {
  try {
    const payload = await req.json().catch(() => ({}))
    const rows: Row[] = Array.isArray(payload?.rows) ? payload.rows : []
    if (!rows.length) return new Response(JSON.stringify({ error: 'rows required' }), { status: 400 })
    const label = latin(payload?.label || '')

    const bodyChildren: any[] = [headerRow()]
    rows.slice(0, 25).forEach((r, i) => bodyChildren.push(dataRow(r, i % 2 === 1)))
    const table = h('div', { display: 'flex', flexDirection: 'column', borderRadius: 10, overflow: 'hidden', border: `1px solid ${BORDER}` }, bodyChildren)

    const width = widths.reduce((a, b) => a + b, 0) + 80
    // rows can wrap to ~2 lines — budget generously; Satori clips nothing vertically at fitTo width.
    const height = 40 + 34 + 10 + 20 + (rowH + 26) * (1 + Math.min(rows.length, 25)) + 40

    const [reg, bold] = await Promise.all([
      fetch('https://cdn.jsdelivr.net/npm/@fontsource/roboto@5.0.8/files/roboto-latin-400-normal.woff').then((r) => r.arrayBuffer()),
      fetch('https://cdn.jsdelivr.net/npm/@fontsource/roboto@5.0.8/files/roboto-latin-700-normal.woff').then((r) => r.arrayBuffer()),
    ])
    const fonts = [{ name: 'Roboto', data: reg, weight: 400, style: 'normal' }, { name: 'Roboto', data: bold, weight: 700, style: 'normal' }] as any
    const root = h('div', { display: 'flex', flexDirection: 'column', width: '100%', backgroundColor: BG, padding: 40, fontFamily: 'Roboto', color: TXT }, [
      h('div', { display: 'flex', fontSize: 26, fontWeight: 700, color: TXT }, 'AI Calling — Order Detail'),
      h('div', { display: 'flex', fontSize: 14, color: GREEN, fontWeight: 700, marginTop: 8, marginBottom: 14 }, `The Element  ·  ${label}  ·  ${rows.length} order${rows.length === 1 ? '' : 's'} called`),
      table,
    ])
    const svg = await satori(root as any, { width, height, fonts })
    await ensureWasm()
    const png = new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng()

    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const path = `ai-calls/${new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10)}.png`
    const { error: upErr } = await sb.storage.from('reports').upload(path, new Blob([png], { type: 'image/png' }), { contentType: 'image/png', upsert: true })
    if (upErr) throw new Error('storage upload: ' + upErr.message)
    const { data: pub } = sb.storage.from('reports').getPublicUrl(path)
    return new Response(JSON.stringify({ image_url: `${pub.publicUrl}?t=${Date.now()}` }), { headers: { 'Content-Type': 'application/json' } })
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
})
