// inventory-doi-image-teams — renders the SAME "Low Inventory (DOI < 30d)" PNG as `inventory-doi-image`
// (Satori JSX→SVG + resvg-wasm SVG→PNG), but instead of posting to Slack it uploads the PNG to the public
// Supabase Storage bucket `reports` and RETURNS the public URL + stats. The ecom-central backend
// (app/api/inventory.js → sendInventoryTeamsReport) calls this, then embeds the image in a Teams card.
//
// Kept SEPARATE from `inventory-doi-image` (which is owned by the standalone Lovable app and posts to Slack)
// so a Lovable republish can't clobber it. Uses the same RPC `inventory_doi_low(threshold, lookback_days)`.
// Version-controlled here in the ecom-central repo; deploy with the Supabase MCP / CLI.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'
import satori from 'https://esm.sh/satori@0.10.13'
import { Resvg, initWasm } from 'https://esm.sh/@resvg/resvg-wasm@2.6.2'

let wasmReady = false
async function ensureWasm() {
  if (!wasmReady) { await initWasm(fetch('https://unpkg.com/@resvg/resvg-wasm@2.6.2/index_bg.wasm')); wasmReady = true }
}

const THRESHOLD = 30
const LOOKBACK = 7
const BG = '#0f1117', HEAD = '#222838', SECTION = '#1f2a44', BORDER = '#2a3142'
const TXT = '#e6e8ee', MUT = '#9aa3b2'
const RED = '#ff5470', ORANGE = '#ff9f43', YELLOW = '#ffd166', GREEN = '#39d98a'
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
  if (s.length > 46) s = s.slice(0, 45) + '…'
  return s
}
function statusColor(st: string): string {
  if (st === 'Out of Stock' || st === 'Critical') return RED
  if (st === 'Warning') return ORANGE
  if (st === 'Watch') return YELLOW
  return GREEN
}

type Row = { location_id: string; warehouse: string; sku: string; product_name: string; category: string; available_quantity: number; drr: number; doi: number | null; status: string }

const widths = [115, 350, 110, 80, 95, 80, 130]
const headers = ['SKU', 'Product', 'Category', 'Stock', `DRR/${LOOKBACK}d`, 'DOI', 'Status']
const rowH = 38

function cell(txt: string, w: number, i: number, opts: any = {}) {
  const left = i <= 2
  return h('div', { display: 'flex', width: w, height: rowH, alignItems: 'center', justifyContent: opts.center ? 'center' : (left ? 'flex-start' : 'flex-end'), paddingLeft: 12, paddingRight: 12, fontSize: 15, borderBottom: `1px solid ${BORDER}`, color: opts.color || TXT, fontWeight: opts.bold ? 700 : 400, backgroundColor: opts.bg || 'transparent' }, txt)
}
function headerRow() {
  return h('div', { display: 'flex', flexDirection: 'row' }, headers.map((hh, i) => cell(hh, widths[i], i, { bold: true, bg: HEAD, color: MUT, center: i === 6 })))
}
function sectionRow(label: string) {
  const total = widths.reduce((a, b) => a + b, 0)
  return h('div', { display: 'flex', flexDirection: 'row' }, [
    h('div', { display: 'flex', width: total, height: rowH, alignItems: 'center', paddingLeft: 12, fontSize: 16, fontWeight: 700, color: TXT, backgroundColor: SECTION, borderBottom: `1px solid ${BORDER}` }, label),
  ])
}
function badge(st: string) {
  const c = statusColor(st)
  return h('div', { display: 'flex', width: widths[6], height: rowH, alignItems: 'center', justifyContent: 'center', borderBottom: `1px solid ${BORDER}` }, [
    h('div', { display: 'flex', alignItems: 'center', paddingLeft: 12, paddingRight: 12, paddingTop: 4, paddingBottom: 4, borderRadius: 12, fontSize: 13, fontWeight: 700, color: '#0f1117', backgroundColor: c }, st),
  ])
}
function dataRow(r: Row) {
  const stockTxt = r.available_quantity <= 0 ? '0' : Math.round(r.available_quantity).toLocaleString('en-IN')
  const doiTxt = r.doi === null ? '—' : r.doi.toFixed(1)
  const sc = statusColor(r.status)
  return h('div', { display: 'flex', flexDirection: 'row' }, [
    cell(r.sku, widths[0], 0),
    cell(prettyName(r.product_name), widths[1], 1),
    cell(r.category || '—', widths[2], 2, { color: MUT }),
    cell(stockTxt, widths[3], 3, { color: r.available_quantity <= 0 ? RED : TXT, bold: r.available_quantity <= 0 }),
    cell(r.drr.toFixed(1), widths[4], 4, { color: MUT }),
    cell(doiTxt, widths[5], 5, { color: sc, bold: true }),
    badge(r.status),
  ])
}

