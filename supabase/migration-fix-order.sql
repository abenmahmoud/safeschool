-- ============================================================
-- SafeSchool — Script de correction
-- À exécuter si la migration V6 a été lancée AVANT la V5
-- Ce script recrée les éléments qui ont échoué
-- ============================================================

-- ÉTAPE 1 : Vérifier que toutes les colonnes V5 existent
-- (IF NOT EXISTS = idempotent, pas de risque si déjà présentes)

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

-- ÉTAPE 2 : Recréer le trigger V5 (case_number + tracking_code auto)
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

CREATE INDEX IF NOT EXISTS idx_reports_case_number ON public.reports(case_number);

-- ÉTAPE 3 : Vérifier que les colonnes V6 existent aussi
ALTER TABLE reports ADD COLUMN IF NOT EXISTS niveau TEXT;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS classe TEXT;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS age_range TEXT;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS genre TEXT;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS duree TEXT;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS anonymized_at TIMESTAMPTZ;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS deletion_requested_at TIMESTAMPTZ;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS data_retention_expires_at TIMESTAMPTZ;

-- ÉTAPE 4 : Recréer l'index qui a probablement échoué
DROP INDEX IF EXISTS idx_reports_school_urgency;
CREATE INDEX IF NOT EXISTS idx_reports_school_urgency ON reports(school_id, urgence);

-- ÉTAPE 5 : Recréer le trigger de rétention des données
CREATE OR REPLACE FUNCTION set_data_retention_expiry()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.data_retention_expires_at IS NULL THEN
    NEW.data_retention_expires_at := NEW.created_at + INTERVAL '12 months';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_set_data_retention ON reports;
CREATE TRIGGER trg_set_data_retention
  BEFORE INSERT ON reports
  FOR EACH ROW EXECUTE FUNCTION set_data_retention_expiry();

-- ÉTAPE 6 : Recréer la vue statistique (celle qui a échoué)
CREATE OR REPLACE VIEW v_report_statistics AS
SELECT
  school_id,
  type,
  urgence,
  status,
  niveau,
  classe,
  age_range,
  genre,
  duree,
  frequency,
  location,
  reporter_role,
  is_anonymous,
  source_channel,
  DATE(created_at) as report_date,
  EXTRACT(MONTH FROM created_at) as report_month,
  EXTRACT(YEAR FROM created_at) as report_year,
  CASE WHEN status = 'traite' THEN true ELSE false END as is_resolved
FROM reports
WHERE anonymized_at IS NULL;

COMMENT ON VIEW v_report_statistics IS 'Anonymized view for statistical analysis — RGPD compliant, no PII fields';

-- ÉTAPE 7 : Mettre à jour la rétention pour les lignes existantes
UPDATE reports SET data_retention_expires_at = created_at + INTERVAL '12 months'
WHERE data_retention_expires_at IS NULL AND created_at IS NOT NULL;

-- ÉTAPE 8 : Recréer les policies RLS V5
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'anon_insert_school' AND tablename = 'schools') THEN
    CREATE POLICY "anon_insert_school" ON public.schools FOR INSERT WITH CHECK (true);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'anon_select_active_schools' AND tablename = 'schools') THEN
    CREATE POLICY "anon_select_active_schools" ON public.schools FOR SELECT USING (is_active = true);
  END IF;
END $$;

-- ÉTAPE 9 : Recréer la fonction get_report_by_code
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

-- ✅ Terminé ! Vérifiez avec :
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'reports' ORDER BY ordinal_position;
