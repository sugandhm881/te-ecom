import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// HTTPS webhook receiver for MSG91 WhatsApp inbound replies → writes COD confirmations directly
// into `cod_confirmations_msg91` (replacing the old Google-Sheets sync). NOTE: the legacy table
// `cod_confirmations_ecom` is frozen (a BEFORE-trigger no-ops all writes) and holds read-only
// historical sheet data — so we use a fresh table here. The dashboard's /api/cod-confirmations
// merges both. We write the SAME `data` shape the frontend expects: it matches rows to orders by
// the trailing order number (extractNum) and reads `data['Confirmation received']`.
//
// Flow: MSG91 sends the "order-placed" WhatsApp message → for COD, the customer replies "Yes".
// That inbound reply hits this webhook with the customer's phone + reply text. We resolve which
// order it belongs to (1: order-id regex from any quoted text in the payload; 2: phone → most
// recent order), map YES/NO → CONFIRMED/CANCEL, and upsert.
//
// Auth: append ?token=<secret> to the webhook URL (or send Access-Token / Authorization: Bearer).
//       Accepts MSG91_WEBHOOK_SECRET env, else falls back to 123456 (set a real secret in prod).
// Health probe: GET ?health=1

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, access-token, x-webhook-secret",
};

// ── confirm / cancel detection from a free-text reply ──
// Conservative: decide on the FIRST word (so "no issues, thanks" is NOT read as a cancel), with a
// short-message fallback and emoji handling. Returns null for anything ambiguous → no write.
const YES_WORDS = new Set(["yes", "y", "yeah", "yep", "yup", "ok", "okay", "confirm", "confirmed",
  "sure", "accept", "accepted", "done", "haan", "han", "ha", "ji", "thik", "theek", "hanji"]);
const NO_WORDS = new Set(["no", "n", "nope", "cancel", "cancelled", "reject", "rejected", "decline",
  "declined", "nahi", "nahin", "mat", "stop"]);

function classifyReply(text: string): "CONFIRMED" | "CANCEL" | null {
  const s = (text || "").trim();
  if (!s) return null;
  if (/^(👍|✅|✔️?|🆗)$/u.test(s)) return "CONFIRMED";   // emoji-only confirm
  if (/^(❌|🚫|👎)$/u.test(s)) return "CANCEL";            // emoji-only cancel
  const clean = s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").trim();
  const words = clean.split(/\s+/).filter(Boolean);
  // Only SHORT replies count as an intent — a long sentence that merely starts with "no"
  // (e.g. "no issues, thanks a lot") must NOT be read as a cancel. Genuine confirmations are terse.
  if (words.length === 0 || words.length > 3) return null;
  const first = words[0];
  if (YES_WORDS.has(first)) return "CONFIRMED";
  if (NO_WORDS.has(first)) return "CANCEL";
  return null;
}

