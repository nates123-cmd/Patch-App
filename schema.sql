-- Patch — Supabase schema
-- Run in Supabase Dashboard → SQL Editor (project: xsmnfcmtbpeaccnyinkr).
-- Structured capture inbox for the suite: typed items (bug / feature / idea).
--
-- This file has TWO sections. Run exactly ONE:
--   A) FRESH INSTALL — the `create table items` block below.
--   B) EXISTING INSTALL — the MIGRATION block at the bottom (renames the old
--      `patches` table to `items` and backfills the new columns). Do NOT also
--      run section A; the migration creates `items` for you.

-- ──────────────────────────────────────────────────────────────────────────
-- A) FRESH INSTALL
-- ──────────────────────────────────────────────────────────────────────────

create table items (
  id uuid primary key default gen_random_uuid(),
  -- type drives which fields are required (enforced in the app, not the DB).
  type text not null default 'idea'
    check (type in ('bug','feature','idea')),
  app text                -- required for bug + feature; optional for idea (enforced in app)
    check (app is null or app in ('course','stock','ink','tide','tick','break','today','crate','cue','patch','resin','courseplus')),
  title text,             -- required for ideas; optional/derived for bug + feature
  where_in_app text,      -- required for bug + feature
  expected text,          -- bug only
  actual text,            -- bug only
  description text,       -- required for feature + idea
  severity text           -- bug only
    check (severity is null or severity in ('blocker','annoying','polish')),
  status text not null default 'open'
    check (status in ('open','in_progress','fixed','shipped','parked','needs_info')),
  my_guess text,
  device_context text,
  image_url text,
  repo text,              -- optional repo override (defaults derived in the app)
  promoted_to uuid,       -- set on a parked idea when it is promoted to a feature
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  fixed_at timestamptz    -- set when status becomes fixed/shipped
);

create index items_app_idx on items(app);
create index items_type_idx on items(type);
create index items_status_idx on items(status);
create index items_created_idx on items(created_at desc);

alter table items enable row level security;
create policy "anon all" on items for all using (true) with check (true);

create or replace function items_touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger items_touch
  before update on items
  for each row execute function items_touch_updated_at();

-- ──────────────────────────────────────────────────────────────────────────
-- B) MIGRATION — existing `patches` install → structured `items` (May 2026)
--
-- Non-destructive: backfills the new columns from existing rows, drops no data,
-- then renames the table. Re-runnable. Run this INSTEAD of section A.
-- ──────────────────────────────────────────────────────────────────────────
/*
begin;

-- 1. New columns (all nullable; per-type requiredness lives in the app).
alter table patches add column if not exists title          text;
alter table patches add column if not exists where_in_app   text;
alter table patches add column if not exists expected       text;
alter table patches add column if not exists actual         text;
alter table patches add column if not exists description    text;
alter table patches add column if not exists severity       text;
alter table patches add column if not exists my_guess       text;
alter table patches add column if not exists device_context text;
alter table patches add column if not exists image_url      text;
alter table patches add column if not exists repo           text;
alter table patches add column if not exists promoted_to    uuid;
alter table patches add column if not exists fixed_at        timestamptz;

-- 2. Backfill title from the legacy single text field; keep `text` (now nullable)
--    so structured inserts (which omit it) succeed and no data is lost.
update patches set title = text where title is null;
alter table patches alter column text drop not null;

-- 3. App: drop the old check + NOT NULL, remap Still → Ink while unconstrained,
--    then add the new check. Remapping before widening the check fails, because
--    the old check does not allow 'ink'.
alter table patches alter column app drop not null;
alter table patches drop constraint if exists patches_app_check;
update patches set app = 'ink' where app = 'still';
alter table patches add constraint patches_app_check
  check (app is null or app in ('course','stock','ink','tide','tick','break','today','crate','cue','patch','resin','courseplus'));

-- 4. Remap statuses to the new lifecycle, then swap the constraint + default.
alter table patches drop constraint if exists patches_status_check;
update patches set status = 'in_progress' where status = 'doing';
update patches set status = 'fixed'       where status = 'done';
update patches set status = 'parked'      where status = 'wont';
update patches set fixed_at = updated_at  where status = 'fixed' and fixed_at is null;
alter table patches add constraint patches_status_check
  check (status in ('open','in_progress','fixed','shipped','parked','needs_info'));
alter table patches alter column status set default 'open';

-- 5. Expand the type enum to add 'feature' (existing bug/idea preserved).
alter table patches drop constraint if exists patches_type_check;
alter table patches add constraint patches_type_check
  check (type in ('bug','feature','idea'));

-- 6. Severity enum (bugs only; null allowed for legacy / non-bug rows).
alter table patches drop constraint if exists patches_severity_check;
alter table patches add constraint patches_severity_check
  check (severity is null or severity in ('blocker','annoying','polish'));

create index if not exists patches_type_idx on patches(type);

-- 8. Adopt the new identity. Constraints/indexes/trigger carry over under their
--    original patches_* names — functional, just not renamed.
alter table patches rename to items;

commit;

-- Once you have confirmed the backfill looks right, the legacy column can go:
--   alter table items drop column text;
*/
