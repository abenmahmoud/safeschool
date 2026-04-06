import { getStore } from '@netlify/blobs';
import type { Config } from '@netlify/functions';

// ---------------------------------------------------------------------------
// RGPD Data Retention — Scheduled function
// Runs daily to anonymize/delete data older than the retention period.
// ---------------------------------------------------------------------------

const RETENTION_DAYS = 365; // 1 year retention for reports data
const NOTIFICATION_RETENTION_DAYS = 90; // 90 days for notifications
const RATE_LIMIT_RETENTION_DAYS = 1; // 1 day for rate limit data

function isOlderThan(dateStr: string, days: number): boolean {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return false;
  const threshold = Date.now() - days * 24 * 60 * 60 * 1000;
  return date.getTime() < threshold;
}

export default async (req: Request) => {
  try {
    const body = await req.json().catch(() => ({}));
    console.log('[RGPD-RETENTION] Starting data retention cleanup. Next run:', body.next_run || 'unknown');

    let totalCleaned = 0;

    // ── 1. Clean old notifications ──
    try {
      const notifStore = getStore({ name: 'notifications', consistency: 'strong' });
      const cutoffDate = new Date(Date.now() - NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60 * 1000);

      // Check daily index keys for old days
      for (let d = NOTIFICATION_RETENTION_DAYS; d < NOTIFICATION_RETENTION_DAYS + 30; d++) {
        const oldDate = new Date(Date.now() - d * 24 * 60 * 60 * 1000);
        const dayKey = `day_${oldDate.toISOString().slice(0, 10)}`;

        const ids = await notifStore.get(dayKey, { type: 'json' }).catch(() => null) as string[] | null;
        if (ids && ids.length > 0) {
          for (const id of ids) {
            await notifStore.delete(id).catch(() => {});
            totalCleaned++;
          }
          await notifStore.delete(dayKey).catch(() => {});
          console.log(`[RGPD-RETENTION] Cleaned ${ids.length} notifications for ${oldDate.toISOString().slice(0, 10)}`);
        }
      }
    } catch (e: any) {
      console.error('[RGPD-RETENTION] Notification cleanup error:', e?.message);
    }

    // ── 2. Clean old rate limit entries ──
    try {
      const rlStore = getStore({ name: 'rate-limits', consistency: 'strong' });
      const { blobs } = await rlStore.list({ prefix: 'login_' });
      for (const blob of blobs) {
        const data = await rlStore.get(blob.key, { type: 'json' }).catch(() => null) as any;
        if (data?.attempts) {
          const cutoff = Date.now() - RATE_LIMIT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
          const recent = data.attempts.filter((ts: number) => ts > cutoff);
          if (recent.length === 0) {
            await rlStore.delete(blob.key).catch(() => {});
            totalCleaned++;
          }
        }
      }
    } catch (e: any) {
      console.error('[RGPD-RETENTION] Rate limit cleanup error:', e?.message);
    }

    // ── 3. Clean old push notification queue entries ──
    try {
      const pushStore = getStore({ name: 'push-queue', consistency: 'strong' });
      const { blobs } = await pushStore.list({ prefix: 'push_' });
      for (const blob of blobs) {
        const data = await pushStore.get(blob.key, { type: 'json' }).catch(() => null) as any;
        if (data?.createdAt && isOlderThan(data.createdAt, NOTIFICATION_RETENTION_DAYS)) {
          await pushStore.delete(blob.key).catch(() => {});
          totalCleaned++;
        }
      }
    } catch (e: any) {
      console.error('[RGPD-RETENTION] Push queue cleanup error:', e?.message);
    }

    // ── 4. Clean old activity log entries ──
    try {
      const activityStore = getStore({ name: 'activity-log', consistency: 'strong' });
      const { blobs } = await activityStore.list({ prefix: 'event_' });
      for (const blob of blobs) {
        const data = await activityStore.get(blob.key, { type: 'json' }).catch(() => null) as any;
        if (data?.timestamp && isOlderThan(data.timestamp, RETENTION_DAYS)) {
          await activityStore.delete(blob.key).catch(() => {});
          totalCleaned++;
        }
      }
    } catch (e: any) {
      console.error('[RGPD-RETENTION] Activity log cleanup error:', e?.message);
    }

    // ── 5. Anonymize old report photos metadata ──
    try {
      const photoStore = getStore('report-photos');
      const { blobs } = await photoStore.list();
      for (const blob of blobs) {
        if (blob.key.endsWith('/_index')) {
          const index = await photoStore.get(blob.key, { type: 'json' }).catch(() => null) as any[];
          if (index && index.length > 0) {
            // Check if first photo is old enough
            const firstUpload = index[0]?.uploadedAt || index[0]?.uploaded_at;
            if (firstUpload && isOlderThan(firstUpload, RETENTION_DAYS)) {
              // Delete all photos for this report
              const reportPrefix = blob.key.replace('/_index', '');
              const { blobs: photos } = await photoStore.list({ prefix: reportPrefix });
              for (const photo of photos) {
                await photoStore.delete(photo.key).catch(() => {});
                totalCleaned++;
              }
              console.log(`[RGPD-RETENTION] Cleaned photos for report ${reportPrefix}`);
            }
          }
        }
      }
    } catch (e: any) {
      console.error('[RGPD-RETENTION] Photo cleanup error:', e?.message);
    }

    // ── 6. Store cleanup audit log ──
    try {
      const auditStore = getStore({ name: 'activity-log', consistency: 'strong' });
      const key = `event_${new Date().toISOString().replace(/[:.]/g, '-')}_rgpd-retention`;
      await auditStore.setJSON(key, {
        type: 'rgpd_retention',
        message: `Nettoyage RGPD automatique: ${totalCleaned} elements supprimes`,
        metadata: {
          retention_days: RETENTION_DAYS,
          notification_retention_days: NOTIFICATION_RETENTION_DAYS,
          items_cleaned: totalCleaned
        },
        timestamp: new Date().toISOString(),
        ip: 'system'
      });
    } catch (e: any) {
      console.error('[RGPD-RETENTION] Audit log error:', e?.message);
    }

    console.log(`[RGPD-RETENTION] Cleanup complete. ${totalCleaned} items removed.`);
  } catch (error: any) {
    console.error('[RGPD-RETENTION] Fatal error:', error?.message || error);
  }
};

export const config: Config = {
  schedule: '@daily'
};
