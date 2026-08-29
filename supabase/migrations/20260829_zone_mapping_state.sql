-- 2026-08-29 — Zone Mapping gets CITY, DISTRICT and STATE per destination pincode (Admin → Zone Mapping → "Zone & State").
-- KwikShip's serviceability sheet has none of them (30,903 pincodes, zone + courier flags only). Two sources,
-- best wins and never downgrades, and NOTHING is inferred from the number itself (user: "don't guess anything"):
--   1. indiapost — India Post's official pincode directory via its free API, cached once per pincode in
--                  pincode_geo_ecom (the Pincode→City/State autofill already uses it). City, district, state.
--   2. orders    — re-admitted on instruction ("you can use our order data also"): the state/city customers
--                  typed on order_shipping_addresses for that zip. Labelled 'orders' on every row, used ONLY
--                  where India Post has not answered, replaced the moment it does (a customer typed "Kerala"
--                  on 638003 — Erode; India Post corrects it).
-- A pincode with neither stays NULL ("resolving"). enrichZoneStates() in zone_mapping.js walks unanswered
-- pincodes through India Post (10 workers, ~10/s — measured 16 parallel calls in 1.3 s, no throttling), the
-- trigger below stamps the zone row the moment an answer lands, and cron ZoneStates (03:30 IST) continues
-- 3,000 a night. A postal-prefix guess was built and REMOVED the same day.
-- APPLIED to the live project on 2026-08-29 via the Supabase MCP.

alter table zone_mapping_with_pincode add column if not exists state text;
alter table zone_mapping_with_pincode add column if not exists state_source text;   -- 'indiapost' | 'orders' | NULL (resolving)
alter table zone_mapping_with_pincode add column if not exists city text;
alter table zone_mapping_with_pincode add column if not exists district text;
create index if not exists idx_zone_mapping_district on zone_mapping_with_pincode(district);
create index if not exists idx_zone_mapping_state on zone_mapping_with_pincode(state);

-- One spelling per state, whichever source it came from ("Jammu And Kashmir" / "Jammu & Kashmir",
-- "Orissa" / "Odisha", "Pondicherry" / "Puducherry" …) — otherwise the filter lists one state twice.
create or replace function public.canon_state(p text) returns text language sql immutable as $$
  select case s
    when 'Jammu And Kashmir' then 'Jammu & Kashmir'
    when 'Andaman And Nicobar Islands' then 'Andaman & Nicobar Islands'
    when 'Andaman & Nicobar' then 'Andaman & Nicobar Islands'
    when 'Dadra And Nagar Haveli' then 'Dadra & Nagar Haveli and Daman & Diu'
    when 'Dadra & Nagar Haveli' then 'Dadra & Nagar Haveli and Daman & Diu'
    when 'Daman And Diu' then 'Dadra & Nagar Haveli and Daman & Diu'
    when 'Daman & Diu' then 'Dadra & Nagar Haveli and Daman & Diu'
    when 'Dadra And Nagar Haveli And Daman And Diu' then 'Dadra & Nagar Haveli and Daman & Diu'
    when 'Orissa' then 'Odisha'
    when 'Pondicherry' then 'Puducherry'
    when 'Uttaranchal' then 'Uttarakhand'
    when 'Nct Of Delhi' then 'Delhi'
    when 'New Delhi' then 'Delhi'
    when 'Telengana' then 'Telangana'
    when 'Chattisgarh' then 'Chhattisgarh'
    when 'Tamilnadu' then 'Tamil Nadu'
    else s end
  from (select initcap(regexp_replace(trim(coalesce(p,'')), '\s+', ' ', 'g')) as s) x
$$;

create or replace function public.zone_mapping_fill_state() returns integer language plpgsql as $$
declare v_n integer := 0; v_t integer;
begin
  -- tier 1: India Post (official; always wins)
  update zone_mapping_with_pincode z
     set state = public.canon_state(g.state), city = nullif(initcap(trim(g.city)),''), district = nullif(initcap(trim(g.district)),''), state_source = 'indiapost'
    from pincode_geo_ecom g
   where g.pincode::text = z."Pin_code_To"::text and g.state is not null and g.state <> ''
     and (z.state_source is distinct from 'indiapost' or z.state is distinct from public.canon_state(g.state)
          or z.city is distinct from nullif(initcap(trim(g.city)),'') or z.district is distinct from nullif(initcap(trim(g.district)),''));
  get diagnostics v_t = row_count; v_n := v_n + v_t;
  -- tier 2: our own order addresses (customer-typed), only where India Post has not answered yet
  with addr as (
    select regexp_replace(zip, '\D', '', 'g') as pin,
           public.canon_state(mode() within group (order by upper(trim(province)))) as state,
           nullif(initcap(mode() within group (order by upper(trim(city)))),'') as city
      from order_shipping_addresses where zip is not null and province is not null and trim(province) <> '' group by 1)
  update zone_mapping_with_pincode z set state = a.state, city = a.city, district = null, state_source = 'orders'
    from addr a
   where a.pin = z."Pin_code_To"::text and a.state <> '' and z.state_source is distinct from 'indiapost'
     and (z.state_source is null or z.state is distinct from a.state or z.city is distinct from a.city);
  get diagnostics v_t = row_count; v_n := v_n + v_t;
  return v_n;
end $$;

-- A fresh India Post answer lands on the zone row immediately.
create or replace function public.pincode_geo_zone_trg() returns trigger language plpgsql as $$
begin
  if new.state is not null and new.state <> '' then
    update zone_mapping_with_pincode set state = public.canon_state(new.state), city = nullif(initcap(trim(new.city)),''), district = nullif(initcap(trim(new.district)),''), state_source = 'indiapost'
     where "Pin_code_To"::text = new.pincode::text;
  end if;
  return new;
end $$;
drop trigger if exists trg_pincode_geo_zone on pincode_geo_ecom;
create trigger trg_pincode_geo_zone after insert or update of state, city, district on pincode_geo_ecom for each row execute function public.pincode_geo_zone_trg();

-- Per-state counts for the filter (one round trip). `prefix` is kept in the shape for the UI but is always 0.
create or replace function public.zone_mapping_states() returns table(state text, pincodes bigint, indiapost bigint, orders bigint, prefix bigint) language sql stable as $$
  select coalesce(state, '(unknown)'), count(*),
         count(*) filter (where state_source = 'indiapost'), count(*) filter (where state_source = 'orders'), count(*) filter (where state_source = 'prefix')
    from zone_mapping_with_pincode group by 1 order by 2 desc
$$;

select public.zone_mapping_fill_state();
