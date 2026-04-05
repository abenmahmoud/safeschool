-- SafeSchool V6 Migration — Statistical indicator fields + RGPD compliance
-- Run this in Supabase SQL Editor

-- Add new statistical fields to reports (all optional/nullable)
ALTER TABLE reports ADD COLUMN IF NOT EXISTS niveau TEXT;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS classe TEXT;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS age_range TEXT;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS genre TEXT;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS duree TEXT;

-- Add RGPD audit columns
ALTER TABLE reports ADD COLUMN IF NOT EXISTS anonymized_at TIMESTAMPTZ;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS deletion_requested_at TIMESTAMPTZ;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS data_retention_expires_at TIMESTAMPTZ;

-- Set default data retention expiry (12 months from creation)
UPDATE reports SET data_retention_expires_at = created_at + INTERVAL '12 months'
WHERE data_retention_expires_at IS NULL AND created_at IS NOT NULL;

-- Create index for statistical queries
CREATE INDEX IF NOT EXISTS idx_reports_niveau ON reports(niveau) WHERE niveau IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reports_age_range ON reports(age_range) WHERE age_range IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reports_genre ON reports(genre) WHERE genre IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reports_duree ON reports(duree) WHERE duree IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reports_school_type ON reports(school_id, type);
CREATE INDEX IF NOT EXISTS idx_reports_school_urgency ON reports(school_id, urgence);

-- Create a function to auto-set data retention expiry on insert
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

-- Create a view for anonymized statistical queries (no PII)
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
  anonymous as is_anonymous,
  DATE(created_at) as report_date,
  EXTRACT(MONTH FROM created_at) as report_month,
  EXTRACT(YEAR FROM created_at) as report_year,
  CASE WHEN status = 'traite' THEN true ELSE false END as is_resolved
FROM reports
WHERE anonymized_at IS NULL;

COMMENT ON VIEW v_report_statistics IS 'Anonymized view for statistical analysis — RGPD compliant, no PII fields';
