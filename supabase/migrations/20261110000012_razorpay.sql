-- Razorpay: pay online (UPI, cards, netbanking, wallets). A verified Razorpay payment confirms the
-- Branditude payment automatically; manual UPI + UTR stays as a fallback.

insert into public.settings (key, value, public) values ('razorpay', '{"key_id":"","enabled":false}', true)
on conflict (key) do nothing;

-- Shared confirmation logic (staff confirm or Razorpay). Not callable from the browser.
create or replace function public.apply_payment(p_payment uuid, p_approve boolean, p_by uuid) returns void
language plpgsql security definer set search_path = public as $$
declare pay record; v_pkg uuid; v_billing text; v_ends date; v_status text; v_cur date; v_mods text[];
begin
  select * into pay from public.payments where id = p_payment for update;
  if not found or pay.status <> 'pending' then raise exception 'Payment is not pending'; end if;
  update public.payments set status = case when p_approve then 'confirmed' else 'rejected' end,
         confirmed_by = p_by, confirmed_at = now() where id = p_payment;
  if not p_approve then return; end if;
  if pay.kind = 'subscription' then
    v_pkg := (pay.meta->>'package_id')::uuid; v_billing := coalesce(pay.meta->>'billing','monthly');
    select status, subscription_ends into v_status, v_cur from public.businesses where id = pay.business_id;
    v_ends := (case when v_status = 'active' then greatest(coalesce(v_cur, current_date), current_date) else current_date end)
              + case when v_billing='yearly' then interval '1 year' else interval '1 month' end;
    select coalesce(modules, '{}') into v_mods from public.packages where id = v_pkg;
    update public.businesses set status = 'active', package_id = v_pkg, billing = v_billing, subscription_ends = v_ends,
           wa_enabled = wa_enabled or coalesce((select includes_whatsapp from public.packages where id = v_pkg), false),
           addon_modules = array(select unnest(addon_modules) except select unnest(v_mods))
     where id = pay.business_id;
    if pay.meta->>'promo_code' is not null then update public.promo_codes set used = used + 1 where upper(code) = pay.meta->>'promo_code'; end if;
    update public.leads set status = 'won', updated_at = now() where id = pay.lead_id;
  elsif pay.kind = 'module' then
    update public.businesses set addon_modules = array(select distinct unnest(addon_modules || array[pay.meta->>'module']))
     where id = pay.business_id;
  elsif pay.kind = 'wa_credits' then
    insert into public.wa_wallets (business_id, balance) values (pay.business_id, 0) on conflict do nothing;
    update public.wa_wallets set balance = balance + (pay.meta->>'credits')::int, updated_at = now() where business_id = pay.business_id;
    insert into public.wa_ledger (business_id, delta, reason, ref, created_by) values (pay.business_id, (pay.meta->>'credits')::int, 'Credit pack purchase', pay.id::text, p_by);
    update public.businesses set wa_enabled = true where id = pay.business_id;
  end if;
end $$;
revoke execute on function public.apply_payment(uuid, boolean, uuid) from public, anon, authenticated;

create or replace function public.admin_confirm_payment(p_payment uuid, p_approve boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'Not allowed'; end if;
  perform public.apply_payment(p_payment, p_approve, auth.uid());
end $$;

-- Called only by the razorpay edge function (service role) after it has verified Razorpay's signature.
create or replace function public.razorpay_paid(p_payment uuid, p_order text, p_rzp_payment text, p_paise bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare pay record;
begin
  select * into pay from public.payments where id = p_payment for update;
  if not found then raise exception 'Payment not found'; end if;
  if pay.status = 'confirmed' and pay.utr = p_rzp_payment then return jsonb_build_object('ok', true, 'already', true); end if;
  if pay.status <> 'pending' then raise exception 'Payment is not pending'; end if;
  if coalesce(pay.meta->>'rzp_order','') <> p_order then raise exception 'Order does not match'; end if;
  if p_paise <> round(pay.total * 100) then raise exception 'Amount does not match'; end if;
  update public.payments set utr = p_rzp_payment, meta = meta || jsonb_build_object('method','razorpay','rzp_payment',p_rzp_payment) where id = p_payment;
  perform public.apply_payment(p_payment, true, null);
  return jsonb_build_object('ok', true, 'kind', pay.kind);
end $$;
revoke execute on function public.razorpay_paid(uuid, text, text, bigint) from public, anon, authenticated;
grant execute on function public.razorpay_paid(uuid, text, text, bigint) to service_role;
grant execute on function public.apply_payment(uuid, boolean, uuid) to service_role;

-- Plan update (owner, 10 Nov): loyalty in Starter, staff attendance in Growth, Pro ₹899
update public.packages set modules = '{reviews,customers,loyalty}',
  features = '{"Review QR and counter rating screen","Unhappy customers tell you privately first","Customer list with visits, birthdays and spend","Loyalty card and coupons","Growth report","1 location"}'
  where slug = 'starter';
update public.packages set modules = '{reviews,customers,loyalty,campaigns,seo,attendance}',
  features = '{"Everything in Starter","WhatsApp offers to birthdays, regulars and lost customers","Daily alerts every morning","Keywords & SEO studio for your Google profile","Staff attendance and salary","1 location"}'
  where slug = 'growth';
update public.packages set monthly_price = 899, yearly_price = 8990,
  features = '{"Everything in Growth","Google review auto-replies","QR menu and table orders","One-click WhatsApp bulk sending (message credits extra)","Up to 3 locations","Priority support"}'
  where slug = 'pro';
