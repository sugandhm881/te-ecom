-- "Handed to MWH" list — orders already reported as DocPharma-rejected to the
-- dp-to-mwh-orders Slack channel. Once an order is here it is NEVER DocPharma-checked
-- again: MWH re-ships it and it is tracked via RapidShyp from then on.
-- The app degrades gracefully if this table is absent (it just won't dedupe).

create table if not exists public.dp_rejected_handled_ecom (
    order_name        text primary key,          -- normalized Shopify order name, no leading "#"
    status            text default 'reported',   -- 'reported' = handed to MWH
    first_reported_at timestamptz default now(),
    updated_at        timestamptz default now()
);
