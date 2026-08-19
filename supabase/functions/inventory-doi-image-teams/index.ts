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
//   • Cover bands 20/30/45 on a 7d DRR. The image is the STOCK picture only — order quantities go in
//     the Teams card below it, where the case arithmetic can be laid out as a real table.
//   • Reads `inventory_snapshots` + `sku_case_size` directly rather than the inventory_doi_low RPC — the
//     RPC filters by threshold and knows nothing about case sizes.
//
// 2026-08-19: also renders the RECOMMENDED ORDER as a second PNG when the caller posts `reorder: [...]`.
//   An Adaptive Card table cannot scroll and dies at phone width (ten columns → one-letter headers, five
//   columns → still truncated), so the order sheet becomes an image like the stock table above it —
//   full ten-column detail, and zoomable in Teams via the card's allowExpand. The ROWS COME FROM THE
//   CALLER, not from here: the open-PO subtraction lives in Node (EasyEcom lookups), and recomputing it
//   here would be a second copy of that rule waiting to drift. No payload → exactly the old behaviour.
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
const LOOKBACK = 7                     // DRR window — tracks current demand; drives DRR, DOI and the order qty

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

// ── Recommended Order table — second PNG, rows supplied by the caller ────────────────────────────
// Full detail deliberately: the whole point of moving off the card table is that an image has no width
// constraint, so nothing is grouped or dropped. ⚠️ Glyphs: the Roboto latin subset has no ✓ (U+2713) or
// ≤ (U+2264) — Satori renders tofu boxes — so covered rows read "on PO"; '×' (U+00D7) and '—' are safe.
type ReorderRow = {
  sku: string; stock: number; drr: number; doi: number | null
  raw_qty: number; open_po: number; net_qty: number
  case_size: number | null; cases: number; order_qty: number; poCovered: boolean
}
const roWidths = [132, 86, 96, 80, 130, 110, 110, 100, 84, 122]
const roHeaders = ['SKU', 'Stock', `DRR/${LOOKBACK}d`, 'DOI', 'Recommend', 'Raised PO', 'Final Qty', 'Case Size', 'Cases', 'Order Units']
function roCell(txt: string, w: number, first: boolean, opts: any = {}) {
  return h('div', {
    display: 'flex', width: w, height: rowH, alignItems: 'center',
    justifyContent: first ? 'flex-start' : 'flex-end',
    paddingLeft: 12, paddingRight: 12, fontSize: 15, borderBottom: `1px solid ${BORDER}`,
    color: opts.color || TXT, fontWeight: opts.bold ? 700 : 400, backgroundColor: opts.bg || 'transparent',
  }, txt)
}
function reorderTable(rows: ReorderRow[]) {
  const children: any[] = [h('div', { display: 'flex', flexDirection: 'row' },
    roHeaders.map((t, i) => roCell(t, roWidths[i], i === 0, { bold: true, bg: HEAD, color: MUT })))]
  rows.forEach((r, i) => {
    const bg = i % 2 === 1 ? ZEBRA : 'transparent'
    const doiTxt = r.doi == null ? '—' : r.doi.toFixed(1) + 'd'
    const urgent = r.doi != null && r.doi <= PLACE_ORDER_DOI
    children.push(h('div', { display: 'flex', flexDirection: 'row' }, [
      roCell(r.sku, roWidths[0], true, { bg, bold: true }),
      roCell(nf(r.stock), roWidths[1], false, { bg }),
      roCell(Number(r.drr || 0).toFixed(2), roWidths[2], false, { bg, color: MUT }),
      roCell(doiTxt, roWidths[3], false, { bg, color: urgent ? RED : ORANGE, bold: true }),
      roCell(nf(r.raw_qty), roWidths[4], false, { bg }),
      roCell(r.open_po ? nf(r.open_po) : '—', roWidths[5], false, { bg, color: MUT }),
      roCell(r.poCovered ? 'on PO' : nf(r.net_qty), roWidths[6], false, { bg, color: r.poCovered ? GREEN : TXT, bold: true }),
      roCell(r.case_size ? nf(r.case_size) : '—', roWidths[7], false, { bg, color: MUT }),
      roCell(r.poCovered ? '—' : (r.case_size ? nf(r.cases) : '—'), roWidths[8], false, { bg }),
      roCell(r.poCovered ? '—' : (r.case_size ? nf(r.order_qty) : nf(r.net_qty) + '*'), roWidths[9], false, { bg, bold: true }),
    ]))
  })
  const toOrder = rows.filter((r) => !r.poCovered)
  const tCases = toOrder.reduce((s, r) => s + (r.case_size ? Number(r.cases || 0) : 0), 0)
  const tUnits = toOrder.reduce((s, r) => s + (r.case_size ? Number(r.order_qty || 0) : Number(r.net_qty || 0)), 0)
  children.push(h('div', { display: 'flex', flexDirection: 'row' }, [
    roCell('TOTAL', roWidths[0], true, { bg: HEAD, bold: true }),
    ...[1, 2, 3, 4, 5, 6, 7].map((i) => roCell('', roWidths[i], false, { bg: HEAD })),
    roCell(nf(tCases), roWidths[8], false, { bg: HEAD, bold: true }),
    roCell(nf(tUnits), roWidths[9], false, { bg: HEAD, bold: true, color: GREEN }),
  ]))
  return { table: h('div', { display: 'flex', flexDirection: 'column', borderRadius: 10, overflow: 'hidden', border: `1px solid ${BORDER}` }, children), tCases, tUnits, nRows: rows.length + 2 }
}

