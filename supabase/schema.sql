-- SafeSchool V3 -- Supabase Schema
-- Multi-tenant: 1 school = 1 isolated space
-- RLS: superadmin > school_admin > anon

create extension if not exists "uuid-ossp";

-- SCHOOLS
create table public.schools (
  id                uuid primary key default uuid_generate_v4(),
  name              text not null,
  slug              text not null unique,
  ville             text,
  email_contact     text,
  plan              text not null default 'starter' check (plan in ('starter','pro','enterprise')),
  status            text not null default 'trial' check (status in ('active','trial','suspended','expired')),
  max_students      integer not null default 200,
  max_reports_month integer not null default 50,
  max_admins        integer not null default 1,
  expires_at        timestamptz,
  stripe_customer_id text,
  stripe_sub_id     text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- ADMIN PROFILES
create table public.admin_profiles (
  id         uuid primary key default uuid_generate_v4(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  school_id  uuid references public.schools(id) on delete cascade,
  role       text not null default 'school_admin' check (role in ('superadmin','school_admin')),
  full_name  text,
  created_at timestamptz not null default now(),
  unique (user_id)
);

-- REPORTS
create table public.reports (
  id            uuid primary key default uuid_generate_v4(),
  school_id     uuid not null references public.schools(id) on delete cascade,
  tracking_code text not null unique,
  type          text not null check (type in ('verbal','physique','cyber','exclusion','autre')),
  urgence       text not null default 'faible' check (urgence in ('haute','moyenne','faible')),
  classe        text,
  description   text,
  anonymous     boolean not null default true,
  status        text not null default 'nouveau' check (status in ('nouveau','en_cours','traite','archive')),
  admin_note    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- REPORT MESSAGES (suivi anonyme par code)
create table public.report_messages (
  id         uuid primary key default uuid_generate_v4(),
  report_id  uuid not null references public.reports(id) on delete cascade,
  sender     text not null check (sender in ('reporter','admin')),
  content    text not null,
  created_at timestamptz not null default now()
);

-- INDEXES
create index idx_reports_school   on public.reports(school_id);
create index idx_reports_status   on public.reports(status);
create index idx_reports_tracking on public.reports(tracking_code);
create index idx_reports_created  on public.reports(created_at desc);
create index idx_profiles_user    on public.admin_profiles(user_id);
create index idx_profiles_school  on public.admin_profiles(school_id);

-- UPDATED_AT TRIGGER
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

create trigger trg_schools_upd before update on public.schools for each row execute function public.set_updated_at();
create trigger trg_reports_upd before update on public.reports for each row execute function public.set_updated_at();

-- RLS
alter table public.schools         enable row level security;
alter table public.admin_profiles  enable row level security;
alter table public.reports         enable row level security;
alter table public.report_messages enable row level security;

create or replace function public.my_role() returns text language sql security definer as $$
  select role from public.admin_profiles where user_id = auth.uid() limit 1; $$;
create or replace function public.my_school_id() returns uuid language sql security definer as $$
  select school_id from public.admin_profiles where user_id = auth.uid() limit 1; $$;

-- Schools policies
create policy "sa_all_schools"    on public.schools for all using (public.my_role()='superadmin');
create policy "admin_own_school"  on public.schools for select using (id=public.my_school_id());

-- Profiles policies
create policy "sa_all_profiles"   on public.admin_profiles for all using (public.my_role()='superadmin');
create policy "own_profile"       on public.admin_profiles for select using (user_id=auth.uid());

-- Reports policies
create policy "sa_all_reports"    on public.reports for all using (public.my_role()='superadmin');
create policy "admin_own_reports" on public.reports for all using (school_id=public.my_school_id());
create policy "anon_insert"       on public.reports for insert with check (true);
create policy "anon_select"       on public.reports for select using (true);

-- Messages policies
create policy "sa_all_messages"   on public.report_messages for all using (public.my_role()='superadmin');
create policy "admin_messages"    on public.report_messages for all using (exists (select 1 from public.reports r where r.id=report_id and r.school_id=public.my_school_id()));
create policy "anon_insert_msg"   on public.report_messages for insert with check (sender='reporter');
create policy "anon_select_msg"   on public.report_messages for select using (true);

-- After setup: run this to create superadmin profile:
-- insert into public.admin_profiles (user_id, school_id, role, full_name)
-- values ('<auth-user-id>', null, 'superadmin', 'Adel Ben Mahmoud');
