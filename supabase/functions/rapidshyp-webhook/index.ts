import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// HTTPS webhook receiver for RapidShyp → updates shipment_journey_ecom (the Delivery/Ops dashboards)
// in real time. RapidShyp requires an HTTPS endpoint; the Node app runs on plain HTTP, so this
// always-on Edge Function is what RapidShyp points at. It PORTS the Node parseRapidshypJourney()
// logic exactly (keep the two in sync when the parser changes).
//
// Auth: RapidShyp sends `Access-Token: <token>` (or ?token=). Accepts RAPIDSHYP_WEBHOOK_SECRET or 123456.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, access-token, x-webhook-secret, rapidshyp-token",
};

// ── scan phrase → event type (fallback when a scan has no canonical code) ──
function classifyScan(desc: string): string {
  const s = (desc || "").toLowerCase();
  if (!s) return "other";
  if (/\brto|return to origin|returned to|returned as per|reverse pickup|rto initiated/.test(s)) return "rto";
  if (/out for delivery|out for del/.test(s)) return "attempt";
  if (/\bdelivered\b|delivery successful|shipment delivered/.test(s)) return "delivered";
  if (/picked up|pickup done|pickup completed|shipment picked/.test(s)) return "pickup";
  if (/undeliver|not delivered|\bunavailable\b|not available|refus|reject|incomplete address|bad address|wrong address|address (issue|incorrect|problem)|establishment closed|premises closed|shop closed|door lock|\bndr\b|reattempt|re-?schedul|future delivery|no (client )?instruction|cod not ready|cash not ready|payment not ready|no response|not reachable|not responding|holiday|self ?collect|failed delivery|delivery failed/.test(s)) return "ndr";
  if (/shipment lost|\blost\b|lost in transit|untraceable/.test(s)) return "lost";
  return "other";
}

// ── RapidShyp canonical status codes (authoritative) ──
const CODE_LOST = new Set(["LST", "RLST", "RMSN", "DMG", "RDMG", "DPO", "RDPO"]);
const CODE_RTO = new Set(["RTO_REQ", "RTO", "RTO_INT", "RTO_RAD", "RTO_OFD", "RTO_DEL", "RTO_UND",
  "RSCB", "RPSH", "ROFP", "RPUE", "RPCN", "RPUC", "RSPD", "RINT", "RPAD", "RDED", "ROFD", "RDEL", "RUND", "RCAN", "RONH", "RMSR"]);
function codeEvent(code: string): string | null {
  const c = String(code || "").toUpperCase();
  if (!c || c === "NA") return null;
  if (c === "PUC") return "pickup";
  if (c === "OFD") return "attempt";
  if (c === "DEL") return "delivered";
  if (c === "UND") return "ndr";
  if (CODE_LOST.has(c)) return "lost";
  if (CODE_RTO.has(c)) return "rto";
  return "other";
}
function codeOutcome(code: string): string | null {
  const c = String(code || "").toUpperCase();
  if (c === "DEL") return "delivered";
  if (CODE_LOST.has(c)) return "lost";
  if (CODE_RTO.has(c)) return "rto";
  return null;
}

// ── zone (A–E) from destination state/city, origin Gurgaon/NCR ──
const ZONE_E = new Set(["jammu & kashmir", "jammu and kashmir", "j&k", "ladakh", "himachal pradesh", "assam", "meghalaya", "manipur", "mizoram", "nagaland", "tripura", "arunachal pradesh", "sikkim", "andaman & nicobar islands", "andaman and nicobar islands", "lakshadweep", "kerala"]);
const ZONE_B = new Set(["haryana", "delhi", "new delhi", "nct of delhi", "chandigarh"]);
const ZONE_C = new Set(["maharashtra", "karnataka", "tamil nadu", "telangana", "west bengal", "gujarat"]);
function zoneFromState(state: string, city: string): string | null {
  const s = String(state || "").trim().toLowerCase();
  const c = String(city || "").trim().toLowerCase();
  if (!s && !c) return null;
  if (c === "gurgaon" || c === "gurugram") return "A";
  if (ZONE_E.has(s)) return "E";
  if (ZONE_B.has(s)) return "B";
  if (ZONE_C.has(s)) return "C";
  return s ? "D" : null;
}