Deno.serve(async () => {
  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    const { data: rpcData, error: rpcErr } = await sb.rpc('inventory_doi_low', { threshold: THRESHOLD, lookback_days: LOOKBACK })
    if (rpcErr) throw new Error('doi rpc: ' + rpcErr.message)
    const rows = (rpcData || []).map((r: any) => ({
      location_id: r.location_id, warehouse: r.warehouse, sku: r.sku, product_name: r.product_name, category: r.category,
      available_quantity: Number(r.available_quantity), drr: Number(r.drr), doi: r.doi === null ? null : Number(r.doi), status: r.status,
    }))
      // Drop phantom/unmapped locations (warehouse 'N/A') — location_id is a bare warehouse name or an
      // unmapped Amazon FBA code, so they carry stray sales but no stock/product metadata. Not real inventory.
      .filter((r: any) => r.warehouse && String(r.warehouse).trim().toUpperCase() !== 'N/A') as Row[]

    const label = istLabel()
    const byWh = new Map<string, Row[]>()
    for (const r of rows) { if (!byWh.has(r.warehouse)) byWh.set(r.warehouse, []); byWh.get(r.warehouse)!.push(r) }
    const stockouts = rows.filter((r) => r.available_quantity <= 0).length
    const critical = rows.filter((r) => r.status === 'Critical').length
    const watch = rows.filter((r) => r.status === 'Watch').length
    const warehouses = [...byWh.entries()].map(([wh, list]) => ({ warehouse: wh, count: list.length, oos: list.filter((r) => r.available_quantity <= 0).length }))

    const bodyChildren: any[] = []
    let bodyRowCount = 0
    if (rows.length === 0) {
      bodyChildren.push(headerRow())
      bodyChildren.push(h('div', { display: 'flex', height: rowH, alignItems: 'center', paddingLeft: 12, fontSize: 15, color: GREEN, borderBottom: `1px solid ${BORDER}` }, `All SKUs healthy — no item under ${THRESHOLD} days of inventory at either location.`))
      bodyRowCount = 1
    } else {
      for (const [wh, list] of byWh) {
        const oos = list.filter((r) => r.available_quantity <= 0).length
        bodyChildren.push(sectionRow(`${wh}  ·  ${list.length} need attention  (${oos} out of stock)`))
        bodyChildren.push(headerRow())
        for (const r of list) bodyChildren.push(dataRow(r))
        bodyRowCount += 2 + list.length
      }
    }
    const table = h('div', { display: 'flex', flexDirection: 'column', borderRadius: 10, overflow: 'hidden', border: `1px solid ${BORDER}` }, bodyChildren)

    const width = widths.reduce((a, b) => a + b, 0) + 80
    const height = 40 + 30 + 8 + 18 + 8 + 16 + 18 + (rowH * bodyRowCount) + 40 + 28

    const [reg, bold] = await Promise.all([
      fetch('https://cdn.jsdelivr.net/npm/@fontsource/roboto@5.0.8/files/roboto-latin-400-normal.woff').then((r) => r.arrayBuffer()),
      fetch('https://cdn.jsdelivr.net/npm/@fontsource/roboto@5.0.8/files/roboto-latin-700-normal.woff').then((r) => r.arrayBuffer()),
    ])
    const root = h('div', { display: 'flex', flexDirection: 'column', width: '100%', height: '100%', backgroundColor: BG, padding: 40, fontFamily: 'Roboto', color: TXT }, [
      h('div', { display: 'flex', fontSize: 28, fontWeight: 700, color: TXT }, `Low Inventory — Days of Inventory (DOI) < ${THRESHOLD} days`),
      h('div', { display: 'flex', fontSize: 15, color: GREEN, fontWeight: 700, marginTop: 8 }, `The Element  ·  ${label}  ·  ${rows.length} SKU×location  ·  ${critical} critical  ·  ${watch} watch  ·  ${stockouts} out of stock`),
      h('div', { display: 'flex', fontSize: 12, color: MUT, marginTop: 4, marginBottom: 16 }, `DRR = avg units/day over last ${LOOKBACK}d (EasyEcom, per location)  |  DOI = stock ÷ DRR  |  Critical ≤ 7d (red)  ·  Warning ≤ 15d (orange)  ·  Watch ≤ ${THRESHOLD}d (yellow)  ·  Out of Stock = 0 units`),
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
    // ?t= cache-buster so Teams always fetches the fresh render even when the path is reused within a day.
    const image_url = `${pub.publicUrl}?t=${Date.now()}`

    return new Response(JSON.stringify({ ok: true, image_url, label, rows: rows.length, critical, watch, stockouts, warehouses }), { headers: { 'Content-Type': 'application/json' } })
  } catch (err) {
    console.error(err)
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
})
