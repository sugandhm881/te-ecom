-- 2026-08-29 — India Post's "All India Pincode Directory" (data.gov.in CSV) as a PERMANENT table.
-- The user downloaded the official directory (~160k post offices: circle, region, division, office,
-- pincode, office type, delivery flag, district, state, lat/long). One import replaces ~30k live API
-- calls: Zone & State rows are filled from it in one statement, and the Pincode→City/State autofill can
-- answer from it offline. Import with `node tools/import_pincode_directory.js <csv> [--replace]` or the
-- admin upload on Zone Mapping → Zone & State. APPLIED to the live project on 2026-08-29 via the Supabase MCP.

create table if not exists india_pincode_directory_ecom (
  id bigserial primary key,
  circlename text, regionname text, divisionname text, officename text,
  pincode text not null, officetype text, delivery text, district text, statename text,
  latitude numeric, longitude numeric,
  imported_at timestamptz not null default now(),
  unique (pincode, officename)
);
create index if not exists idx_pincode_dir_pin on india_pincode_directory_ecom(pincode);
alter table india_pincode_directory_ecom enable row level security;   -- service-role only

-- One row per pincode: state/district straight from the directory; city = the head office name when the
-- pincode has one (H.O / G.P.O), else the division name with postal suffixes stripped (the same rule the
-- Pincode→City autofill uses against the live API).
create or replace function public.pincode_directory_summary()
returns table(pincode text, city text, district text, state text, offices bigint) language sql stable as $$
  with d as (select * from india_pincode_directory_ecom),
  ho as (select pincode, min(regexp_replace(officename, '\s*(H\.?O\.?|G\.?P\.?O\.?)\s*$', '', 'i')) as ho_name
           from d where officename ~* '\s(H\.?O\.?|G\.?P\.?O\.?)\s*$' group by pincode),
  dv as (select pincode, min(regexp_replace(regexp_replace(divisionname, '\s+(Division|Dn\.?)\s*$', '', 'i'), '\s+(North|South|East|West|Central|City|GPO|HQ|H\.O\.?)\s*$', '', 'i')) as div_name from d group by pincode)
  select d.pincode,
         initcap(coalesce(ho.ho_name, dv.div_name)) as city,
         initcap(min(d.district)) as district,
         public.canon_state(min(d.statename)) as state,
         count(*) as offices
    from d left join ho on ho.pincode = d.pincode left join dv on dv.pincode = d.pincode
   group by d.pincode, ho.ho_name, dv.div_name
$$;

-- Fill the zone rows from the directory (source 'indiapost' — it IS India Post). Idempotent.
create or replace function public.zone_mapping_fill_from_directory() returns integer language plpgsql as $$
declare v_n integer; v_m integer;
begin
  update zone_mapping_with_pincode z
     set state = s.state, city = s.city, district = s.district, state_source = 'indiapost'
    from public.pincode_directory_summary() s
   where s.pincode = z."Pin_code_To"::text and s.state is not null
     and (z.state_source is distinct from 'indiapost' or z.state is distinct from s.state or z.city is distinct from s.city or z.district is distinct from s.district);
  get diagnostics v_n = row_count;
  -- A sheet pincode absent from the whole directory is NOT a real India Post pincode (courier sheets pad
  -- ranges: 110000, 110100-110108 …). Say so, instead of "resolving" forever. Order-typed rows keep their
  -- label — a customer did type it — but they are equally not in the directory. Guarded on a loaded
  -- directory (>100k offices) so a partial/sample import can never stamp the whole sheet.
  update zone_mapping_with_pincode z set state_source = 'not_in_directory', state = null, city = null, district = null
   where z.state_source is null and (select count(*) from india_pincode_directory_ecom) > 100000
     and not exists (select 1 from india_pincode_directory_ecom d where d.pincode = z."Pin_code_To"::text);
  get diagnostics v_m = row_count;
  return v_n + v_m;
end $$;

