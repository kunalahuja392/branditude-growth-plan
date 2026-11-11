alter function public.perm_areas() set search_path = public;
alter function public.mod_area(text) set search_path = public;
revoke execute on function public.can_write(uuid) from anon;
