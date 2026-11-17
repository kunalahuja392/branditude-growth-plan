\set ON_ERROR_STOP 1
do $$ declare st gc_stations; r gc_rules; x record; begin
  select * into st from gc_stations where name = 'PS5 #1' limit 1;
  update gc_stations set included_players = 4, extra_player_rate = 0, time_rates = '[]' where id = st.id; select * into st from gc_stations where id = st.id;
  r := row(gen_random_uuid(), st.business_id, 'Night', '#' || st.id, '{0,1,2,3,4,5,6}', '00:00', '10:00', 'fixed', 150, 5, true, now(), 50)::gc_rules;
  x := gc_rate_at(st, array[r], 1, ('2026-11-18 01:00'::timestamp at time zone 'Asia/Kolkata')); assert x.rate = 150, 'night solo ' || x.rate;
  x := gc_rate_at(st, array[r], 2, ('2026-11-18 01:00'::timestamp at time zone 'Asia/Kolkata')); assert x.rate = 200, 'night duo ' || x.rate;
  x := gc_rate_at(st, array[r], 2, ('2026-11-18 14:00'::timestamp at time zone 'Asia/Kolkata')); assert x.rate = st.rate, 'day duo = station price ' || x.rate;
  raise notice 'RULE EXTRA OK';
end $$;
