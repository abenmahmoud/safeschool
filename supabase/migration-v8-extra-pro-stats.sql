-- SafeSchool V8 Extra Pro — Statistics tables for Supabase persistence
-- Run this in Supabase SQL Editor

-- ── LEA STATISTICS (aggregated per school) ──────────────────────
CREATE TABLE IF NOT EXISTS public.lea_statistics (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id       uuid REFERENCES public.schools(id) ON DELETE CASCADE,
  total_conversations integer NOT NULL DEFAULT 0,
  total_messages     integer NOT NULL DEFAULT 0,
  categories       jsonb NOT NULL DEFAULT '{}',
  severity_hits    jsonb NOT NULL DEFAULT '{}',
  last_updated     timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE(school_id)
);

-- ── LEA ALERTS ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lea_alerts (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id       uuid REFERENCES public.schools(id) ON DELETE CASCADE,
  category        text NOT NULL,
  severity        integer NOT NULL DEFAULT 0 CHECK (severity >= 0 AND severity <= 5),
  school_name     text,
  alert_timestamp timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ── INDEXES ─────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_lea_stats_school ON public.lea_statistics(school_id);
CREATE INDEX IF NOT EXISTS idx_lea_alerts_school ON public.lea_alerts(school_id);
CREATE INDEX IF NOT EXISTS idx_lea_alerts_severity ON public.lea_alerts(severity);
CREATE INDEX IF NOT EXISTS idx_lea_alerts_timestamp ON public.lea_alerts(alert_timestamp DESC);

-- ── RLS ─────────────────────────────────────────────────────────
ALTER TABLE public.lea_statistics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lea_alerts ENABLE ROW LEVEL SECURITY;

-- Superadmin can see all
CREATE POLICY "sa_all_lea_stats" ON public.lea_statistics FOR ALL
  USING (public.my_role() = 'superadmin');
CREATE POLICY "sa_all_lea_alerts" ON public.lea_alerts FOR ALL
  USING (public.my_role() = 'superadmin');

-- School admin sees own school stats
CREATE POLICY "admin_own_lea_stats" ON public.lea_statistics FOR SELECT
  USING (school_id = public.my_school_id());
CREATE POLICY "admin_own_lea_alerts" ON public.lea_alerts FOR SELECT
  USING (school_id = public.my_school_id());

-- Anon can insert stats and alerts (from client app)
CREATE POLICY "anon_insert_lea_stats" ON public.lea_statistics FOR INSERT
  WITH CHECK (true);
CREATE POLICY "anon_update_lea_stats" ON public.lea_statistics FOR UPDATE
  USING (true);
CREATE POLICY "anon_insert_lea_alerts" ON public.lea_alerts FOR INSERT
  WITH CHECK (true);

-- ── STATISTICS SUMMARY VIEW ─────────────────────────────────────
CREATE OR REPLACE VIEW v_lea_summary AS
SELECT
  s.id as school_id,
  s.name as school_name,
  s.slug,
  s.plan,
  COALESCE(ls.total_conversations, 0) as total_conversations,
  COALESCE(ls.total_messages, 0) as total_messages,
  ls.categories,
  ls.severity_hits,
  ls.last_updated,
  (SELECT COUNT(*) FROM public.lea_alerts la WHERE la.school_id = s.id) as total_alerts,
  (SELECT COUNT(*) FROM public.lea_alerts la WHERE la.school_id = s.id AND la.severity >= 3) as high_severity_alerts,
  (SELECT COUNT(*) FROM public.reports r WHERE r.school_id = s.id) as total_reports,
  (SELECT COUNT(*) FROM public.reports r WHERE r.school_id = s.id AND r.status = 'nouveau') as pending_reports
FROM public.schools s
LEFT JOIN public.lea_statistics ls ON ls.school_id = s.id;

COMMENT ON VIEW v_lea_summary IS 'Comprehensive statistics summary per school — combines LEA stats, alerts, and reports for dashboard display';
