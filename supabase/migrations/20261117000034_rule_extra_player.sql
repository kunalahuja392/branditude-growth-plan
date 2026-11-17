-- A pricing rule can set its own price per extra player (each player after the first), e.g. night PS5: solo ₹150, duo ₹200.
alter table public.gc_rules add column if not exists per_extra_player numeric(10,2) check (per_extra_player is null or per_extra_player >= 0);

create or replace function public.gc_rate_at(st public.gc_stations, rules public.gc_rules[], players int, ts timestamptz, out rate numeric, out rule text)
language plpgsql immutable as $$
declare r public.gc_rules; best public.gc_rules; extra numeric; base numeric; band record;
begin
  extra := greatest(0, coalesce(players, 1) - st.included_players) * st.extra_player_rate;
  band := public.gc_band_rate(st, ts); base := coalesce(band.rate, st.rate);
  rate := base + extra; rule := band.label;
  if rules is not null then
    foreach r in array rules loop
      if public.gc_rule_hits(r, st, ts) and (best.id is null or r.priority > best.priority or (r.priority = best.priority and r.created_at > best.created_at)) then best := r; end if;
    end loop;
  end if;
  if best.id is not null then
    rule := best.name;
    if best.per_extra_player is not null then extra := greatest(0, coalesce(players, 1) - 1) * best.per_extra_player; end if;
    rate := case best.mode when 'fixed' then best.value + extra when 'percent' then (base + extra) * (1 - best.value / 100) else base + extra + best.value end;
  end if;
  rate := greatest(rate, 0);
end $$;
alter function public.gc_rate_at(public.gc_stations, public.gc_rules[], int, timestamptz) set search_path = public;
