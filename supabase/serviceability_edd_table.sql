-- EDD / serviceability cache keyed by pickup-delivery-weight bucket.
-- Stores transit DAYS (relative) so rows stay valid across calendar dates;
-- absolute EDD dates are recomputed from "today" at read time.
-- The app degrades gracefully if this table is absent (it just calls the API live).

create table if not exists public.serviceability_edd_ecom (
    cache_key         text primary key,            -- "<pickup>-<delivery>-<weight>" e.g. "122101-110068-0.5"
    pickup_pincode    text not null,
    delivery_pincode  text not null,
    weight            numeric not null,            -- weight bucket in kg (0.5 increments)
    serviceable       boolean,
    courier_count     integer,
    fastest_days      integer,                     -- transit days for the fastest courier
    slowest_days      integer,                     -- transit days for the slowest courier
    earliest_cutoff   text,                        -- earliest dispatch cutoff "HH:MM" across couriers
    cheapest_freight  numeric,
    checked_at        timestamptz default now(),   -- used for TTL freshness (7 days)
    updated_at        timestamptz default now()
);

create index if not exists idx_serviceability_edd_delivery
    on public.serviceability_edd_ecom (delivery_pincode);
create index if not exists idx_serviceability_edd_checked_at
    on public.serviceability_edd_ecom (checked_at);
