import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// HTTPS webhook receiver for Kwikship (GoKwik) → updates shipment_journey_ecom (source='kwikship') in
// real time. GoKwik's "Merchant Webhooks" needs an HTTPS endpoint; the Node app runs on plain HTTP, so
// this always-on Edge Function is what GoKwik points at (same pattern as rapidshyp-webhook).
//
// GoKwik triggers: Pickup Completed / Out For Delivery / Undelivered / Rto Initiated / Delivered.
// On each event we fetch the AUTHORITATIVE status_history from Kwikship's API (GET /shipments/:awb) so the
// journey is correct no matter what shape the webhook body has, then upsert. The nightly 2 AM Node cron
// (kwikship_sync.js) stays as a backstop. This PORTS the Node parseKwikshipJourney() — keep them in sync.
//
// Auth: GoKwik sends `Authorization: Bearer <token>`. Accepts KWIKSHIP_WEBHOOK_SECRET (set the SAME value
// in GoKwik's webhook Token field). Kwikship API creds: KWIKSHIP_APP_ID / KWIKSHIP_APP_SECRET (secrets).

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-webhook-secret",
};

const KWIK_BASE = (Deno.env.get("KWIKSHIP_BASE_URL") || "https://api.gokwik.co/kwikship").replace(/\/+$/, "");

