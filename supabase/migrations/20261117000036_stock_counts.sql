-- Daily opening / closing stock counts (optional per product). Staff count without seeing what the system expects;
-- any difference is kept for the owner to review and acknowledge. After a count the system stock is set to what was counted.
alter table public.gc_products add column if not exists daily_count boolean not null default false;

create table if not exists public.gc_stock_counts (
  id           bigserial primary key,
  business_id  uuid not null references public.businesses(id) on delete cascade,
  day          date not null,
  kind         text not null check (kind in ('opening','closing')),
  product_id   uuid references public.gc_products(id) on delete set null,
  product_name text not null,
  price        numeric(10,2) not null default 0,
  expected     int not null,
  counted      int not null,
  diff         int not null,
  opening      int,          -- closing only: today's opening count
  sold         int,          -- closing only: sold on today's bills
  ack_by       uuid references auth.users(id),
  ack_at       timestamptz,
  ack_note     text,
  created_by   uuid references auth.users(id),
  created_at   timestamptz not null default now(),
  unique (business_id, day, kind, product_id)
);
create index if not exists gc_stock_counts_b on public.gc_stock_counts (business_id, day desc);
alter table public.gc_stock_counts enable row level security;
drop policy if exists gc_stock_counts_read on public.gc_stock_counts;
create policy gc_stock_counts_read on public.gc_stock_counts for select using (public.gc_can_setup(business_id));   -- owners only: staff count blind
revoke all on public.gc_stock_counts from anon;
grant select on public.gc_stock_counts to authenticated;

-- Staff: save today's opening or closing count. p_counts: [{product_id, counted}]
create or replace function public.gc_stock_count(p_business uuid, p_kind text, p_counts jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d date := (now() at time zone 'Asia/Kolkata')::date; a timestamptz := ((now() at time zone 'Asia/Kolkata')::date)::timestamp at time zone 'Asia/Kolkata';
        it jsonb; pr public.gc_products; prev public.gc_stock_counts; ex int; n int; o int; sd int; k int := 0; bad int := 0; rows jsonb := '[]'; own boolean;
begin
  perform public.gc_guard(p_business);
  if p_kind not in ('opening','closing') then raise exception 'Choose opening or closing'; end if;
  own := public.gc_can_setup(p_business);
  for it in select * from jsonb_array_elements(coalesce(p_counts, '[]')) loop
    if coalesce(it->>'counted', '') = '' then continue; end if;
    n := (it->>'counted')::numeric::int; if n < 0 then raise exception 'A count can''t be below zero'; end if;
    select * into pr from public.gc_products where id = (it->>'product_id')::uuid and business_id = p_business and daily_count for update;
    if not found then continue; end if;
    if exists (select 1 from public.gc_stock_counts where business_id = p_business and day = d and kind = p_kind and product_id = pr.id and ack_at is not null) then
      raise exception '% was already counted and checked by the owner today', pr.name; end if;
    o := null; sd := null;
    if p_kind = 'closing' then
      select counted into o from public.gc_stock_counts where business_id = p_business and day = d and kind = 'opening' and product_id = pr.id;
      select coalesce(sum(i.qty), 0)::int into sd from public.gc_items i join public.gc_bills v on v.id = i.bill_id
       where i.product_id = pr.id and v.business_id = p_business and v.status <> 'void' and v.created_at >= a;
    end if;
    -- a recount the same day compares with what the system would expect without the first count's correction
    select * into prev from public.gc_stock_counts where business_id = p_business and day = d and kind = p_kind and product_id = pr.id;
    ex := pr.stock - coalesce(prev.diff, 0);
    if prev.id is null then
      insert into public.gc_stock_counts (business_id, day, kind, product_id, product_name, price, expected, counted, diff, opening, sold, created_by)
      values (p_business, d, p_kind, pr.id, pr.name, pr.price, ex, n, n - ex, o, sd, auth.uid());
    else
      update public.gc_stock_counts set expected = ex, counted = n, diff = n - ex, opening = o, sold = sd, price = pr.price, created_by = auth.uid(), created_at = now() where id = prev.id;
    end if;
    update public.gc_products set stock = n where id = pr.id;
    k := k + 1;
    if n <> ex then bad := bad + 1; end if;
    if own then rows := rows || (select to_jsonb(c) from public.gc_stock_counts c where business_id = p_business and day = d and kind = p_kind and product_id = pr.id); end if;
  end loop;
  if k = 0 then raise exception 'Enter at least one count'; end if;
  return jsonb_build_object('counted', k, 'mismatched', bad, 'rows', rows);
end $$;
revoke execute on function public.gc_stock_count(uuid, text, jsonb) from public, anon;
grant execute on function public.gc_stock_count(uuid, text, jsonb) to authenticated;

-- Board / stock page: what's counted today, and (owners) differences waiting to be checked
create or replace function public.gc_stock_status(p_business uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d date := (now() at time zone 'Asia/Kolkata')::date;
begin
  perform public.gc_guard(p_business);
  return jsonb_build_object(
    'day', d,
    'products', (select count(*) from public.gc_products where business_id = p_business and daily_count and active),
    'opening_at', (select max(created_at) from public.gc_stock_counts where business_id = p_business and day = d and kind = 'opening'),
    'closing_at', (select max(created_at) from public.gc_stock_counts where business_id = p_business and day = d and kind = 'closing'),
    'opening_n', (select count(*) from public.gc_stock_counts where business_id = p_business and day = d and kind = 'opening'),
    'closing_n', (select count(*) from public.gc_stock_counts where business_id = p_business and day = d and kind = 'closing'),
    'to_check', case when public.gc_can_setup(p_business) then (select count(*) from public.gc_stock_counts where business_id = p_business and diff <> 0 and ack_at is null) end);
end $$;
revoke execute on function public.gc_stock_status(uuid) from public, anon;
grant execute on function public.gc_stock_status(uuid) to authenticated;

-- Owner: acknowledge differences (with an optional note)
create or replace function public.gc_stock_ack(p_business uuid, p_ids bigint[], p_note text default null) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.gc_can_setup(p_business) then raise exception 'Only the owner can check stock differences'; end if;
  update public.gc_stock_counts set ack_by = auth.uid(), ack_at = now(), ack_note = nullif(trim(coalesce(p_note, '')), '')
   where business_id = p_business and id = any(p_ids) and ack_at is null;
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.gc_stock_ack(uuid, bigint[], text) from public, anon;
grant execute on function public.gc_stock_ack(uuid, bigint[], text) to authenticated;
