-- ============================================================
-- SafeSchool V5 Migration - Colonnes manquantes
-- A exécuter dans Supabase SQL Editor AVANT déploiement
-- NE PAS exécuter si les colonnes existent déjà
-- ============================================================

-- Ajout case_number pour référence dossier lisible
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS case_number text;

-- Colonnes reporter (si non présentes dans le schema actuel)
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS reporter_role text;
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS reporter_name text;
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS reporter_class text;
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS reporter_email text;
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS location text;
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS frequency text;
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS source_channel text DEFAULT 'form';
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS consent_accepted boolean DEFAULT false;
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS consent_accepted_at timestamptz;
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS followup_email_opt_in boolean DEFAULT false;
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS assigned_staff_id uuid;

-- Index sur case_number pour lookup rapide
CREATE INDEX IF NOT EXISTS idx_reports_case_number ON public.reports(case_number);

-- Fonction pour générer case_number automatiquement à l'insertion
CREATE OR REPLACE FUNCTION public.generate_case_number()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  seq_num integer;
BEGIN
  SELECT count(*) + 1 INTO seq_num
  FROM public.reports
  WHERE school_id = NEW.school_id;

  IF NEW.case_number IS NULL THEN
    NEW.case_number := 'D-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(seq_num::text, 4, '0');
  END IF;
  RETURN NEW;
END;
$$;

-- Trigger pour auto-générer case_number
DROP TRIGGER IF EXISTS trg_reports_case_number ON public.reports;
CREATE TRIGGER trg_reports_case_number
  BEFORE INSERT ON public.reports
  FOR EACH ROW EXECUTE FUNCTION public.generate_case_number();

-- Mettre à jour la fonction RPC pour inclure case_number
CREATE OR REPLACE FUNCTION public.get_report_by_code(p_code text)
RETURNS TABLE (
  id uuid, tracking_code text, case_number text,
  type text, urgence text, classe text,
  description text, status text, admin_note text,
  school_id uuid, created_at timestamptz, updated_at timestamptz
)
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT id, tracking_code, case_number,
         type, urgence, classe, description,
         status, admin_note, school_id,
         created_at, updated_at
  FROM public.reports
  WHERE tracking_code = p_code OR case_number = p_code
  LIMIT 1;
$$;