Deno.serve(async (req: Request) => {
  try {
    // Optional caller payload — `reorder: ReorderRow[]` adds the second PNG. Absent/invalid → old behaviour.
    let payload: any = {}
    try { payload = await req.json() } catch (_) { /* GET or empty body */ }

    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    const { data: latest, error: dErr } = await sb.from('inventory_snapshots')
      .select('snapshot_date').order('snapshot_date', { ascending: false }).limit(1).maybeSingle()
    if (dErr) throw new Error('snapshot date: ' + dErr.message)
    if (!latest) throw new Error('no inventory snapshot found')

    // EVERY SKU at Shifupro (paginate past Supabase's hard 1000-row response cap)
    const snap: any[] = []
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from('inventory_snapshots')
        .select('sku, product_name, category, warehouse, available_quantity, units_sold_7d')
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
      const sold = Number(r.units_sold_7d) || 0
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

    // Fonts fetched ONCE, shared by both renders.
    const [reg, bold] = await Promise.all([
      fetch('https://cdn.jsdelivr.net/npm/@fontsource/roboto@5.0.8/files/roboto-latin-400-normal.woff').then((r) => r.arrayBuffer()),
      fetch('https://cdn.jsdelivr.net/npm/@fontsource/roboto@5.0.8/files/roboto-latin-700-normal.woff').then((r) => r.arrayBuffer()),
    ])
    const fonts = [{ name: 'Roboto', data: reg, weight: 400, style: 'normal' }, { name: 'Roboto', data: bold, weight: 700, style: 'normal' }]
    const root = h('div', { display: 'flex', flexDirection: 'column', width: '100%', height: '100%', backgroundColor: BG, padding: 40, fontFamily: 'Roboto', color: TXT }, [
      h('div', { display: 'flex', fontSize: 30, fontWeight: 700, color: TXT }, 'Inventory & Reorder — Shifupro'),
      h('div', { display: 'flex', fontSize: 15, color: GREEN, fontWeight: 700, marginTop: 8 },
        `The Element  ·  ${label}  ·  ${rows.length} SKUs  ·  ${placeOrder} place order  ·  ${warning} warning  ·  ${stockouts} out of stock`),
      // NB: no "≤" — the Roboto latin subset we load has no glyph for it and Satori renders a tofu box.
      h('div', { display: 'flex', fontSize: 12, color: MUT, marginTop: 6, marginBottom: 16 },
        `Place Order under ${PLACE_ORDER_DOI}d  ·  Warning under ${WARNING_DOI}d  ·  Healthy ${WARNING_DOI}-${TARGET_COVER}d  ·  Overstock over ${TARGET_COVER}d   |   order quantities in the message below`),
      table,
    ])
    const svg = await satori(root as any, { width, height, fonts })
    await ensureWasm()
    const png = new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng()

    // Upload to the public `reports` bucket — one file per IST day (upsert overwrites same-day reruns).
    const path = `inventory-doi/${istDateStr()}.png`
    const { error: upErr } = await sb.storage.from('reports').upload(path, new Blob([png], { type: 'image/png' }), { contentType: 'image/png', upsert: true })
    if (upErr) throw new Error('storage upload: ' + upErr.message)
    const { data: pub } = sb.storage.from('reports').getPublicUrl(path)
    const image_url = `${pub.publicUrl}?t=${Date.now()}`

    // ── Second PNG: the Recommended Order sheet, when the caller sent rows. A failure here must not
    // sink the report — the caller falls back to its card table when this URL is absent.
    let reorder_image_url: string | null = null
    if (Array.isArray(payload?.reorder) && payload.reorder.length) {
      try {
        const { table: roTable, tCases, tUnits, nRows } = reorderTable(payload.reorder as ReorderRow[])
        const roWidth = roWidths.reduce((a, b) => a + b, 0) + 80
        const roHeight = 40 + 36 + 8 + 20 + 16 + (rowH * nRows) + 8 + 40
        const roRoot = h('div', { display: 'flex', flexDirection: 'column', width: '100%', height: '100%', backgroundColor: BG, padding: 40, fontFamily: 'Roboto', color: TXT }, [
          h('div', { display: 'flex', fontSize: 30, fontWeight: 700, color: TXT }, 'Recommended Order — Shifupro'),
          h('div', { display: 'flex', fontSize: 15, color: GREEN, fontWeight: 700, marginTop: 8, marginBottom: 16 },
            `${label}  ·  ${payload.reorder.length} SKUs short  ·  order ${nf(tCases)} cases = ${nf(tUnits)} units  ·  Final Qty "on PO" = already covered by an open PO`),
          roTable,
        ])
        const roSvg = await satori(roRoot as any, { width: roWidth, height: roHeight, fonts })
        const roPng = new Resvg(roSvg, { fitTo: { mode: 'width', value: roWidth } }).render().asPng()
        const roPath = `inventory-reorder/${istDateStr()}.png`
        const { error: roErr } = await sb.storage.from('reports').upload(roPath, new Blob([roPng], { type: 'image/png' }), { contentType: 'image/png', upsert: true })
        if (roErr) throw new Error('storage upload (reorder): ' + roErr.message)
        const { data: roPub } = sb.storage.from('reports').getPublicUrl(roPath)
        reorder_image_url = `${roPub.publicUrl}?t=${Date.now()}`
      } catch (e) {
        console.error('reorder image failed (report continues without it):', e)
      }
    }

    return new Response(JSON.stringify({
      ok: true, image_url, reorder_image_url, label,
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
