-- Patch — Supabase schema
-- Run this in Supabase Dashboard → SQL Editor (project: xsmnfcmtbpeaccnyinkr).
-- Single shared table for the suite's fix-capture inbox.

create table patches (
  id uuid primary key default gen_random_uuid(),
  app text not null check (app in ('tick','break','tide','still','course','patch','amanda','all')),
  text text not null,
  type text not null default 'bug' check (type in ('bug','idea')),
  status text not null default 'open' check (status in ('open','doing','done','wont')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index patches_app_idx on patches(app);
create index patches_status_idx on patches(status);
create index patches_created_idx on patches(created_at desc);

alter table patches enable row level security;
create policy "anon all" on patches for all using (true) with check (true);

create or replace function patches_touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger patches_touch
  before update on patches
  for each row execute function patches_touch_updated_at();

-- ──────────────────────────────────────────────────────────────────────────
-- Migration for existing installs (May 2026): add `type`, allow app = 'all'.
-- Run this block INSTEAD of the create table above if `patches` already
-- exists. Idempotent — safe to re-run.
-- ──────────────────────────────────────────────────────────────────────────
-- alter table patches drop constraint patches_app_check;
-- alter table patches add constraint patches_app_check
--   check (app in ('tick','break','tide','still','course','patch','amanda','all'));
-- alter table patches add column if not exists type text not null default 'bug'
--   check (type in ('bug','idea'));
