-- SafeSchool V9 Migration: GDPR enhancements + encryption fields + audit improvements

-- Add encrypted fields to reports for RGPD compliance
ALTER TABLE reports ADD COLUMN IF NOT EXISTS description_encrypted JSONB;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS reporter_name_encrypted JSONB;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS reporter_email_encrypted JSONB;

-- Add GDPR deletion request tracking
ALTER TABLE reports ADD COLUMN IF NOT EXISTS gdpr_deletion_requested_at TIMESTAMPTZ;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS gdpr_anonymized_at TIMESTAMPTZ;

-- Add case_number if not exists (for GDPR export)
ALTER TABLE reports ADD COLUMN IF NOT EXISTS case_number TEXT;

-- Ensure audit_logs has proper structure for GDPR tracking
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS action TEXT DEFAULT 'app_log';
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS actor_type TEXT DEFAULT 'system';

-- Index for GDPR deletion requests
CREATE INDEX IF NOT EXISTS idx_reports_gdpr_deletion ON reports (gdpr_deletion_requested_at) WHERE gdpr_deletion_requested_at IS NOT NULL;

-- Index for tracking code lookups (public GDPR export)
CREATE INDEX IF NOT EXISTS idx_reports_tracking_code ON reports (tracking_code);

-- Withdrawal status support
-- (reports.status can now be 'withdrawal_requested' or 'anonymized')