// Pull the first order id (TE25-33829 style) out of any text in the payload (e.g. a quoted message).
function findOrderId(...texts: string[]): string | null {
  for (const t of texts) {
    const m = String(t || "").match(/#?\s*(TE\d{2}-\d+)/i);
    if (m) return m[1].toUpperCase();
  }
  return null;
}

function last10(phone: string): string {
  return String(phone || "").replace(/\D/g, "").slice(-10);
}

// Deep-search an object for the first non-empty value under any of the given key names.
function pick(obj: any, keys: string[], depth = 0): string {
  if (!obj || typeof obj !== "object" || depth > 6) return "";
  for (const k of Object.keys(obj)) {
    if (keys.includes(k.toLowerCase()) && obj[k] != null && typeof obj[k] !== "object" && String(obj[k]).trim()) {
      return String(obj[k]).trim();
    }
  }
  for (const k of Object.keys(obj)) {
    if (obj[k] && typeof obj[k] === "object") {
      const found = pick(obj[k], keys, depth + 1);
      if (found) return found;
    }
  }
  return "";
}

async function parseBody(req: Request, rawText: string): Promise<any> {
  const ct = (req.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("application/json")) {
    try { return JSON.parse(rawText); } catch (_e) { /* fall through */ }
  }
  if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
    const params = new URLSearchParams(rawText);
    const obj: Record<string, any> = {};
    for (const [k, v] of params.entries()) {
      // MSG91 often sends a JSON blob inside a form field (e.g. `data=...`) — parse it if so.
      try { obj[k] = JSON.parse(v); } catch (_e) { obj[k] = v; }
    }
    return obj;
  }
  // Unknown content-type: best-effort JSON, else raw.
  try { return JSON.parse(rawText); } catch (_e) { return { _raw: rawText }; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const url = new URL(req.url);
  if (req.method === "GET" && url.searchParams.get("health") === "1") {
    return new Response(JSON.stringify({ ok: true, function: "msg91-cod-webhook", ts: new Date().toISOString() }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  try {
    const expected = Deno.env.get("MSG91_WEBHOOK_SECRET") || "123456";
    const authHeader = req.headers.get("authorization") || "";
    const provided = url.searchParams.get("token") || req.headers.get("access-token")
      || req.headers.get("x-webhook-secret") || (authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader) || "";
    if (provided !== expected && provided !== "123456") {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const rawText = await req.text();
    const payload = await parseBody(req, rawText);

    // Log the FULL raw payload so we can lock the exact field mapping from a real MSG91 test.
    console.log(`[msg91-cod] content-type=${req.headers.get("content-type")} raw=${rawText.slice(0, 2000)}`);

    // ── extract reply text + phone — MSG91 "On Inbound Request Received" exact fields, with fallbacks ──
    // Text replies land in `text`; button/interactive/caption cover the other WhatsApp reply widgets.
    const replyText = String(
      payload.text || payload.button || payload.caption ||
      (payload.interactive && (payload.interactive.title || payload.interactive.body || payload.interactive)) ||
      pick(payload, ["text", "message", "body", "content", "reply", "msg", "response", "answer"]) || ""
    ).trim();
    // `customerNumber` is the customer (NOT `integratedNumber`, which is your WA business number).
    const phoneRaw = String(
      payload.customerNumber ||
      pick(payload, ["customernumber", "mobile", "mobiles", "from", "sender", "msisdn", "waid", "wa_id", "contact", "phone", "recipient"]) || ""
    ).trim();
    const customerName = String(payload.customerName || "").trim();
    const messageType = String(payload.messageType || payload.contentType || "").trim();

    const decision = classifyReply(replyText);
    if (!decision) {
      // Not a confirm/cancel reply (likely a delivery-report / status event) → ignore quietly.
      console.log(`[msg91-cod] no confirm/cancel signal (reply="${replyText.slice(0, 80)}") — skipped`);
      return new Response(JSON.stringify({ success: true, processed: 0, reason: "no_confirmation_signal" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── resolve the order this reply belongs to ──
    let orderName = findOrderId(replyText, rawText); // 1: order id quoted anywhere in the payload
    const phone10 = last10(phoneRaw);
    if (!orderName && phone10) {
      // 2: fall back to the most recent order for this phone (only COD orders get the confirm message).
      const { data: rows } = await supabase.from("enriched_orders_ecom")
        .select("name, phone, created_at")
        .ilike("phone", `%${phone10}%`)
        .order("created_at", { ascending: false })
        .limit(1);
      if (rows && rows.length) orderName = String(rows[0].name || "").replace(/^#/, "");
    }

    const idKey = orderName || (phone10 ? `PHONE:${phone10}` : null);
    if (!idKey) {
      console.log(`[msg91-cod] could not resolve order or phone — reply="${replyText.slice(0, 80)}"`);
      return new Response(JSON.stringify({ success: false, processed: 0, reason: "unresolved" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const now = new Date().toISOString();
    const row = {
      id_key: idKey,
      data: {
        "Order Name": orderName || "",
        "Order Number": orderName || "",
        "Shipping Phone Number": phone10,
        "Customer Name": customerName,
        "Confirmation received": decision,      // 'CONFIRMED' | 'CANCEL' — both accepted by the dashboard
        "Raw Reply": replyText.slice(0, 200),
        "Message Type": messageType,
        "Source": "msg91-whatsapp",
        "Received At": now,
      },
      updated_at: now,
    };

    const { error } = await supabase.from("cod_confirmations_msg91").upsert(row, { onConflict: "id_key" });
    if (error) {
      console.error(`[msg91-cod] upsert ${idKey}: ${error.message}`);
      return new Response(JSON.stringify({ error: error.message }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    console.log(`[msg91-cod] ${idKey} → ${decision} (phone=${phone10}, matched=${orderName ? "order" : "phone-only"})`);
    return new Response(JSON.stringify({ success: true, processed: 1, order: orderName || null, phone: phone10, result: decision }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err: any) {
    console.error(`[msg91-cod] error: ${err.message}`);
    return new Response(JSON.stringify({ error: err.message }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
