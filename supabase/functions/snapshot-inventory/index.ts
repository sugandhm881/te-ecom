// Daily EasyEcom inventory + sales snapshot.
// Triggered by pg_cron at 18:30 UTC (~00:00 IST). Also callable on demand.
//
// ⚠⚠ THIS FILE IS THE SOURCE OF TRUTH AND MUST BE DEPLOYED FOR AN EDIT HERE TO DO ANYTHING.
// It lived ONLY in Supabase until 2026-08-22, which is why a DRR that changed on every run took a
// day to explain — nobody could read the window logic. Deploy with the Supabase MCP/CLI after any
// change here, and never edit it in the dashboard without copying the result back.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const EXTRA_BASE_SKUS = ["TE-M2SAS1", "TE-M10NBS1", "TE-MNBS1"];

function fmt(d: Date) {
  return d.toISOString().split("T")[0];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    const callProxy = async (action: string, params?: Record<string, any>) => {
      const r = await fetch(`${supabaseUrl}/functions/v1/easyecom-proxy`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${serviceKey}`,
          apikey: serviceKey,
        },
        body: JSON.stringify({ action, params }),
      });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(`${action} failed: ${j.error || r.status}`);
      return j;
    };

    // Snapshot window: last 30 completed days ending yesterday (IST)
    const nowIst = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    const snapshotDate = fmt(nowIst);
    const endIst = new Date(nowIst);
    endIst.setUTCDate(endIst.getUTCDate() - 1);
    const startIst = new Date(endIst);
    startIst.setUTCDate(startIst.getUTCDate() - 29);

    // Pack -> base mapping. NOTE: a combo (pack_sku) can contain MULTIPLE base
    // components, i.e. multiple rows in sku_pack_mapping. We therefore store an
    // ARRAY of {baseSku, multiplier} per pack_sku and credit every component.
    // (Previously a Map kept only one base per pack, silently dropping the rest.)
    const { data: mapRows } = await sb
      .from("sku_pack_mapping")
      .select("base_sku, pack_sku, unit_multiplier");
    const baseSkus = new Set<string>();
    const packToBases = new Map<string, Array<{ baseSku: string; multiplier: number }>>();
    const addMapping = (pack: string, base: string, mult: number) => {
      const arr = packToBases.get(pack) || [];
      const existing = arr.find((x) => x.baseSku === base);
      if (existing) existing.multiplier = mult; // last write wins for same base
      else arr.push({ baseSku: base, multiplier: mult });
      packToBases.set(pack, arr);
    };
    for (const sku of EXTRA_BASE_SKUS) {
      baseSkus.add(sku);
      addMapping(sku, sku, 1);
    }
    for (const r of (mapRows as any[]) || []) {
      const base = r.base_sku;
      const pack = r.pack_sku || base;
      const mult = Number(r.unit_multiplier) || 1;
      if (base) baseSkus.add(base);
      if (pack && base) addMapping(pack, base, mult);
    }
    // Ensure every base SKU credits itself x1 when sold directly under its own SKU.
    for (const base of baseSkus) {
      const arr = packToBases.get(base) || [];
      if (!arr.some((x) => x.baseSku === base)) {
        arr.push({ baseSku: base, multiplier: 1 });
        packToBases.set(base, arr);
      }
    }

    // Fetch inventory from EasyEcom
    console.log("Fetching inventory...");
    const invJson = await callProxy("getInventory");
    console.log(`Got ${(invJson.data || []).length} inventory items`);

    if (invJson.rateLimited) {
      return new Response(
        JSON.stringify({ skipped: true, reason: invJson.warning }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const inventory: any[] = invJson.data || [];

    // Per-base-SKU units sold per day-window (7/14/30).
    // Cutoffs are WHOLE IST CALENDAR DAYS: 00:00 IST of (yesterday - (days-1)).
    // Combined with the endIso upper bound (yesterday 23:59 IST), each window is
    // exactly N completed IST days — today's partial day is excluded — so DRR is
    // reproducible by summing per-day sales.
    const istMidnightUtcMs = (dd: Date) =>
      Date.UTC(dd.getUTCFullYear(), dd.getUTCMonth(), dd.getUTCDate(), 0, 0, 0) - 5.5 * 60 * 60 * 1000;
    const cutoff = (days: number) => {
      const d = new Date(endIst);
      d.setUTCDate(d.getUTCDate() - (days - 1));
      return istMidnightUtcMs(d);
    };
    const c7 = cutoff(7);
    const c14 = cutoff(14);
    const c30 = cutoff(30);

    // Map b2c_order_easycom.location text -> inventory location_id
    // ⚠ THE SAME WAREHOUSE ARRIVES UNDER TWO NAMES. An order is created with location
    // "Shifupro Technologies Pvt. Ltd." while it is still Confirmed, and flips to "rapidshyp" when it
    // dispatches. Mapping only the second one split one warehouse across two buckets: the dispatched
    // orders credited the real Shifupro inventory row, while the not-yet-dispatched ones landed in an
    // orphan row (warehouse "N/A", stock 0) that nothing reads. The visible effect was DRR climbing
    // through the day as the warehouse worked through its dispatch queue — the same orders migrating
    // into the counted bucket, retroactively, for days already inside the window. Both labels are the
    // same physical warehouse, so both credit it and an order counts once whatever state it is in.
    const locationMap: Record<string, string> = {
      docpharma: "ix73493041216",                          // DP Bangalore
      rapidshyp: "wo66194027524",                          // Shifupro / Gurgaon, once dispatched
      "shifupro technologies pvt. ltd.": "wo66194027524",  // ...and the same place before dispatch
    };

    // Fetch orders from b2c_order_easycom (paginated; > 1000 rows expected).
    // Bound by IST calendar days: start 00:00 IST of (yesterday-29), end 23:59 IST yesterday.
    console.log(`Fetching b2c_order_easycom orders from ${fmt(startIst)} to ${fmt(endIst)}...`);
    const startIso = new Date(istMidnightUtcMs(startIst)).toISOString();
    const endIso = new Date(istMidnightUtcMs(endIst) + 24 * 60 * 60 * 1000 - 1000).toISOString();
    const orders: any[] = [];
    {
      const pageSize = 1000;
      let from = 0;
      while (true) {
        // ⚠⚠ `.order()` IS LOAD-BEARING, NOT TIDINESS. This pages ~10,000 rows in 10 requests while the
        // EasyEcom order sync is concurrently UPDATING those same rows. Postgres guarantees no row order
        // without ORDER BY, and an updated row physically moves under MVCC — so between page 3 and page 4
        // the same order can be returned twice or skipped entirely. That is why one fixed 7-day window
        // (15-21 Aug) produced 2,667 units at 06:30, 2,940 at 10:17 and a true value of 2,830: whole
        // PAGES were being double-counted or dropped, which is also why every SKU moved by the same
        // ~10-15% rather than moving independently. Order by the primary key so paging is repeatable.
        const { data, error } = await sb
          .from("b2c_order_easycom")
          .select("order_date, location, line_items, order_status")
          .gte("order_date", startIso)
          .lte("order_date", endIso)
          .order("order_id", { ascending: true })
          .range(from, from + pageSize - 1);
        if (error) throw new Error(`b2c_order_easycom query failed: ${error.message}`);
        if (!data || data.length === 0) break;
        orders.push(...data);
        if (data.length < pageSize) break;
        from += pageSize;
      }
    }
    console.log(`Got ${orders.length} orders from b2c_order_easycom`);

    // Per (base-SKU, location_id) units sold per day-window (7/14/30)
    const sales = new Map<string, { d7: number; d14: number; d30: number }>();
    for (const order of orders) {
      const status = String(order.order_status || "");
      if (status === "Cancelled" || status === "Returned") continue; // true demand only
      const ts = new Date(order.order_date || 0).getTime();
      const rawLoc = String(order.location || "").toLowerCase();
      const loc = locationMap[rawLoc] || rawLoc || "unknown";
      const items = Array.isArray(order.line_items) ? order.line_items : [];
      for (const sub of items) {
        const sku = sub.sku || sub.seller_sku || sub.product_sku || "";
        const qty = Number(sub.qty || sub.quantity || 1);
        if (!sku) continue;
        const mappings = packToBases.get(sku);
        if (!mappings) continue;
        for (const mp of mappings) {
          const units = qty * mp.multiplier;
          const key = `${mp.baseSku}|${loc}`;
          const cur = sales.get(key) || { d7: 0, d14: 0, d30: 0 };
          if (!ts || ts >= c30) cur.d30 += units;
          if (!ts || ts >= c14) cur.d14 += units;
          if (!ts || ts >= c7) cur.d7 += units;
          sales.set(key, cur);
        }
      }
    }

    // One row per (sku, location_key) — keep warehouses separate
    type Row = {
      snapshot_date: string;
      location_id: string;
      sku: string;
      product_name: string | null;
      warehouse: string;
      category: string;
      available_quantity: number;
      units_sold_7d: number;
      units_sold_14d: number;
      units_sold_30d: number;
      raw: any;
    };
    const byKey = new Map<string, Row>();
    const seenSkuLoc = new Set<string>();

    for (const item of inventory) {
      const sku = item.sku || item.SKU || item.product_sku || "";
      if (!sku || !baseSkus.has(sku)) continue;
      const loc = item.location_key || item.locationKey || item.location_id || "unknown";
      const key = `${sku}|${loc}`;
      const qty = Number(
        item.availableInventory ?? item.available_quantity ?? item.availableQuantity ?? item.inventory ?? item.stock ?? 0,
      );
      const s = sales.get(key) || { d7: 0, d14: 0, d30: 0 };
      const existing = byKey.get(key);
      if (existing) {
        existing.available_quantity += qty;
      } else {
        byKey.set(key, {
          snapshot_date: snapshotDate,
          location_id: loc,
          sku,
          product_name: item.productName || item.product_name || item.name || item.product_title || sku,
          warehouse: item.companyName || item.warehouse_name || item.warehouseName || item.location || "N/A",
          category: item.category || item.product_category || item.category_name || "Uncategorized",
          available_quantity: qty,
          units_sold_7d: s.d7,
          units_sold_14d: s.d14,
          units_sold_30d: s.d30,
          raw: null,
        });
      }
      seenSkuLoc.add(key);
    }

    // Locations the inventory feed actually answered for in THIS run.
    const locsWithInventory = new Set(
      inventory.map((it: any) => it.location_key || it.locationKey || it.location_id || "unknown"),
    );

    // Include sales rows for (sku, location) combos that had no inventory entry.
    // WARNING: A PLACEHOLDER MUST NEVER CLOBBER A REAL STOCK ROW. These rows carry stock 0 and
    // warehouse "N/A", and the upsert key is (snapshot_date, location_id, sku) -- so if EasyEcom
    // omits a SKU from one getInventory call (the feed is not stable run to run), the placeholder
    // OVERWRITES yesterday-good stock with a zero and the dashboard reports a stocked product as Out
    // of Stock. Observed on TE-AFW1 and TE-ABW1: EasyEcom held 502 and 472 units while the snapshot
    // said 0. So a placeholder is only written for a location the feed did not answer for AT ALL --
    // a genuinely unknown warehouse -- never for one we just read stock from.
    for (const [key, s] of sales) {
      if (seenSkuLoc.has(key)) continue;
      const [sku, loc] = key.split("|");
      if (!baseSkus.has(sku)) continue;
      if (locsWithInventory.has(loc)) continue;   // feed gap, not a real zero
      byKey.set(key, {
        snapshot_date: snapshotDate,
        location_id: loc,
        sku,
        product_name: sku,
        warehouse: "N/A",
        category: "Uncategorized",
        available_quantity: 0,
        units_sold_7d: s.d7,
        units_sold_14d: s.d14,
        units_sold_30d: s.d30,
        raw: null,
      });
      seenSkuLoc.add(key);
    }

    // Include any base SKU that didn't appear in inventory or sales at all
    const seenBaseSkus = new Set(Array.from(byKey.values()).map((r) => r.sku));
    for (const sku of baseSkus) {
      if (seenBaseSkus.has(sku)) continue;
      byKey.set(`${sku}|unknown`, {
        snapshot_date: snapshotDate,
        location_id: "unknown",
        sku,
        product_name: sku,
        warehouse: "N/A",
        category: "Uncategorized",
        available_quantity: 0,
        units_sold_7d: 0,
        units_sold_14d: 0,
        units_sold_30d: 0,
        raw: null,
      });
    }

    // A partial inventory feed is worse than a stale snapshot: it writes zeros that read as Out of
    // Stock. If EasyEcom answered for fewer than 60% of the base SKUs, leave yesterday's rows alone.
    const skusWithStock = new Set(
      Array.from(byKey.values()).filter((r) => r.available_quantity > 0).map((r) => r.sku),
    );
    if (baseSkus.size >= 5 && skusWithStock.size < baseSkus.size * 0.6) {
      console.error(`inventory feed looks partial: stock for ${skusWithStock.size} of ${baseSkus.size} base SKUs — not upserting`);
      return new Response(
        JSON.stringify({ skipped: true, reason: `partial inventory feed (${skusWithStock.size}/${baseSkus.size} SKUs had stock)` }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const dedupedRows = Array.from(byKey.values());

    if (dedupedRows.length === 0) {
      return new Response(
        JSON.stringify({ snapshot_date: snapshotDate, inserted: 0, note: "no matching rows" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { error } = await sb
      .from("inventory_snapshots")
      .upsert(dedupedRows, { onConflict: "snapshot_date,location_id,sku" });
    if (error) throw new Error(`Upsert failed: ${error.message}`);

    return new Response(
      JSON.stringify({ snapshot_date: snapshotDate, inserted: dedupedRows.length }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("snapshot-inventory error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
