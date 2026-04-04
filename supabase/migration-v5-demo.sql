-- ============================================================
-- SafeSchool V5 Demo — Migration SQL minimale
-- Ajoute les colonnes manquantes à reports et schools
-- À exécuter dans Supabase SQL Editor AVANT la démo
-- ============================================================

-- ── SCHOOLS: ajouter colonnes manquantes ──
ALTER TABLE public.schools ADD COLUMN IF NOT EXISTS city text;
ALTER TABLE public.schools ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

-- ── REPORTS: colonnes nécessaires pour le flux complet ──
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS case_number text;
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS staff_reply text;
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS location text;
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS frequency text;
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS reporter_role text;
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS reporter_name text;
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS reporter_class text;
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS reporter_email text;
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS is_anonymous boolean NOT NULL DEFAULT true;
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS followup_email_opt_in boolean DEFAULT false;
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS consent_accepted boolean DEFAULT false;
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS consent_accepted_at timestamptz;
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS source_channel text DEFAULT 'form';
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS assigned_staff_id uuid;
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS history jsonb DEFAULT '[]'::jsonb;

-- ── Auto-génération case_number ──
-- Génère un numéro de dossier automatique à l'insertion
CREATE OR REPLACE FUNCTION public.generate_case_number()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.case_number IS NULL THEN
    NEW.case_number := 'DS-' || to_char(now(), 'YYYYMMDD') || '-' || substr(NEW.id::text, 1, 4);
  END IF;
  IF NEW.tracking_code IS NULL THEN
    NEW.tracking_code := 'SS-' || upper(substr(md5(random()::text), 1, 6));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reports_case_number ON public.reports;
CREATE TRIGGER trg_reports_case_number
  BEFORE INSERT ON public.reports
  FOR EACH ROW EXECUTE FUNCTION public.generate_case_number();

-- ── Index sur case_number ──
CREATE INDEX IF NOT EXISTS idx_reports_case_number ON public.reports(case_number);

-- ── RLS: permettre anon d'insérer dans schools (pour la démo) ──
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'anon_insert_school' AND tablename = 'schools') THEN
    CREATE POLICY "anon_insert_school" ON public.schools FOR INSERT WITH CHECK (true);
  END IF;
END $$;

-- ── RLS: permettre anon de lire les schools actives ──
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'anon_select_active_schools' AND tablename = 'schools') THEN
    CREATE POLICY "anon_select_active_schools" ON public.schools FOR SELECT USING (is_active = true);
  END IF;
END $$;

-- ── RLS: permettre anon de lire reports par tracking_code ou case_number ──
-- La policy existante anon_select_by_tracking est conservée

-- ── Mise à jour de la fonction get_report_by_code pour chercher aussi par case_number ──
CREATE OR REPLACE FUNCTION public.get_report_by_code(p_code text)
RETURNS TABLE (
  id uuid, type text, urgence text, classe text,
  description text, status text, admin_note text, staff_reply text,
  tracking_code text, case_number text,
  created_at timestamptz, updated_at timestamptz
)
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT id, type, urgence, classe, description,
         status, admin_note, staff_reply, tracking_code, case_number,
         created_at, updated_at
  FROM public.reports
  WHERE tracking_code = p_code OR case_number = p_code
  LIMIT 1;
$$;