function parseScanDate(v: any): string | null {
  if (!v) return null;
  const s = String(v).trim();
  const m = s.match(/^(\d{2})-(\d{2})-(\d{4})[ T](\d{2}):(\d{2}):(\d{2})/);
  // RapidShyp scan times are IST wall-clock (no zone) → stamp +05:30 so it stores as the correct UTC instant.
  if (m) return `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}+05:30`;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// Faithful port of Node parseRapidshypJourney().
function parseRapidshypJourney(scans: any[], currentStatus: string, courier: string | null, zone: string | null, statusCode: string, edd: any) {
  const status = (currentStatus || "").toLowerCase();
  const evts = (scans || [])
    .map((s: any) => {
      const desc = s.scan || s.status_desc || s.status || s.activity || "";
      const byCode = codeEvent(s.rapidshyp_status_code);
      return { desc, at: parseScanDate(s.scan_datetime || s.date || s.timestamp || s.event_time), type: byCode || classifyScan(desc) };
    })
    .filter((e: any) => e.desc)
    .sort((a: any, b: any) => (a.at || "").localeCompare(b.at || ""));

  let attempts = 0, ndr_count = 0, outForDeliveryAt: any = null, deliveredAt: any = null, rtoAt: any = null, pickedUpAt: any = null, lostAt: any = null, seenOFD = false;
  const ndr_reasons: string[] = [];
  for (const e of evts) {
    if (e.type === "pickup") { if (!pickedUpAt) pickedUpAt = e.at; }
    else if (e.type === "attempt") { attempts++; seenOFD = true; if (!outForDeliveryAt) outForDeliveryAt = e.at; }
    else if (e.type === "ndr") { if (seenOFD) { ndr_count++; if (e.desc) ndr_reasons.push(e.desc); } }
    else if (e.type === "delivered" && !deliveredAt) deliveredAt = e.at;
    else if (e.type === "rto" && !rtoAt) rtoAt = e.at;
    else if (e.type === "lost" && !lostAt) lostAt = e.at;
  }
  const codeOut = codeOutcome(statusCode);
  const delivered = codeOut === "delivered" || !!deliveredAt || (/deliver/.test(status) && !/rto/.test(status));
  const rto = codeOut === "rto" || !!rtoAt || /\brto|return/.test(status);
  const lost = codeOut === "lost" || !!lostAt || /\blost\b/.test(status);
  const reached_delivery = seenOFD || delivered || /out for delivery/.test(status);
  const outcome = delivered ? "delivered" : rto ? "rto" : lost ? "lost" : (ndr_count > 0 ? "ndr_pending" : "in_transit");

  return {
    courier: courier || null, outcome,
    attempts: attempts || (delivered ? 1 : 0), ndr_count, reached_delivery,
    first_attempt_success: delivered && ndr_count === 0,
    ndr_reasons: [...new Set(ndr_reasons)].slice(0, 10),
    out_for_delivery_at: outForDeliveryAt, delivered_at: deliveredAt, rto_at: rtoAt,
    dispatched_at: pickedUpAt, zone: zone || null, status_code: statusCode || null,
    first_edd: parseScanDate(edd) || null,
    rto_no_attempt: rto && !seenOFD,
    is_final: delivered || rto || lost,
  };
}

function extractRecords(payload: any): any[] {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload.flatMap((p) => extractRecords(p));
  if (Array.isArray(payload.records)) return payload.records;
  if (Array.isArray(payload.data)) return payload.data;
  if (payload.data && typeof payload.data === "object" && Array.isArray(payload.data.records)) return payload.data.records;
  return [payload];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const url = new URL(req.url);
  if (req.method === "GET" && url.searchParams.get("health") === "1") {
    return new Response(JSON.stringify({ ok: true, function: "rapidshyp-webhook", ts: new Date().toISOString() }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  try {
    const expected = Deno.env.get("RAPIDSHYP_WEBHOOK_SECRET") || "123456";
    const authHeader = req.headers.get("authorization") || "";
    const provided = url.searchParams.get("token") || req.headers.get("access-token") || req.headers.get("rapidshyp-token")
      || req.headers.get("x-webhook-secret") || (authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader) || "";
    if (provided !== expected && provided !== "123456") {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const rawText = await req.text();
    let payload: any = {};
    try { payload = rawText ? JSON.parse(rawText) : {}; } catch (_e) { /* non-JSON */ }

    const records = extractRecords(payload);
    const now = new Date().toISOString();
    let updated = 0;
    const summary: string[] = [];

    for (const rec of records) {
      const sd = rec.shipment_details;
      const ship = Array.isArray(sd) && sd.length ? sd[0] : (sd && typeof sd === "object" ? sd : rec);
      const awb = ship.awb || rec.awb;
      if (!awb) continue;
      const orderName = String(rec.seller_order_id || rec.order_id || "").replace("#", "").trim() || null;
      const scans = ship.track_scans || ship.tracking_history || ship.tracking_events || rec.track_scans || [];
      const courier = ship.child_courier_name || ship.courier_name || null;
      const zone = zoneFromState(rec.shipping_state || ship.shipping_state || "", rec.shipping_city || ship.shipping_city || "");
      const j = parseRapidshypJourney(scans, ship.shipment_status || "", courier, zone,
        ship.current_tracking_status_code || "", ship.edd || ship.current_courier_edd);

      const row: Record<string, any> = {
        awb, order_name: orderName, source: "rapidshyp",
        courier: j.courier, outcome: j.outcome, attempts: j.attempts, ndr_count: j.ndr_count,
        reached_delivery: j.reached_delivery, first_attempt_success: j.first_attempt_success,
        ndr_reasons: j.ndr_reasons, out_for_delivery_at: j.out_for_delivery_at,
        delivered_at: j.delivered_at, rto_at: j.rto_at, rto_no_attempt: !!j.rto_no_attempt,
        is_final: j.is_final, updated_at: now,
      };
      // Conditional (never wipe preserved/other-sourced fields): payment_mode, order_type, order_date are omitted on purpose.
      if (j.status_code) row.status_code = j.status_code;
      if (j.first_edd) row.first_edd = j.first_edd;        // DB trigger keeps the earliest
      if (j.dispatched_at) row.dispatched_at = j.dispatched_at;
      if (j.zone) row.zone = j.zone;

      const { error } = await supabase.from("shipment_journey_ecom").upsert(row, { onConflict: "awb" });
      if (error) { console.error(`[rapidshyp-webhook] journey upsert ${awb}: ${error.message}`); continue; }

      // Keep the status cache + the enriched flag fresh (so webhook health is visible).
      await supabase.from("rapidshyp_tracking_ecom").upsert(
        { awb, raw_status: ship.shipment_status || null, last_checked: Date.now() / 1000, updated_at: now }, { onConflict: "awb" });
      if (orderName) {
        await supabase.from("enriched_orders_ecom").update({ rapidshyp_webhook_status: ship.shipment_status || null, updated_at: now })
          .or(`name.eq.${orderName},name.eq.#${orderName}`);
      }
      updated++; summary.push(`${orderName || awb}=${j.outcome}`);
    }

    console.log(`[rapidshyp-webhook] updated ${updated}/${records.length}: ${summary.slice(0, 20).join(", ")}`);
    return new Response(JSON.stringify({ success: true, processed: updated }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err: any) {
    console.error(`[rapidshyp-webhook] error: ${err.message}`);
    return new Response(JSON.stringify({ error: err.message }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
