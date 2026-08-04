// inventory-doi-image-teams — renders the daily Inventory & Reorder PNG (Satori JSX→SVG + resvg-wasm
// SVG→PNG), uploads it to the public Supabase Storage bucket `reports`, and RETURNS the public URL +
// stats. The ecom-central backend (app/api/inventory.js → sendInventoryTeamsReport) embeds it in a Teams card.
//
// Kept SEPARATE from `inventory-doi-image` (owned by the standalone Lovable app, posts to Slack) so a
// Lovable republish can't clobber it. Version-controlled in the ecom-central repo; deploy via Supabase MCP/CLI.
//
// 2026-08-04 rewrite, per the user:
//   • SHIFUPRO ONLY — DP Bangalore is DocPharma's stock held on our behalf and reconciled separately.
//     Including it double-counted the same 17 SKUs and skewed every number.
//   • EVERY SKU — not just those under threshold. You cannot plan a purchase order from a list that
//     hides the healthy items.
//   • Cover bands 20/30/45 on a 30d DRR. The image is the STOCK picture only — order quantities go in
//     the Teams card below it, where the case arithmetic can be laid out as a real table.
//   • Reads `inventory_snapshots` + `sku_case_size` directly rather than the inventory_doi_low RPC — the
//     RPC filters by threshold, uses a 7d lookback and knows nothing about case sizes.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'
import satori from 'https://esm.sh/satori@0.10.13'
import { Resvg, initWasm } from 'https://esm.sh/@resvg/resvg-wasm@2.6.2'

let wasmReady = false
async function ensureWasm() {
  if (!wasmReady) { await initWasm(fetch('https://unpkg.com/@resvg/resvg-wasm@2.6.2/index_bg.wasm')); wasmReady = true }
}

const SHIFUPRO_LOC = 'wo66194027524'   // our own warehouse; the only stock this report covers
const PLACE_ORDER_DOI = 20             // 20d cover or less → order now
const WARNING_DOI = 30                 // 30d cover or less → warning
const TARGET_COVER = 45                // order up to 45 days of cover
const LOOKBACK = 30                    // DRR window — steadier than 7d for a 45-day horizon

const BG = '#0f1117', HEAD = '#222838', BORDER = '#2a3142', ZEBRA = '#151824'
const TXT = '#e6e8ee', MUT = '#9aa3b2'
const RED = '#ff5470', ORANGE = '#ff9f43', GREEN = '#39d98a', BLUE = '#5b8def'
const h = (type: string, style: any, children?: any) => ({ type, props: children !== undefined ? { style, children } : { style } })

function istLabel(): string {
  const nowIst = new Date(Date.now() + 5.5 * 3600 * 1000)
  return nowIst.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })
}
function istDateStr(): string {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10)
}
function prettyName(s: string): string {
  s = (s || '').trim().replace(/\s+/g, ' ')
  return s.length > 40 ? s.slice(0, 39) + '…' : s
}
const nf = (n: number) => Math.round(n).toLocaleString('en-IN')

type Row = {
  sku: string; product_name: string; category: string; stock: number
  drr: number; doi: number | null; status: string
  caseSize: number | null; recommendQty: number; caseQty: number; orderUnits: number
}
function statusColor(st: string): string {
  if (st === 'Out of Stock' || st === 'Place Order') return RED
  if (st === 'Warning') return ORANGE
  if (st === 'Healthy') return GREEN
  if (st === 'Overstock') return BLUE
  return MUT   // No Sales
}

//              SKU  Product Stock  DRR   DOI  Status
const widths = [132, 330, 96, 104, 88, 140]
const headers = ['SKU', 'Product', 'Stock', `DRR/${LOOKBACK}d`, 'DOI', 'Status']
const rowH = 38

