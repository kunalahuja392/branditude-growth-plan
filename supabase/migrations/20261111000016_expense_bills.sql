-- Expense bills and admin-managed categories
-- 1) Each entry can carry a bill (photo or PDF) stored privately at bills/<business_id>/<file>
-- 2) Only the owner or an admin can add or change categories; staff with accounts access just pick from the list

alter table public.acc_vouchers add column if not exists bill_path text;

create or replace function public.biz_admin(b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_staff() or exists (select 1 from public.business_members m where m.business_id = b and m.user_id = auth.uid() and m.role in ('owner', 'admin'))
$$;
revoke execute on function public.biz_admin(uuid) from public, anon;
grant execute on function public.biz_admin(uuid) to authenticated;

-- Categories: owner/admin only
create or replace function public.acc_head_save(p_business uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid := nullif(p->>'id', '')::uuid; v_sys text;
begin
  if not public.can_use(p_business, 'accounting') then raise exception 'Accounts are locked for this account'; end if;
  if not public.biz_admin(p_business) then raise exception 'Only the owner or an admin can add or change categories'; end if;
  if length(trim(coalesce(p->>'name', ''))) = 0 then raise exception 'Enter a name'; end if;
  if v_id is not null then
    select system_key into v_sys from public.acc_heads where id = v_id and business_id = p_business;
    if not found then raise exception 'Category not found'; end if;
    update public.acc_heads set name = trim(p->>'name'), gst_rate = coalesce((p->>'gst_rate')::numeric, gst_rate),
      active = coalesce((p->>'active')::boolean, active),
      kind = case when v_sys is null and not exists (select 1 from public.acc_lines where head_id = v_id) then coalesce(p->>'kind', kind) else kind end,
      class = case when v_sys is null and not exists (select 1 from public.acc_lines where head_id = v_id) then coalesce(p->>'class', class) else class end
      where id = v_id;
    return v_id;
  end if;
  insert into public.acc_heads (business_id, name, kind, class, gst_rate)
    values (p_business, trim(p->>'name'), p->>'kind', p->>'class', coalesce((p->>'gst_rate')::numeric, 0)) returning id into v_id;
  return v_id;
exception when unique_violation then raise exception 'A category with that name already exists';
end $$;
drop policy if exists acc_heads_write on public.acc_heads;
revoke update on public.acc_heads from authenticated;

-- Entries keep their bill when edited; a bill must sit in this business's folder
create or replace function public.acc_post(p_business uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_old text; v_bill text;
begin
  if not public.can_use(p_business, 'accounting') then raise exception 'Accounts are locked for this account'; end if;
  perform public.acc_setup_internal(p_business);
  if nullif(p->>'id', '') is not null then
    select bill_path into v_old from public.acc_vouchers where id = (p->>'id')::uuid and business_id = p_business and source = 'manual';
    if not found then raise exception 'This entry was added automatically. Change it where it came from.'; end if;
  end if;
  v_bill := case when p ? 'bill_path' then nullif(p->>'bill_path', '') else v_old end;
  if v_bill is not null and (v_bill not like p_business::text || '/%' or v_bill like '%..%') then raise exception 'Bill file is not valid'; end if;
  v_id := public.acc_post_internal(p_business, (p - 'source' - 'source_ref' - 'bill_path'), auth.uid());
  update public.acc_vouchers set bill_path = v_bill where id = v_id;
  return v_id;
end $$;