-- Per-state counts for the filter; the not-in-directory bucket is its own pseudo-state (return type changed → drop first).
drop function if exists public.zone_mapping_states();
create or replace function public.zone_mapping_states() returns table(state text, pincodes bigint, indiapost bigint, orders bigint, prefix bigint, not_in_directory bigint) language sql stable as $$
  select coalesce(state, case when state_source = 'not_in_directory' then '(not an India Post pincode)' else '(unknown)' end), count(*),
         count(*) filter (where state_source = 'indiapost'), count(*) filter (where state_source = 'orders'), count(*) filter (where state_source = 'prefix'), count(*) filter (where state_source = 'not_in_directory')
    from zone_mapping_with_pincode group by 1 order by 2 desc
$$;

create or replace function public.pincode_directory_count() returns bigint language sql stable as $$ select count(distinct pincode) from india_pincode_directory_ecom $$;

-- Single-pincode lookup for the Pincode→City/State autofill (same city rule as the summary).
create or replace function public.pincode_directory_lookup(p_pin text)
returns table(pincode text, city text, district text, state text, offices bigint) language sql stable as $$
  with d as (select * from india_pincode_directory_ecom where pincode = p_pin),
  ho as (select min(regexp_replace(officename, '\s*(H\.?O\.?|G\.?P\.?O\.?)\s*$', '', 'i')) as ho_name from d where officename ~* '\s(H\.?O\.?|G\.?P\.?O\.?)\s*$'),
  dv as (select min(regexp_replace(regexp_replace(divisionname, '\s+(Division|Dn\.?)\s*$', '', 'i'), '\s+(North|South|East|West|Central|City|GPO|HQ|H\.O\.?)\s*$', '', 'i')) as div_name from d)
  select p_pin, initcap(coalesce((select ho_name from ho), (select div_name from dv))), initcap(min(d.district)), public.canon_state(min(d.statename)), count(*)
    from d having count(*) > 0
$$;

-- ── 2026-08-29 (evening), user: "I think that guess method works fine — use all 4 sources" ─────────────
-- The ladder, best source first; every row records which one it came from and a better one always
-- replaces a weaker one on the next fill:  indiapost > orders > nearest > prefix.
create or replace function public.state_from_pin_prefix(p_pin text) returns text language sql immutable as $$
  select case
    when p_pin ~ '^11' then 'Delhi'
    when p_pin ~ '^(12|13)' then 'Haryana'
    when p_pin ~ '^160' then 'Chandigarh'
    when p_pin ~ '^(14|15|16)' then 'Punjab'
    when p_pin ~ '^17' then 'Himachal Pradesh'
    when p_pin ~ '^(18|19)' then 'Jammu & Kashmir'
    when p_pin ~ '^(244|246|247|248|249|262|263)' then 'Uttarakhand'
    when p_pin ~ '^(2[0-8])' then 'Uttar Pradesh'
    when p_pin ~ '^(3[0-4])' then 'Rajasthan'
    when p_pin ~ '^396' then 'Dadra & Nagar Haveli and Daman & Diu'
    when p_pin ~ '^(3[6-9])' then 'Gujarat'
    when p_pin ~ '^403' then 'Goa'
    when p_pin ~ '^(4[0-4])' then 'Maharashtra'
    when p_pin ~ '^(4[5-8])' then 'Madhya Pradesh'
    when p_pin ~ '^49' then 'Chhattisgarh'
    when p_pin ~ '^50' then 'Telangana'
    when p_pin ~ '^(5[1-3])' then 'Andhra Pradesh'
    when p_pin ~ '^(5[6-9])' then 'Karnataka'
    when p_pin ~ '^605' then 'Puducherry'
    when p_pin ~ '^(6[0-4])' then 'Tamil Nadu'
    when p_pin ~ '^6825' then 'Lakshadweep'
    when p_pin ~ '^(6[7-9])' then 'Kerala'
    when p_pin ~ '^737' then 'Sikkim'
    when p_pin ~ '^744' then 'Andaman & Nicobar Islands'
    when p_pin ~ '^(7[0-4])' then 'West Bengal'
    when p_pin ~ '^(7[5-7])' then 'Odisha'
    when p_pin ~ '^78' then 'Assam'
    when p_pin ~ '^(790|791|792)' then 'Arunachal Pradesh'
    when p_pin ~ '^(793|794)' then 'Meghalaya'
    when p_pin ~ '^795' then 'Manipur'
    when p_pin ~ '^796' then 'Mizoram'
    when p_pin ~ '^(797|798)' then 'Nagaland'
    when p_pin ~ '^799' then 'Tripura'
    when p_pin ~ '^(81[3-9]|82|83[1-5])' then 'Jharkhand'
    when p_pin ~ '^(8[0-5])' then 'Bihar'
    else null end
