// ─────────────────────────────────────────────────────────────────────────────
// SHOPIFY → shopify_products. One row per VARIANT.
//
// ⚠️ This file is the source of truth for the deployed edge function of the same
// name. Edit here, then deploy — a change made only in the Supabase dashboard
// drifts silently and has bitten this project three times.
//
// Two bugs fixed 2026-09-09, both found from one complaint ("TE-UCSC combo shows
// 2 drops when it has only one drop in the combo", influencer order booking):
//
//   1. EVERY VARIANT WORE THE PRODUCT'S FIRST IMAGE. `product.images[0].src` was
//      stamped onto all of a product's variants and `variant.image_id` thrown
//      away. Shopify had it right — TE-UCSC (Combo Pack) carries comboucscv2.png
//      and TE-UCSC1M (1 Month Pack) carries comboucsc1mv2.png — but the product
//      lists the 1-Month artwork FIRST, so the Combo Pack row showed the
//      1-month picture, which has two dropper bottles. 19 of 31 active
//      multi-variant products had all their variants sharing one image.
//
//   2. A DELETED VARIANT LIVED FOREVER. The sync only upserted, so a variant
//      removed in Shopify kept its row — 27 of 198 were ghosts, and the picker
//      was summing their stock. Rows a completed run does not see are now marked
//      `removed_at`; a variant that comes back has it cleared.
// ─────────────────────────────────────────────────────────────────────────────
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const shopifyStoreUrl = Deno.env.get("SHOPIFY_STORE_URL")!;
    const shopifyAccessToken = Deno.env.get("SHOPIFY_ACCESS_TOKEN")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Log sync start
    const { data: syncLog } = await supabase
      .from("shopify_product_sync_log")
      .insert({ status: "running" })
      .select("id")
      .single();
    const syncId = syncLog?.id;

    let allProducts: any[] = [];
    let pageInfo: string | null = null;
    const limit = 250;

    // Paginate through all products
    while (true) {
      let url = `https://${shopifyStoreUrl.replace(/^https?:\/\//, '')}/admin/api/2024-01/products.json?limit=${limit}&fields=id,title,variants,status,product_type,vendor,tags,images`;
      if (pageInfo) {
        url = `https://${shopifyStoreUrl.replace(/^https?:\/\//, '')}/admin/api/2024-01/products.json?limit=${limit}&page_info=${pageInfo}`;
      }

      const res = await fetch(url, {
        headers: {
          "X-Shopify-Access-Token": shopifyAccessToken,
          "Content-Type": "application/json",
        },
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Shopify API error [${res.status}]: ${text}`);
      }

      const data = await res.json();
      const products = data.products || [];
      allProducts = allProducts.concat(products);

      // Check for next page via Link header
      const linkHeader = res.headers.get("Link");
      if (linkHeader && linkHeader.includes('rel="next"')) {
        const match = linkHeader.match(/<[^>]*page_info=([^>&]+)[^>]*>;\s*rel="next"/);
        pageInfo = match ? match[1] : null;
        if (!pageInfo) break;
      } else {
        break;
      }
    }

    console.log(`Fetched ${allProducts.length} products from Shopify`);

    // Transform to rows (one per variant)
    const rows: any[] = [];
    let variantOwnImages = 0;
    for (const product of allProducts) {
      const images: any[] = product.images || [];
      const fallbackImage = images[0]?.src || null;
      // A variant points at its own picture by id. `fields=...,images` returns each image's id
      // alongside its src, so this needs no extra API call — the old code simply ignored it.
      const byId = new Map<string, string>();
      for (const im of images) if (im?.id != null && im?.src) byId.set(String(im.id), im.src);
      for (const variant of product.variants || []) {
        const own = variant.image_id != null ? byId.get(String(variant.image_id)) : null;
        if (own) variantOwnImages++;
        rows.push({
          shopify_product_id: String(product.id),
          shopify_variant_id: String(variant.id),
          product_title: product.title || null,
          variant_title: variant.title || null,
          sku: variant.sku || null,
          barcode: variant.barcode || null,
          price: variant.price ? parseFloat(variant.price) : null,
          compare_at_price: variant.compare_at_price ? parseFloat(variant.compare_at_price) : null,
          cost_price: variant.inventory_item?.cost ? parseFloat(variant.inventory_item.cost) : undefined,
          inventory_quantity: variant.inventory_quantity ?? 0,
          product_type: product.product_type || null,
          vendor: product.vendor || null,
          product_status: product.status || null,
          tags: product.tags || null,
          // the variant's OWN image, falling back to the product's first only when it has none
          image_url: own || fallbackImage,
          // a variant present in this run is by definition not deleted — this un-marks one that
          // was retired earlier and has since come back
          removed_at: null,
          synced_at: new Date().toISOString(),
        });
      }
    }

    // Also fetch inventory items to get cost prices
    // Shopify doesn't include cost in products endpoint, need inventory_items
    const variantIds = rows.map((r) => r.shopify_variant_id);
    const BATCH_SIZE = 100;

    for (let i = 0; i < variantIds.length; i += BATCH_SIZE) {
      const batch = variantIds.slice(i, i + BATCH_SIZE);
      const idsParam = batch.join(",");

      try {
        const storeBase = `https://${shopifyStoreUrl.replace(/^https?:\/\//, '')}`;
        const invRes = await fetch(
          `${storeBase}/admin/api/2024-01/variants.json?ids=${idsParam}&fields=id,inventory_item_id`,
          {
            headers: {
              "X-Shopify-Access-Token": shopifyAccessToken,
              "Content-Type": "application/json",
            },
          }
        );

        if (invRes.ok) {
          const invData = await invRes.json();
          const variants = invData.variants || [];

          // Fetch cost for each inventory item
          const inventoryItemIds = variants
            .map((v: any) => v.inventory_item_id)
            .filter(Boolean);

          if (inventoryItemIds.length > 0) {
            const costRes = await fetch(
              `${storeBase}/admin/api/2024-01/inventory_items.json?ids=${inventoryItemIds.join(",")}&fields=id,cost`,
              {
                headers: {
                  "X-Shopify-Access-Token": shopifyAccessToken,
                  "Content-Type": "application/json",
                },
              }
            );

            if (costRes.ok) {
              const costData = await costRes.json();
              const costMap = new Map<string, number>();
              for (const item of costData.inventory_items || []) {
                if (item.cost) costMap.set(String(item.id), parseFloat(item.cost));
              }

              // Map costs back to rows
              for (const v of variants) {
                const cost = costMap.get(String(v.inventory_item_id));
                if (cost !== undefined) {
                  const row = rows.find((r) => r.shopify_variant_id === String(v.id));
                  if (row) row.cost_price = cost;
                }
              }
            }
          }
        }
      } catch (e: any) {
        console.error(`Error fetching inventory batch:`, e.message);
      }
    }

    // Remove undefined cost_price (keep existing in DB)
    const rowsToUpsert = rows.map((r) => {
      const row = { ...r };
      if (row.cost_price === undefined) delete row.cost_price;
      return row;
    });

    // Upsert in batches
    let totalSynced = 0;
    let upsertFailed = false;
    const UPSERT_BATCH = 50;
    for (let i = 0; i < rowsToUpsert.length; i += UPSERT_BATCH) {
      const batch = rowsToUpsert.slice(i, i + UPSERT_BATCH);
      const { error } = await supabase
        .from("shopify_products")
        .upsert(batch, { onConflict: "shopify_variant_id" });

      if (error) {
        console.error(`Upsert error at batch ${i}:`, error.message);
        upsertFailed = true;
      } else {
        totalSynced += batch.length;
      }
    }

    // ── RETIRE WHAT SHOPIFY NO LONGER HAS ────────────────────────────────────
    // Only after a run that actually SAW the catalogue. A Shopify outage that
    // returns an empty list, or a run with a failed batch, must never be read as
    // "everything was deleted" — the guard below is the whole reason this is
    // safe to do automatically.
    let retired = 0;
    if (!upsertFailed && rows.length > 0 && totalSynced === rowsToUpsert.length) {
      const liveIds = new Set(rows.map((r) => r.shopify_variant_id));
      const { data: existing } = await supabase
        .from("shopify_products")
        .select("shopify_variant_id")
        .is("removed_at", null)
        .limit(20000);
      const gone = (existing || [])
        .map((r: any) => String(r.shopify_variant_id))
        .filter((id: string) => !liveIds.has(id));
      // A run that would retire more than a third of the catalogue is far likelier
      // to be a bad read than a real bulk delete — log it and leave the rows alone.
      if (gone.length > 0 && gone.length <= Math.max(20, Math.floor(liveIds.size / 3))) {
        for (let i = 0; i < gone.length; i += 100) {
          const { error } = await supabase
            .from("shopify_products")
            .update({ removed_at: new Date().toISOString() })
            .in("shopify_variant_id", gone.slice(i, i + 100));
          if (!error) retired += gone.slice(i, i + 100).length;
        }
      } else if (gone.length) {
        console.warn(`Refusing to retire ${gone.length} of ${liveIds.size} variants — looks like a bad read, not a delete`);
      }
    }

    // Update sync log
    if (syncId) {
      await supabase
        .from("shopify_product_sync_log")
        .update({
          status: "completed",
          records_synced: totalSynced,
          completed_at: new Date().toISOString(),
        })
        .eq("id", syncId);
    }

    const result = { success: true, records_synced: totalSynced, retired, variant_own_images: variantOwnImages };
    console.log("Sync result:", JSON.stringify(result));

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    console.error("Sync failed:", error.message);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
