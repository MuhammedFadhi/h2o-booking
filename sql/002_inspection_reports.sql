-- SA'DA H2O — Inspection Report
-- Migration 002 (idempotent).
-- Merged schema from handoff PDF + RLS aligned with this app's auth
-- (installers → auth.uid(), admin → is_admin(), customers → anon read submitted).

create extension if not exists "pgcrypto";

create table if not exists public.inspection_reports (
  id                   uuid primary key default gen_random_uuid(),
  booking_id           uuid not null references public.bookings(id) on delete cascade,
  installer_id         uuid references public.installers(id) on delete set null,

  -- Snapshot at time of report
  customer_name        text,
  customer_phone       text,
  address              text,
  city_name            text,

  -- Visit metadata (matches PDF)
  visit_type           text not null default 'installation'
                       check (visit_type in ('installation','service','filter_change','other')),
  visit_date           date not null default current_date,
  next_service_due     date,

  ro_model             text,
  serial_no            text,

  tech_name            text,
  tech_contact         text,
  invoice_no           text,

  -- Water analysis (rejection computed at render time)
  feed_tds             int check (feed_tds is null or feed_tds between 0 and 5000),
  product_tds          int check (product_tds is null or product_tds between 0 and 5000),

  -- Component ratings — flat: { water_quality:'good', s1:'normal', ... }
  components           jsonb not null default '{}'::jsonb,

  remarks              text,
  action_taken         text,

  -- Signatures as base64 PNG data URLs
  tech_signature       text,
  customer_signature   text,
  customer_ack_name    text,

  status               text not null default 'draft'
                              check (status in ('draft','submitted')),
  submitted_at         timestamptz,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- One report per booking
do $$
begin
  if not exists (
    select 1 from pg_constraint c join pg_class t on t.oid = c.conrelid
     where t.relname='inspection_reports' and c.contype='u'
       and pg_get_constraintdef(c.oid) like '%booking_id%'
  ) then
    alter table public.inspection_reports
      add constraint inspection_reports_booking_key unique (booking_id);
  end if;
end $$;

create index if not exists idx_inspection_reports_booking   on public.inspection_reports(booking_id);
create index if not exists idx_inspection_reports_installer on public.inspection_reports(installer_id);
create index if not exists idx_inspection_reports_phone     on public.inspection_reports(customer_phone);
create index if not exists idx_inspection_reports_status    on public.inspection_reports(status);
create index if not exists idx_inspection_reports_created   on public.inspection_reports(created_at desc);

-- updated_at trigger
create or replace function public.touch_inspection_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists trg_inspection_reports_updated on public.inspection_reports;
create trigger trg_inspection_reports_updated
  before update on public.inspection_reports
  for each row execute function public.touch_inspection_updated_at();

-- RLS aligned with this app's auth (auth.uid() + is_admin())
alter table public.inspection_reports enable row level security;

-- Installers: own reports
drop policy if exists reports_installer_all on public.inspection_reports;
create policy reports_installer_all on public.inspection_reports
  for all to authenticated
  using  (installer_id = auth.uid())
  with check (installer_id = auth.uid());

-- Admin: full access via is_admin()
drop policy if exists reports_admin_all on public.inspection_reports;
create policy reports_admin_all on public.inspection_reports
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Customer (anon): read submitted only; client filters by phone
drop policy if exists reports_anon_read on public.inspection_reports;
create policy reports_anon_read on public.inspection_reports
  for select to anon
  using (status = 'submitted');

-- Realtime for live-updating admin/customer lists
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname='supabase_realtime' and tablename='inspection_reports'
  ) then
    alter publication supabase_realtime add table public.inspection_reports;
  end if;
end $$;

-- SMS toggle seed
insert into public.sms_settings (key, enabled) values ('inspection_report', true)
on conflict (key) do nothing;
