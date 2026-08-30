-- 2026-08-30 · amazon_order_items: a UNIQUE index on order_item_id alone.
-- An external sync (not in this repo — n8n/script hitting PostgREST) upserts with ON CONFLICT (order_item_id),
-- but the only unique key was the composite (amazon_order_id, order_item_id), so Postgres rejected every
-- such call (2,586 errors in a week) and that writer's rows were dropped. Amazon's OrderItemId is globally
-- unique by definition, and the live table (13,938 rows on 2026-08-30) has 13,938 distinct, non-null values —
-- so this index adds a true fact, changes no row, and makes the existing upsert land. The composite key stays.
create unique index concurrently if not exists uq_amazon_order_items_order_item_id
    on public.amazon_order_items (order_item_id);