function cell(txt: string, w: number, i: number, opts: any = {}) {
  const left = i <= 1
  return h('div', {
    display: 'flex', width: w, height: rowH, alignItems: 'center',
    justifyContent: opts.center ? 'center' : (left ? 'flex-start' : 'flex-end'),
    paddingLeft: 12, paddingRight: 12, fontSize: 15, borderBottom: `1px solid ${BORDER}`,
    color: opts.color || TXT, fontWeight: opts.bold ? 700 : 400, backgroundColor: opts.bg || 'transparent',
  }, txt)
}
function headerRow() {
  return h('div', { display: 'flex', flexDirection: 'row' },
    headers.map((hh, i) => cell(hh, widths[i], i, { bold: true, bg: HEAD, color: MUT, center: i === 5 })))
}
function badge(st: string, bg: string) {
  const c = statusColor(st)
  return h('div', { display: 'flex', width: widths[5], height: rowH, alignItems: 'center', justifyContent: 'center', borderBottom: `1px solid ${BORDER}`, backgroundColor: bg }, [
    h('div', { display: 'flex', alignItems: 'center', paddingLeft: 10, paddingRight: 10, paddingTop: 3, paddingBottom: 3, borderRadius: 12, fontSize: 12, fontWeight: 700, color: '#0f1117', backgroundColor: c }, st),
  ])
}
function dataRow(r: Row, zebra: boolean) {
  const bg = zebra ? ZEBRA : 'transparent'
  const sc = statusColor(r.status)
  return h('div', { display: 'flex', flexDirection: 'row' }, [
    cell(r.sku, widths[0], 0, { bg, bold: true }),
    cell(prettyName(r.product_name), widths[1], 1, { bg, color: MUT }),
    cell(nf(r.stock), widths[2], 2, { bg, color: r.stock <= 0 ? RED : TXT, bold: r.stock <= 0 }),
    cell(r.drr.toFixed(2), widths[3], 3, { bg, color: MUT }),
    cell(r.doi === null ? '—' : r.doi.toFixed(1) + 'd', widths[4], 4, { bg, color: sc, bold: true }),
    badge(r.status, bg),
  ])
}

