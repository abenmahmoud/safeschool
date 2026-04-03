create extension if not exists pgcrypto;

create table if not exists public.schools (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  city text,
  email_contact text,
  plan text not null default 'starter' check (plan in ('starter','pro','enterprise')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.admin_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique,
  school_id uuid references public.schools(id) on delete cascade,
  role text not null check (role in ('superadmin','school_admin')),
  full_name text,
  created_at timestamptz not null default now()
);

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  tracking_code text not null unique,
  role text,
  type text not null check (type in ('verbal','physique','cyber','exclusion','autre')),
  location text,
  urgence text not null default 'faible' check (urgence in ('faible','moyenne','haute')),
  classe text,
  description text not null,
  anonymous boolean not null default true,
  contact text,
  status text not null default 'nouveau' check (status in ('nouveau','en_cours','traite','archive')),
  admin_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.report_messages (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.reports(id) on delete cascade,
  sender text not null check (sender in ('admin','reporter')),
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_reports_school_status_created on public.reports(school_id, status, created_at desc);
create index if not exists idx_reports_school_type on public.reports(school_id, type);
create index if not exists idx_reports_tracking_code on public.reports(tracking_code);
create index if not exists idx_messages_report_created on public.report_messages(report_id, created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_schools_updated_at on public.schools;
create trigger trg_schools_updated_at before update on public.schools
for each row execute function public.set_updated_at();

drop trigger if exists trg_reports_updated_at on public.reports;
create trigger trg_reports_updated_at before update on public.reports
for each row execute function public.set_updated_at();

alter table public.schools enable row level security;
alter table public.admin_profiles enable row level security;
alter table public.reports enable row level security;
alter table public.report_messages enable row level security;

create or replace function public.my_role()
returns text
language sql
stable
security definer
as $$
  select ap.role
  from public.admin_profiles ap
  where ap.user_id = auth.uid()
  limit 1;
$$;

create or replace function public.my_school_id()
returns uuid
language sql
stable
security definer
as $$
  select ap.school_id
  from public.admin_profiles ap
  where ap.user_id = auth.uid()
  limit 1;
$$;

drop policy if exists schools_superadmin_all on public.schools;
create policy schools_superadmin_all on public.schools
for all
using (public.my_role() = 'superadmin')
with check (public.my_role() = 'superadmin');

drop policy if exists schools_admin_select_own on public.schools;
create policy schools_admin_select_own on public.schools
for select
using (id = public.my_school_id());

drop policy if exists admin_profiles_superadmin_all on public.admin_profiles;
create policy admin_profiles_superadmin_all on public.admin_profiles
for all
using (public.my_role() = 'superadmin')
with check (public.my_role() = 'superadmin');

drop policy if exists admin_profiles_select_self on public.admin_profiles;
create policy admin_profiles_select_self on public.admin_profiles
for select
using (user_id = auth.uid());

drop policy if exists reports_superadmin_all on public.reports;
create policy reports_superadmin_all on public.reports
for all
using (public.my_role() = 'superadmin')
with check (public.my_role() = 'superadmin');

drop policy if exists reports_admin_own_school on public.reports;
create policy reports_admin_own_school on public.reports
for select
using (school_id = public.my_school_id());

drop policy if exists reports_admin_update_own_school on public.reports;
create policy reports_admin_update_own_school on public.reports
for update
using (school_id = public.my_school_id())
with check (school_id = public.my_school_id());

drop policy if exists reports_admin_insert_own_school on public.reports;
create policy reports_admin_insert_own_school on public.reports
for insert
with check (school_id = public.my_school_id());

drop policy if exists reports_anon_insert_only on public.reports;
create policy reports_anon_insert_only on public.reports
for insert
to anon
with check (true);

drop policy if exists messages_superadmin_all on public.report_messages;
create policy messages_superadmin_all on public.report_messages
for all
using (public.my_role() = 'superadmin')
with check (public.my_role() = 'superadmin');

drop policy if exists messages_admin_own_school on public.report_messages;
create policy messages_admin_own_school on public.report_messages
for all
using (
  exists (
    select 1 from public.reports r
    where r.id = report_id and r.school_id = public.my_school_id()
  )
)
with check (
  exists (
    select 1 from public.reports r
    where r.id = report_id and r.school_id = public.my_school_id()
  )
);

drop policy if exists messages_reporter_insert on public.report_messages;
create policy messages_reporter_insert on public.report_messages
for insert
to anon
with check (sender = 'reporter');

drop policy if exists reports_anon_select on public.reports;
drop policy if exists messages_anon_select on public.report_messages;

create or replace function public.get_report_by_code_secure(p_code text, p_school_slug text default null)
returns table (
  tracking_code text,
  type text,
  urgence text,
  classe text,
  description text,
  status text,
  admin_note text,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select r.tracking_code, r.type, r.urgence, r.classe, r.description, r.status, r.admin_note, r.created_at, r.updated_at
  from public.reports r
  join public.schools s on s.id = r.school_id
  where r.tracking_code = p_code
    and (p_school_slug is null or s.slug = p_school_slug)
  limit 1;
$$;

revoke all on function public.get_report_by_code_secure(text, text) from public;
grant execute on function public.get_report_by_code_secure(text, text) to anon, authenticated;