// ── Kwikship internal status → journey event type (mirror of kwikship_sync.js classifyKwikStatus) ──
function classifyKwikStatus(status: string): string {
  const s = String(status || "").toLowerCase().trim();
  if (!s) return "other";
  if (/^rto|return_delivered|return_pickup|return_transit/.test(s)) return "rto";
  if (s === "out_for_delivery") return "attempt";
  if (s === "delivered") return "delivered";
  if (s === "pickup_completed" || s === "picked_up") return "pickup";
  if (s === "undelivered" || /^ndr_attempt/.test(s)) return "ndr";
  if (s === "lost" || s === "damaged" || s === "destroyed") return "lost";
  return "other";
}
function kwikOutcome(status: string): string | null {
  const s = String(status || "").toLowerCase().trim();
  if (s === "delivered") return "delivered";
  if (/^rto|return_delivered/.test(s)) return "rto";
  if (s === "lost" || s === "damaged" || s === "destroyed") return "lost";
  return null;
}
function parseKwikDate(v: any): string | null {
  if (!v) return null;
  const d = new Date(String(v).trim());
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// ── zone (A–E) from destination state/city, origin Gurgaon/NCR (mirror of delivery_journey.zoneFromState) ──
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

// Faithful port of Node parseKwikshipJourney().
function parseKwikshipJourney(statusHistory: any[], currentStatus: string, courier: string | null, zone: string | null) {
  const status = String(currentStatus || "").toLowerCase().trim();
  const evts = (statusHistory || [])
    .map((h: any) => ({
      // Accept BOTH Kwikship shapes: v1 (auth) {datetime, description} and v2 (public)
      // {status_datetime, shipper_remark}. `shipper_remark` is the only HUMAN NDR reason either
      // endpoint gives ("Consignee Unavailable"); v1's description is a courier code
      // ("UD_EOD-11_Pending") that means nothing to an agent, so prefer the remark.
      desc: h.shipper_remark || h.description || h.status || "",
      at: parseKwikDate(h.status_datetime || h.datetime || h.date || h.timestamp || h.creation_datetime),
      type: classifyKwikStatus(h.status),
    }))
    .filter((e: any) => e.type || e.desc)
    .sort((a: any, b: any) => (a.at || "").localeCompare(b.at || ""));

  let attempts = 0, ndr_count = 0, outForDeliveryAt: any = null, deliveredAt: any = null, rtoAt: any = null,
    pickedUpAt: any = null, lostAt: any = null, seenOFD = false;
  const ndr_reasons: string[] = [];
  for (const e of evts) {
    if (e.type === "pickup") { if (!pickedUpAt) pickedUpAt = e.at; }
    else if (e.type === "attempt") { attempts++; seenOFD = true; if (!outForDeliveryAt) outForDeliveryAt = e.at; }
    else if (e.type === "ndr") { if (seenOFD) { ndr_count++; if (e.desc) ndr_reasons.push(e.desc); } }
    else if (e.type === "delivered" && !deliveredAt) deliveredAt = e.at;
    else if (e.type === "rto" && !rtoAt) rtoAt = e.at;
    else if (e.type === "lost" && !lostAt) lostAt = e.at;
  }
  const codeOut = kwikOutcome(status);
  const delivered = codeOut === "delivered" || !!deliveredAt;
  const rto = codeOut === "rto" || !!rtoAt || /^rto|return/.test(status);
  const lost = codeOut === "lost" || !!lostAt;
  const reached_delivery = seenOFD || delivered || status === "out_for_delivery";
  const outcome = delivered ? "delivered" : rto ? "rto" : lost ? "lost" : (ndr_count > 0 ? "ndr_pending" : "in_transit");

  return {
    courier: courier || null, outcome,
    attempts: attempts || (delivered ? 1 : 0), ndr_count, reached_delivery,
    first_attempt_success: delivered && ndr_count === 0,
    ndr_reasons: [...new Set(ndr_reasons)].slice(0, 10),
    out_for_delivery_at: outForDeliveryAt, delivered_at: deliveredAt, rto_at: rtoAt,
    dispatched_at: pickedUpAt, zone: zone || null, status_code: currentStatus || null,
    rto_no_attempt: rto && !seenOFD,
    is_final: delivered || rto || lost,
  };
}

// Fetch authoritative shipment detail from Kwikship. Returns null if creds missing or not found.
// ── Kwikship PUBLIC tracking (v2) — no auth, no credentials ──────────────────────────────────────
// GET /track/v2/public?order_code=<awb>   (merchant_id is accepted but ignored)
// Called ALONGSIDE v1, not instead of it: v2 is the only source of `shipper_remark` (the human NDR
// reason), while v1 owns the current status, courier and shipping address (→ zone). Because it needs
// no credentials it also still works if KWIKSHIP_APP_ID/SECRET are ever missing or rotated.
async function fetchKwikshipPublic(awb: string) {
  try {
    const r = await fetch(`${KWIK_BASE}/track/v2/public?order_code=${encodeURIComponent(awb)}`);
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    const d = j && j.data;
    const hist = d && Array.isArray(d.statusHistory) ? d.statusHistory : [];
    if (!hist.length) return null;
    return {
      statusHistory: hist,
      courier: (d.shipper_info && (d.shipper_info.shipper_name || d.shipper_info.master_shipper_name)) || null,
      edd: parseKwikDate(d.estimated_dd),
    };
  } catch (_) { return null; }
}

async function fetchKwikshipShipment(awb: string) {
  const id = Deno.env.get("KWIKSHIP_APP_ID"), secret = Deno.env.get("KWIKSHIP_APP_SECRET");
  if (!id || !secret || !awb) return null;
  try {
    const r = await fetch(`${KWIK_BASE}/api/v1/shipments/${encodeURIComponent(awb)}`, {
      headers: { "gk-app-id": id, "gk-app-secret": secret, "Content-Type": "application/json" },
    });
    if (!r.ok) return null;
    const body = await r.json();
    const d = body && body.data;
    if (!d || body.success === false) return null;
    const addr = d.shipping_address || {};
    return {
      status: d.status || "",
      courier: d.courier_name || null,
      statusHistory: Array.isArray(d.status_history) ? d.status_history : [],
      state: addr.state || null, city: addr.city || null,
      edd: parseKwikDate(d.estimated_delivery_date),
      order_id: d.order_id || null,
    };
  } catch (_e) { return null; }
}

// Pull an AWB out of whatever shape GoKwik sends (payload is undocumented — try common paths).
function extractAwb(p: any): string | null {
  if (!p || typeof p !== "object") return null;
  const cand = p.awb || p.waybill || p.awb_number || p.tracking_number ||
    (p.data && (p.data.awb || p.data.waybill || p.data.awb_number || p.data.tracking_number)) ||
    (p.shipment && (p.shipment.awb || p.shipment.waybill)) ||
    (p.shipment_details && p.shipment_details.awb);
  return cand ? String(cand).trim() : null;
}
function extractStatusHistory(p: any): any[] | null {
  const h = (p && (p.status_history || (p.data && p.data.status_history) || (p.shipment && p.shipment.status_history)));
  return Array.isArray(h) && h.length ? h : null;
}
function extractStatus(p: any): string {
  return String((p && (p.status || p.current_order_shipment_status || (p.data && (p.data.status || p.data.current_order_shipment_status)))) || "").trim();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const url = new URL(req.url);
  if (req.method === "GET" && url.searchParams.get("health") === "1") {
    return new Response(JSON.stringify({ ok: true, function: "kwikship-webhook", ts: new Date().toISOString() }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  // Audit trail — every hit is recorded in kwikship_webhook_log (received_at, awb, result, user_agent,
  // source_ip, raw payload) so it's PROVABLE which events came from GoKwik (their UA ≠ a manual curl) vs the
  // cron, and to capture GoKwik's real payload shape. Fire-and-forget; logging never blocks the response.
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const userAgent = req.headers.get("user-agent") || "";
  const sourceIp = req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || "";
  let logPayload: any = null;
  const logHit = async (result: string, fields: Record<string, any> = {}) => {
    try { await supabase.from("kwikship_webhook_log").insert({ result, user_agent: userAgent, source_ip: sourceIp, payload: logPayload, ...fields }); } catch (_e) { /* never block on logging */ }
  };
  try {
    const expected = Deno.env.get("KWIKSHIP_WEBHOOK_SECRET") || "kwikship-te-webhook";
    const authHeader = req.headers.get("authorization") || "";
    const provided = (authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader)
      || req.headers.get("x-webhook-secret") || url.searchParams.get("token") || "";
    if (provided !== expected) {
      await logHit("unauthorized");
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const rawText = await req.text();
    let payload: any = {};
    try { payload = rawText ? JSON.parse(rawText) : {}; } catch (_e) { /* non-JSON */ }
    logPayload = payload;
    // Log the raw body so we can learn GoKwik's real payload shape from the first live events.
    console.log(`[kwikship-webhook] payload: ${rawText.slice(0, 2000)}`);

    const awb = extractAwb(payload);
    if (!awb) {
      console.warn("[kwikship-webhook] no AWB in payload — acking anyway");
      await logHit("no-awb");
      return new Response(JSON.stringify({ success: true, note: "no awb" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // AUTHORITATIVE: pull the full timeline from Kwikship's API (falls back to the webhook body if creds/API unavailable).
    // Both endpoints in parallel. v1 = identity (status/courier/address→zone); v2 = the timeline that
    // carries the NDR reason. Either can fail independently without losing the other.
    const [detail, pub] = await Promise.all([fetchKwikshipShipment(awb), fetchKwikshipPublic(awb)]);
    // Timeline preference: v2 (has shipper_remark) → v1 → whatever the webhook body carried.
    const statusHistory = (pub && pub.statusHistory.length) ? pub.statusHistory
      : (detail ? detail.statusHistory : (extractStatusHistory(payload) || []));
    // Current status: v1 when we have it, else v2's NEWEST scan (its history is newest-first and the
    // two agree on live shipments), else whatever the event body carried.
    const curStatus = (detail && detail.status)
      || (pub && pub.statusHistory.length ? String(pub.statusHistory[0].status || "") : "")
      || extractStatus(payload);
    const courier = (detail && detail.courier) || (pub && pub.courier) || payload.courier_name || payload.courier || null;

    // If we have NEITHER an authoritative fetch NOR any timeline/status in the event body, do NOT upsert —
    // a data-less ping must never overwrite fields the cron already set (courier/attempts/outcome…). Ack and
    // let the 2 AM cron own it. (Set KWIKSHIP_APP_ID/KWIKSHIP_APP_SECRET secrets so the authoritative fetch
    // always runs and this branch is never hit.)
    if (!detail && !pub && !(statusHistory && statusHistory.length) && !curStatus) {
      console.log(`[kwikship-webhook] ${awb}: no timeline in event + Kwikship API creds not set — acking; cron will sync.`);
      await logHit("no-timeline", { awb });
      return new Response(JSON.stringify({ success: true, awb, note: "no timeline; deferred to cron" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Enrich order_name / order_date / payment_mode + destination zone from the synced EasyEcom order.
    const { data: eo } = await supabase.from("b2c_order_easycom")
      .select("reference_code, order_date, payment_mode, shipping_state, shipping_city")
      .eq("awb_number", awb).limit(1).maybeSingle();
    const zone = zoneFromState(detail?.state || eo?.shipping_state || "", detail?.city || eo?.shipping_city || "");

    const j = parseKwikshipJourney(statusHistory, curStatus, courier, zone);

    const now = new Date().toISOString();
    const row: Record<string, any> = {
      awb, source: "kwikship",
      outcome: j.outcome, attempts: j.attempts, ndr_count: j.ndr_count,
      reached_delivery: j.reached_delivery, first_attempt_success: j.first_attempt_success,
      ndr_reasons: j.ndr_reasons, out_for_delivery_at: j.out_for_delivery_at,
      delivered_at: j.delivered_at, rto_at: j.rto_at, rto_no_attempt: !!j.rto_no_attempt,
      is_final: j.is_final, updated_at: now,
    };
    // Conditional — never wipe fields the cron/EasyEcom set when a partial webhook lacks them.
    if (j.courier) row.courier = j.courier;
    if (eo?.reference_code) row.order_name = eo.reference_code;
    if (eo?.order_date) row.order_date = eo.order_date;
    if (eo?.payment_mode) row.payment_mode = eo.payment_mode;
    if (j.status_code) row.status_code = j.status_code;
    if (detail?.edd) row.first_edd = detail.edd;          // DB trigger keeps the earliest
    if (j.dispatched_at) row.dispatched_at = j.dispatched_at;
    if (j.zone) row.zone = j.zone;
    if (j.rto_no_attempt) row.raw = { status_history: statusHistory, status: curStatus, captured_at: now };

    const { error } = await supabase.from("shipment_journey_ecom").upsert(row, { onConflict: "awb" });
    if (error) { console.error(`[kwikship-webhook] upsert ${awb}: ${error.message}`); await logHit("error", { awb, order_name: eo?.reference_code, cur_status: curStatus, outcome: j.outcome }); return new Response(JSON.stringify({ error: error.message }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }

    // Re-allocation cleanup: if this order came to Kwikship from another aggregator, drop the stale
    // (non-final) journey row keyed on the old AWB so the order isn't double-counted in the dashboard.
    if (eo?.reference_code) {
      const { data: dropped } = await supabase.from("shipment_journey_ecom")
        .delete().eq("order_name", eo.reference_code).eq("is_final", false).neq("awb", awb)
        .select("awb, source");
      if (dropped && dropped.length) console.log(`[kwikship-webhook] ${eo.reference_code}: superseded ${dropped.length} stale row(s) [${dropped.map((r: any) => `${r.source}:${r.awb}`).join(", ")}]`);
    }

    await logHit("ok", { awb, order_name: eo?.reference_code, cur_status: curStatus, outcome: j.outcome });
    console.log(`[kwikship-webhook] ${eo?.reference_code || awb} → ${j.outcome} (${curStatus})`);
    return new Response(JSON.stringify({ success: true, awb, outcome: j.outcome }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err: any) {
    console.error(`[kwikship-webhook] error: ${err.message}`);
    return new Response(JSON.stringify({ error: err.message }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
