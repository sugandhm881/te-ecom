-- Stop apply_kwikship_charges() from un-pricing a shipment KwikShip never weighed.
--
-- THE LOOP THIS BREAKS. `apply_kwikship_charges()` RECOMPUTES `applied_weight` from the courier payload
-- on every run. KwikShip has no weight for a parcel the seller cancelled before pickup (TE25-42790:
-- "seller initiated cancellation", RTO with 0 attempts), so the recompute writes NULL over the 80 g we
-- had from our own order, and the shipment falls back to unpriced — ₹0 — every single run. It has been
-- reported three times, and each previous fix was on the Node side: write the weight back AFTER costing.
-- That is a fix a caller can forget, and one that only works while the fixed code is the code running.
--
-- THIS ONE CANNOT BE FORGOTTEN, because it does not depend on who is calling. Whoever writes the row —
-- the RPC, the nightly sync, a zone re-map, a hand-run statement in the SQL editor — a weight we already
-- had is kept, and a row with no weight at all is given ours before it lands. The courier still wins
-- whenever it actually reports a weight; we only fill the silence.
--
-- Deliberately scoped to source = 'kwikship'. RapidShyp reads real applied weights from its own API and
-- must keep the right to correct one downwards; overriding that would invent a freight variance.
create or replace function public.kwikship_keep_supplied_weight()
returns trigger
language plpgsql
as $$
declare
    w numeric;
begin
    if coalesce(new.source, '') <> 'kwikship' then
        return new;
    end if;
    if new.applied_weight is not null and new.applied_weight > 0 then
        return new;                                    -- the courier weighed it; their number wins
    end if;
    -- Never let a payload carrying no weight erase a weight this row already had.
    if tg_op = 'UPDATE' and old.applied_weight is not null and old.applied_weight > 0 then
        new.applied_weight := old.applied_weight;
        return new;
    end if;
    -- Nothing to preserve, so seed it from what we shipped. Order names carry a '#' on one side only.
    select o.total_weight into w
      from public.orders o
     where replace(o.name, '#', '') = replace(coalesce(new.order_name, ''), '#', '')
       and o.total_weight > 0
     limit 1;
    if w is not null then
        new.applied_weight := w;
    end if;
    return new;
end;
$$;

-- Named to sort first: BEFORE triggers fire in alphabetical order, and the weight has to be in place
-- before anything that prices off it runs.
drop trigger if exists a_kwikship_keep_weight on public.shipment_journey_ecom;
create trigger a_kwikship_keep_weight
before insert or update on public.shipment_journey_ecom
for each row execute function public.kwikship_keep_supplied_weight();

-- Repair what the loop already emptied.
update public.shipment_journey_ecom j
   set applied_weight = o.total_weight
  from public.orders o
 where j.source = 'kwikship'
   and j.applied_weight is null
   and replace(o.name, '#', '') = replace(coalesce(j.order_name, ''), '#', '')
   and o.total_weight > 0;

comment on function public.kwikship_keep_supplied_weight() is
  'Keeps a KwikShip shipment''s applied_weight when the courier payload carries none — the RPC '
  'recomputes that column every run and would otherwise blank it, un-pricing the shipment (TE25-42790).';