$$;

-- Tier 3: the nearest REAL pincode in the same 3-digit sorting district (India Post's own structure —
-- the first three digits are one sorting office, so its neighbours share state and district). Set-based
-- with LAG/LEAD; the correlated version timed out at 11k × 19k comparisons.
create or replace function public.zone_mapping_fill_nearest() returns integer language plpgsql as $$
declare v_n integer;
begin
  with dir as (select pincode::int as p, district, state from public.pincode_directory_summary() where state is not null),
  todo as (select z."Pin_code_To" as p from zone_mapping_with_pincode z where z.state_source in ('not_in_directory','prefix') or z.state_source is null),
  allp as (select p, true as is_dir from dir union all select p, false from todo),
  seq as (
    select p, is_dir,
           max(case when is_dir then p end) over (partition by p/1000 order by p, is_dir desc rows between unbounded preceding and 1 preceding) as prev_dir,
           min(case when is_dir then p end) over (partition by p/1000 order by p, is_dir desc rows between 1 following and unbounded following) as next_dir
      from allp),
  pick as (
    select p, case when prev_dir is null then next_dir when next_dir is null then prev_dir
                   when (p - prev_dir) <= (next_dir - p) then prev_dir else next_dir end as near
      from seq where not is_dir)
  update zone_mapping_with_pincode z
     set state = d.state, district = d.district, city = null, state_source = 'nearest'
    from pick c join dir d on d.p = c.near
   where z."Pin_code_To" = c.p and c.near is not null;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- Tier 4: postal-prefix map, state only.
create or replace function public.zone_mapping_fill_prefix() returns integer language plpgsql as $$
declare v_n integer;
begin
  update zone_mapping_with_pincode z set state = public.state_from_pin_prefix(z."Pin_code_To"::text), city = null, district = null, state_source = 'prefix'
   where (z.state_source in ('not_in_directory') or z.state_source is null) and public.state_from_pin_prefix(z."Pin_code_To"::text) is not null;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- One call runs the whole ladder in precedence order.
create or replace function public.zone_mapping_fill_all() returns integer language plpgsql as $$
begin
  return public.zone_mapping_fill_from_directory() + public.zone_mapping_fill_state() + public.zone_mapping_fill_nearest() + public.zone_mapping_fill_prefix();
end $$;

drop function if exists public.zone_mapping_states();
create or replace function public.zone_mapping_states() returns table(state text, pincodes bigint, indiapost bigint, orders bigint, nearest bigint, prefix bigint, not_in_directory bigint) language sql stable as $$
  select coalesce(state, case when state_source = 'not_in_directory' then '(not an India Post pincode)' else '(unknown)' end), count(*),
         count(*) filter (where state_source = 'indiapost'), count(*) filter (where state_source = 'orders'), count(*) filter (where state_source = 'nearest'), count(*) filter (where state_source = 'prefix'), count(*) filter (where state_source = 'not_in_directory')
    from zone_mapping_with_pincode group by 1 order by 2 desc
$$;
select public.zone_mapping_fill_all();
