// easyecom-inventory-webhook — ingests EasyEcom inventory-movement webhooks into `inventory_movements_ecom`.
// Point EasyVMS triggers at this URL with a ?type= param:
//   GRN Details / Complete GRN        → ?type=grn
//   Inventory Adjustment V2 / Cycle Count / PutAway / RTV / QC Fail / Lot Locking / Move-to-Expired → ?type=adjustment
// (Payload shape is auto-detected too, so ?type is optional.) Feeds the Stock Count reconciliation's
// expected-on-hand + blocked-stock (non-Available status) buckets. verify_jwt must be OFF (public webhook);
// optional shared-secret via ?token= / x-webhook-token vs EE_INVENTORY_WEBHOOK_TOKEN.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'

const WAREHOUSE: Record<string, string> = {
  wo66194027524: 'Shifupro Technologies Pvt. Ltd.',
  ix73493041216: 'DP Bangalore',
}
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-webhook-token, content-type, apikey' }
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } })
const wh = (k: string) => WAREHOUSE[k] || k || null

function detectType(b: any): string {
  if (b?.grnId != null || b?.poNumber != null || b?.grnStatus != null) return 'grn'
  if (b?.adjustmentBatchCode != null || b?.cycleCountId != null || b?.items?.[0]?.adjustmentType != null) return 'adjustment'
  // Everything else (incl. Mark/Pending Return payloads on the base URL) → return. GRN & adjustment carry their
  // own signature fields (or an explicit ?type), so nothing else lands here by accident.
  return 'return'
}
function parseGrn(b: any) {
  const loc = b.location_key || b.locationKey
  return (b.items || []).map((i: any) => ({
    event_type: 'grn', occurred_at: b.grnCreatedAt || b.grnInvoiceDate || null,
    location_key: loc, warehouse: wh(loc), sku: i.sku, qty: Number(i.received_quantity) || 0,
    status: b.grnStatus, ref_type: 'grn', ref_id: String(b.grnId ?? ''), actor: null,
    raw: { grnId: b.grnId, poNumber: b.poNumber, poRefNum: b.poRefNum, grnPrice: i.grnPrice, mrp: i.mrp, product_name: i.product_name, cpId: i.cpId },
  }))
}
function parseReturn(b: any) {
  // Return payloads vary (Mark Return / Pending Return / Fetch Initiated Return) — field names are best-effort;
  // raw is kept so we can refine mapping once a real sample lands. A received return = +awaiting-putaway.
  const loc = b.location_key || b.locationKey || b.warehouseKey
  const items = b.items || b.returnItems || b.products || (b.sku ? [b] : [])
  return (items).map((i: any) => ({
    event_type: 'return', occurred_at: b.returnDate || b.createdAt || b.created_at || b.grnCreatedAt || i.returnDate || null,
    location_key: loc, warehouse: wh(loc), sku: i.sku || i.SKU || i.product_sku,
    qty: Number(i.quantity ?? i.qty ?? i.return_quantity ?? i.returnQuantity ?? i.received_quantity ?? 1) || 0,
    status: b.returnStatus || b.status || 'Pending Return', ref_type: 'return',
    ref_id: String(b.returnId ?? b.rmaId ?? b.orderId ?? b.reference_code ?? ''), actor: b.createdBy || null,
    raw: { returnType: b.returnType, reason: i.reason || b.reason, orderId: b.orderId, awb: b.awb, full: b },
  }))
}
function parseAdjustment(b: any) {
  const loc = b.locationKey || b.location_key
  return (b.items || []).map((i: any) => ({
    event_type: 'adjustment', occurred_at: i.adjustmentTime || b.ccCompletionDate || null,
    location_key: loc, warehouse: wh(loc), sku: i.sku, qty: Number(i.quantity) || 0,
    adjustment_type: i.adjustmentType, old_status: i.oldStatus, new_status: i.newStatus,
    old_bin: i.oldBin, new_bin: i.newBin, status: i.newStatus,
    ref_type: b.cycleCountId ? 'cycle_count' : 'adjustment_batch', ref_id: String(b.adjustmentBatchCode ?? b.cycleCountId ?? ''),
    actor: i.adjustmentAddedBy || b.createdBy || b.floorStaff,
    raw: { cpId: i.cpId, mrp: i.mrp, batchCode: i.batchCode, old_bin_zone: i.old_bin_zone, new_bin_zone: i.new_bin_zone, cycleCountId: b.cycleCountId, ccStatus: b.ccStatus },
  }))
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors })
  const url = new URL(req.url)
  if (url.searchParams.get('health')) return json({ ok: true, fn: 'easyecom-inventory-webhook' })
  try {
    const secret = Deno.env.get('EE_INVENTORY_WEBHOOK_TOKEN')
    if (secret) { const t = url.searchParams.get('token') || req.headers.get('x-webhook-token'); if (t !== secret) return json({ ok: false, error: 'unauthorized' }, 401) }
    const body = await req.json().catch(() => ({}))
    const type = (url.searchParams.get('type') || detectType(body)).toLowerCase()
    let rows: any[] = []
    if (type === 'grn') rows = parseGrn(body)
    else if (type === 'adjustment') rows = parseAdjustment(body)
    else if (type === 'return') rows = parseReturn(body)
    else return json({ ok: false, error: 'unknown event; pass ?type=grn | adjustment | return' }, 400)
    rows = rows.filter((r) => r.sku)
    if (rows.length) {
      const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })
      const { error } = await sb.from('inventory_movements_ecom').insert(rows)
      if (error) throw new Error(error.message)
    }
    return json({ ok: true, type, inserted: rows.length })
  } catch (err) {
    console.error('easyecom-inventory-webhook error:', err)
    return json({ ok: false, error: String(err) }, 500)
  }
})
