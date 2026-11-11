-- Private bucket for agent payout screenshots (Supabase Storage; skipped in local tests). Super admin only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('payouts', 'payouts', false, 5242880, array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict (id) do update set public = false, file_size_limit = 5242880, allowed_mime_types = array['image/jpeg','image/png','image/webp','application/pdf'];
drop policy if exists payouts_all on storage.objects;
create policy payouts_all on storage.objects for all to authenticated
  using (bucket_id = 'payouts' and public.is_super_admin()) with check (bucket_id = 'payouts' and public.is_super_admin());
