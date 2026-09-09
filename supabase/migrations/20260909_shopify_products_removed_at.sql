-- ─────────────────────────────────────────────────────────────────────────────
-- A VARIANT DELETED IN SHOPIFY LIVED FOREVER IN OUR MIRROR.
--
-- `sync-shopify-products` only ever upserted, so a variant removed from Shopify
-- kept its row. 27 of 198 rows were ghosts on 09-Sep-2026 — including TE-2SAS1
-- and TE-BDR2, which the influencer picker was still counting into the stock
-- total for the Ultimate Clear Skin Combo.
--
-- Marked, not deleted: cost_price and historical joins live on these rows, and a
-- catalogue row that vanishes takes an old order's product name with it. The
-- picker filters `removed_at is null`; everything else can still see them.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.shopify_products
    add column if not exists removed_at timestamptz;

comment on column public.shopify_products.removed_at is
    'When a sync run stopped finding this variant in Shopify (i.e. it was deleted there). NULL = still live. Cleared automatically if the variant reappears.';

create index if not exists shopify_products_live_idx
    on public.shopify_products (product_status)
    where removed_at is null;