Deno.serve(async () => {
  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    const { data: latest, error: dErr } = await sb.from('inventory_snapshots')
      .select('snapshot_date').order('snapshot_date', { ascending: false }).limit(1).maybeSingle()
    if (dErr) throw new Error('snapshot date: ' + dErr.message)
    if (!latest) throw new Error('no inventory snapshot found')

    // EVERY SKU at Shifupro (paginate past Supabase's hard 1000-row response cap)
    const snap: any[] = []
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from('inventory_snapshots')
        .select('sku, product_name, category, warehouse, available_quantity, units_sold_30d')
        .eq('snapshot_date', latest.snapshot_date).eq('location_id', SHIFUPRO_LOC)
        .order('sku', { ascending: true }).range(from, from + 999)
      if (error) throw new Error('snapshot rows: ' + error.message)
      // Drop the "N/A" warehouse placeholder rows — same guard the dashboard's loadLatestSnapshot uses.
      snap.push(...(data || []).filter((r: any) => r.warehouse && String(r.warehouse).trim().toUpperCase() !== 'N/A'))
      if (!data || data.length < 1000) break
    }

    const { data: caseData } = await sb.from('sku_case_size').select('sku, case_size')
    const caseMap = new Map<string, number>()
    for (const c of (caseData || [])) if (c.case_size > 0) caseMap.set(c.sku, Number(c.case_size))

    const rows: Row[] = snap.map((r: any) => {
      const stock = Number(r.available_quantity) || 0
      const sold = Number(r.units_sold_30d) || 0
      const drr = Math.round((sold / LOOKBACK) * 100) / 100
      const doi = drr > 0 ? Math.round((stock / drr) * 10) / 10 : null
      let status: string
      if (stock <= 0) status = 'Out of Stock'
      else if (drr <= 0) status = 'No Sales'
      else if ((doi as number) <= PLACE_ORDER_DOI) status = 'Place Order'
      else if ((doi as number) <= WARNING_DOI) status = 'Warning'
      else if ((doi as number) <= TARGET_COVER) status = 'Healthy'
      else status = 'Overstock'
      const recommendQty = Math.max(0, Math.ceil(drr * TARGET_COVER - stock))
      const caseSize = caseMap.get(r.sku) ?? null
      // Case Qty = how many CASES to order; Order Units = what that actually delivers.
      const caseQty = (caseSize && recommendQty > 0) ? Math.ceil(recommendQty / caseSize) : 0
      const orderUnits = caseSize ? caseQty * caseSize : recommendQty
      return { sku: r.sku, product_name: r.product_name, category: r.category, stock, drr, doi, status, caseSize, recommendQty, caseQty, orderUnits }
    })
    // most urgent first (lowest cover), healthy tail last
    rows.sort((a, b) => (a.doi === null ? 1e9 : a.doi) - (b.doi === null ? 1e9 : b.doi))

    const label = istLabel()
    const toOrder = rows.filter((r) => r.recommendQty > 0)
    const orderUnits = toOrder.reduce((s, r) => s + r.orderUnits, 0)
    const orderCases = toOrder.reduce((s, r) => s + r.caseQty, 0)
    const stockouts = rows.filter((r) => r.stock <= 0).length
    const placeOrder = rows.filter((r) => r.status === 'Place Order').length
    const warning = rows.filter((r) => r.status === 'Warning').length

    const bodyChildren: any[] = [headerRow()]
    rows.forEach((r, i) => bodyChildren.push(dataRow(r, i % 2 === 1)))
    const bodyRowCount = 1 + rows.length

    const table = h('div', { display: 'flex', flexDirection: 'column', borderRadius: 10, overflow: 'hidden', border: `1px solid ${BORDER}` }, bodyChildren)

    const width = widths.reduce((a, b) => a + b, 0) + 80
    const height = 40 + 36 + 8 + 20 + 8 + 18 + 16 + (rowH * bodyRowCount) + 8 + 40

    const [reg, bold] = await Promise.all([
      fetch('https://cdn.jsdelivr.net/npm/@fontsource/roboto@5.0.8/files/roboto-latin-400-normal.woff').then((r) => r.arrayBuffer()),
      fetch('https://cdn.jsdelivr.net/npm/@fontsource/roboto@5.0.8/files/roboto-latin-700-normal.woff').then((r) => r.arrayBuffer()),
    ])
    const root = h('div', { display: 'flex', flexDirection: 'column', width: '100%', height: '100%', backgroundColor: BG, padding: 40, fontFamily: 'Roboto', color: TXT }, [
      h('div', { display: 'flex', fontSize: 30, fontWeight: 700, color: TXT }, 'Inventory & Reorder — Shifupro'),
      h('div', { display: 'flex', fontSize: 15, color: GREEN, fontWeight: 700, marginTop: 8 },
        `The Element  ·  ${label}  ·  ${rows.length} SKUs  ·  ${placeOrder} place order  ·  ${warning} warning  ·  ${stockouts} out of stock`),
      // NB: no "≤" — the Roboto latin subset we load has no glyph for it and Satori renders a tofu box.
      h('div', { display: 'flex', fontSize: 12, color: MUT, marginTop: 6, marginBottom: 16 },
        `Place Order under ${PLACE_ORDER_DOI}d  ·  Warning under ${WARNING_DOI}d  ·  Healthy ${WARNING_DOI}-${TARGET_COVER}d  ·  Overstock over ${TARGET_COVER}d   |   order quantities in the message below`),
      table,
    ])
    const svg = await satori(root as any, { width, height, fonts: [{ name: 'Roboto', data: reg, weight: 400, style: 'normal' }, { name: 'Roboto', data: bold, weight: 700, style: 'normal' }] })
    await ensureWasm()
    const png = new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng()

    // Upload to the public `reports` bucket — one file per IST day (upsert overwrites same-day reruns).
    const path = `inventory-doi/${istDateStr()}.png`
    const { error: upErr } = await sb.storage.from('reports').upload(path, new Blob([png], { type: 'image/png' }), { contentType: 'image/png', upsert: true })
    if (upErr) throw new Error('storage upload: ' + upErr.message)
    const { data: pub } = sb.storage.from('reports').getPublicUrl(path)
    const image_url = `${pub.publicUrl}?t=${Date.now()}`

    return new Response(JSON.stringify({
      ok: true, image_url, label,
      rows: rows.length, placeOrder, warning, stockouts,
      critical: placeOrder, watch: warning,        // back-compat keys for the existing card
      toOrder: toOrder.length, orderUnits, orderCases,
      order: toOrder.map((r) => ({ sku: r.sku, recommendQty: r.recommendQty, caseSize: r.caseSize, caseQty: r.caseQty, orderUnits: r.orderUnits })),
      warehouses: [{ warehouse: 'Shifupro Technologies Pvt. Ltd.', count: rows.length, oos: stockouts }],
    }), { headers: { 'Content-Type': 'application/json' } })
  } catch (err) {
    console.error(err)
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
})
