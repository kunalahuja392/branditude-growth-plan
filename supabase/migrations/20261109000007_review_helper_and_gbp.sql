-- Review helper (customer's own words, tidied) + Google Business Profile auto-replies.

-- 1. Rate-limit log for the public review helper (written only by the edge function with the service role)
create table if not exists public.review_polish_usage (
  id          bigserial primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  ip_hash     text not null,
  created_at  timestamptz not null default now()
);
create index if not exists rpu_biz_time on public.review_polish_usage (business_id, created_at);
create index if not exists rpu_ip_time  on public.review_polish_usage (ip_hash, created_at);
alter table public.review_polish_usage enable row level security;   -- no policies: service role only

-- 2. Google connection. Holds the refresh token, so no client policies at all.
create table if not exists public.gbp_connections (
  business_id    uuid primary key references public.businesses(id) on delete cascade,
  refresh_token  text not null,
  account_name   text,             -- accounts/123
  location_name  text,             -- accounts/123/locations/456 (v4 path)
  location_title text,
  locations      jsonb not null default '[]',   -- [{name,title,address}] the owner can pick from
  connected_by   uuid references auth.users(id) on delete set null,
  connected_at   timestamptz not null default now(),
  last_sync_at   timestamptz,
  last_error     text
);
alter table public.gbp_connections enable row level security;
revoke all on public.gbp_connections from anon, authenticated;

create table if not exists public.oauth_states (
  state       text primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now()
);
alter table public.oauth_states enable row level security;
revoke all on public.oauth_states from anon, authenticated;

-- 3. Reviews pulled from Google, with the owner's reply / AI draft
create table if not exists public.gbp_reviews (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  review_name text not null unique,          -- accounts/x/locations/y/reviews/z
  reviewer    text,
  stars       int check (stars between 1 and 5),
  comment     text,
  review_time timestamptz,
  reply_text  text,
  reply_time  timestamptz,
  draft       text,
  status      text not null default 'new' check (status in ('new','draft','posted','skipped','error')),
  error       text,
  updated_at  timestamptz not null default now()
);
create index if not exists gbp_reviews_biz on public.gbp_reviews (business_id, review_time desc);
alter table public.gbp_reviews enable row level security;
create policy gr_read on public.gbp_reviews for select using (public.is_member(business_id) or public.is_staff());

-- 4. Owner's auto-reply mode. off = nothing; drafts = AI drafts, owner posts; positive = auto-post 4–5★, drafts for 1–3★; all = auto-post everything
alter table public.businesses add column if not exists gbp_reply_mode text not null default 'positive'
  check (gbp_reply_mode in ('off','drafts','positive','all'));
grant update (gbp_reply_mode) on public.businesses to authenticated;

-- 5. Safe status for the portal (never returns the token)
create or replace function public.gbp_status(b uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when not (public.is_member(b) or public.is_staff()) then null else
    coalesce((select jsonb_build_object('connected', true, 'location_name', c.location_name, 'location_title', c.location_title,
        'locations', c.locations, 'connected_at', c.connected_at, 'last_sync_at', c.last_sync_at, 'last_error', c.last_error)
      from public.gbp_connections c where c.business_id = b), jsonb_build_object('connected', false)) end
$$;
revoke execute on function public.gbp_status(uuid) from public, anon;
grant execute on function public.gbp_status(uuid) to authenticated;

-- 6. Secret the scheduled sync uses to call the edge function (generated here; only the service role can read it)
create table if not exists public.internal_secrets (
  key   text primary key,
  value text not null
);
alter table public.internal_secrets enable row level security;
revoke all on public.internal_secrets from anon, authenticated;
insert into public.internal_secrets (key, value)
values ('cron_secret', replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''))
on conflict (key) do nothing;

-- 7. AI writing of the owner's reply uses the same daily allowance table
comment on table public.ai_usage is 'kinds: suggest_keywords, description, post, faq, reply, gbp_reply';
