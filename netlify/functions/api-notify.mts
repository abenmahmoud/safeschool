import { getStore } from '@netlify/blobs';
import type { Context, Config } from '@netlify/functions';

// ---------------------------------------------------------------------------
// Auth & helpers
// ---------------------------------------------------------------------------

// ── V8 Extra Pro — Environment-driven auth ──
const SA_EMAIL = () => Netlify.env.get('SUPERADMIN_EMAIL') || '';
const SA_PASS  = () => Netlify.env.get('SUPERADMIN_PASS')  || '';

function cors(body: any, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, x-sa-token',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    },
  });
}

function authCheck(req: Request): boolean {
  const token = req.headers.get('x-sa-token');
  if (!token) return false;
  try {
    return atob(token) === `${SA_EMAIL()}:${SA_PASS()}`;
  } catch {
    return false;
  }
}

function genId(): string {
  return `ntf_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// ---------------------------------------------------------------------------
// Blob helpers  (store: "notifications")
// ---------------------------------------------------------------------------

function getNotifStore() {
  return getStore({ name: 'notifications', consistency: 'strong' });
}

interface NotificationRecord {
  id: string;
  type: string;         // new-report | status-update | staff-reply | digest | test
  schoolId?: string;
  recipient?: string;
  status: 'queued' | 'sent' | 'skipped' | 'failed';
  reason?: string;
  payload: Record<string, any>;
  email_preview?: string;
  created_at: string;
}

/** Persist a single notification record and update the daily index. */
async function storeNotification(record: NotificationRecord) {
  const store = getNotifStore();

  // 1. Store individual record
  await store.setJSON(record.id, record);

  // 2. Update daily index  (list of IDs per day)
  const dayKey = `day_${todayKey()}`;
  const existing = (await store.get(dayKey, { type: 'json' }).catch(() => null)) as string[] | null;
  const ids = existing ?? [];
  ids.push(record.id);
  await store.setJSON(dayKey, ids);

  // 3. Update per-school daily counter for rate limiting
  if (record.schoolId) {
    const rlKey = `rl_${record.schoolId}_${todayKey()}`;
    const count = ((await store.get(rlKey, { type: 'json' }).catch(() => null)) as number | null) ?? 0;
    await store.setJSON(rlKey, count + 1);
  }
}

/** Check whether a school has exceeded 100 notifications today. */
async function isRateLimited(schoolId: string): Promise<boolean> {
  const store = getNotifStore();
  const rlKey = `rl_${schoolId}_${todayKey()}`;
  const count = ((await store.get(rlKey, { type: 'json' }).catch(() => null)) as number | null) ?? 0;
  return count >= 100;
}

// ---------------------------------------------------------------------------
// Email template generation
// ---------------------------------------------------------------------------

function wrapHtml(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="utf-8"><title>${title}</title></head>
<body style="margin:0;padding:0;font-family:Arial,Helvetica,sans-serif;background:#f4f6f8;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:24px auto;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e2e8f0;">
  <tr><td style="background:#1a56db;padding:20px 24px;color:#fff;font-size:20px;font-weight:bold;">${title}</td></tr>
  <tr><td style="padding:24px;">${body}</td></tr>
  <tr><td style="padding:16px 24px;font-size:12px;color:#94a3b8;border-top:1px solid #e2e8f0;">SafeSchool Notifications &mdash; Ne pas r&eacute;pondre &agrave; cet email.</td></tr>
</table>
</body>
</html>`;
}

function emailNewReport(p: Record<string, any>): string {
  return wrapHtml('Nouveau signalement', `
    <p style="margin:0 0 12px;">Un nouveau signalement a ete soumis.</p>
    <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
      <tr><td style="padding:6px 0;font-weight:bold;">ID du rapport</td><td>${p.reportId ?? '-'}</td></tr>
      <tr><td style="padding:6px 0;font-weight:bold;">Type</td><td>${p.type ?? '-'}</td></tr>
      <tr><td style="padding:6px 0;font-weight:bold;">Urgence</td><td>${p.urgency ?? '-'}</td></tr>
      <tr><td style="padding:6px 0;font-weight:bold;">Ecole</td><td>${p.schoolId ?? '-'}</td></tr>
    </table>
    <a href="#" style="display:inline-block;padding:10px 20px;background:#1a56db;color:#fff;text-decoration:none;border-radius:4px;">Voir le signalement</a>
  `);
}

function emailStatusUpdate(p: Record<string, any>): string {
  return wrapHtml('Mise a jour de votre signalement', `
    <p>Votre signalement <strong>${p.trackingCode ?? ''}</strong> a change de statut.</p>
    <p style="font-size:18px;font-weight:bold;color:#1a56db;margin:16px 0;">${p.newStatus ?? '-'}</p>
    <p>Vous pouvez suivre votre signalement avec votre code de suivi.</p>
  `);
}

function emailStaffReply(p: Record<string, any>): string {
  return wrapHtml('Reponse de l\'equipe', `
    <p>L'equipe a repondu a votre signalement <strong>${p.trackingCode ?? ''}</strong>.</p>
    <p style="background:#f1f5f9;padding:12px;border-radius:4px;margin:16px 0;">${p.message ?? 'Consultez la plateforme pour lire la reponse.'}</p>
  `);
}

function emailDigest(p: Record<string, any>): string {
  const stats = p.stats || {};
  return wrapHtml(`Digest quotidien &mdash; ${p.schoolId ?? ''}`, `
    <p>Voici le resume des notifications pour aujourd'hui :</p>
    <table style="width:100%;border-collapse:collapse;">
      <tr><td style="padding:6px 0;font-weight:bold;">Total envoyes</td><td>${stats.total ?? 0}</td></tr>
      <tr><td style="padding:6px 0;font-weight:bold;">Nouveaux signalements</td><td>${stats.newReports ?? 0}</td></tr>
      <tr><td style="padding:6px 0;font-weight:bold;">Mises a jour</td><td>${stats.statusUpdates ?? 0}</td></tr>
      <tr><td style="padding:6px 0;font-weight:bold;">Reponses</td><td>${stats.replies ?? 0}</td></tr>
    </table>
  `);
}

function emailTest(): string {
  return wrapHtml('Test de notification', `
    <p>Ceci est une notification de test envoyee depuis le panneau superadmin.</p>
    <p>Si vous recevez cet email, la configuration est correcte.</p>
  `);
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export default async (req: Request, context: Context) => {
  if (req.method === 'OPTIONS') return cors({ ok: true });

  const url  = new URL(req.url);
  const path = url.pathname.replace('/api/notify', '');

  try {
    // =======================================================================
    // GET /api/notify/history  (superadmin only)
    // =======================================================================
    if (req.method === 'GET' && path === '/history') {
      if (!authCheck(req)) return cors({ error: 'Non autorise' }, 401);

      const store  = getNotifStore();
      const day    = url.searchParams.get('day') || todayKey();
      const dayKey = `day_${day}`;
      const ids    = (await store.get(dayKey, { type: 'json' }).catch(() => null)) as string[] | null ?? [];

      const limit  = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
      const recent = ids.slice(-limit).reverse();

      const records: NotificationRecord[] = [];
      for (const id of recent) {
        const rec = await store.get(id, { type: 'json' }).catch(() => null) as NotificationRecord | null;
        if (rec) records.push(rec);
      }

      return cors({ day, total: ids.length, showing: records.length, notifications: records });
    }

    // =======================================================================
    // GET /api/notify/stats  (superadmin only)
    // =======================================================================
    if (req.method === 'GET' && path === '/stats') {
      if (!authCheck(req)) return cors({ error: 'Non autorise' }, 401);

      const store  = getNotifStore();
      const day    = url.searchParams.get('day') || todayKey();
      const dayKey = `day_${day}`;
      const ids    = (await store.get(dayKey, { type: 'json' }).catch(() => null)) as string[] | null ?? [];

      const byType: Record<string, number>   = {};
      const bySchool: Record<string, number>  = {};
      let sent = 0;
      let skipped = 0;
      let failed = 0;

      for (const id of ids) {
        const rec = await store.get(id, { type: 'json' }).catch(() => null) as NotificationRecord | null;
        if (!rec) continue;
        byType[rec.type]   = (byType[rec.type] || 0) + 1;
        if (rec.schoolId) bySchool[rec.schoolId] = (bySchool[rec.schoolId] || 0) + 1;
        if (rec.status === 'sent' || rec.status === 'queued') sent++;
        else if (rec.status === 'skipped') skipped++;
        else if (rec.status === 'failed') failed++;
      }

      return cors({ day, total: ids.length, sent, skipped, failed, by_type: byType, by_school: bySchool });
    }

    // =======================================================================
    // POST endpoints — parse body once
    // =======================================================================
    if (req.method !== 'POST') return cors({ error: 'Method not allowed' }, 405);

    const body = await req.json() as Record<string, any>;

    // =======================================================================
    // POST /api/notify/test  (superadmin only)
    // =======================================================================
    if (path === '/test') {
      if (!authCheck(req)) return cors({ error: 'Non autorise' }, 401);

      const id = genId();
      const html = emailTest();
      const record: NotificationRecord = {
        id,
        type: 'test',
        recipient: body.email || SA_EMAIL(),
        status: 'queued',
        reason: 'email_not_configured',
        payload: body,
        email_preview: html,
        created_at: new Date().toISOString(),
      };
      await storeNotification(record);

      return cors({
        id,
        sent: false,
        reason: 'email_not_configured',
        message: 'Notification de test enregistree. L\'email sera envoye apres configuration du provider.',
        email_preview: html,
      });
    }

    // =======================================================================
    // POST /api/notify/digest
    // =======================================================================
    if (path === '/digest') {
      if (!authCheck(req)) return cors({ error: 'Non autorise' }, 401);

      const { schoolId } = body;
      if (!schoolId) return cors({ error: 'schoolId requis' }, 400);

      // Gather today's stats for this school
      const store  = getNotifStore();
      const dayKey = `day_${todayKey()}`;
      const ids    = (await store.get(dayKey, { type: 'json' }).catch(() => null)) as string[] | null ?? [];

      let newReports = 0;
      let statusUpdates = 0;
      let replies = 0;

      for (const nid of ids) {
        const rec = await store.get(nid, { type: 'json' }).catch(() => null) as NotificationRecord | null;
        if (!rec || rec.schoolId !== schoolId) continue;
        if (rec.type === 'new-report') newReports++;
        else if (rec.type === 'status-update') statusUpdates++;
        else if (rec.type === 'staff-reply') replies++;
      }

      const digestStats = { total: newReports + statusUpdates + replies, newReports, statusUpdates, replies };
      const html = emailDigest({ schoolId, stats: digestStats });

      const id = genId();
      const record: NotificationRecord = {
        id,
        type: 'digest',
        schoolId,
        status: 'queued',
        reason: 'email_not_configured',
        payload: { schoolId, digestStats },
        email_preview: html,
        created_at: new Date().toISOString(),
      };
      await storeNotification(record);

      return cors({
        id,
        sent: false,
        reason: 'email_not_configured',
        message: 'Digest genere et enregistre.',
        schoolId,
        stats: digestStats,
        email_preview: html,
      });
    }

    // =======================================================================
    // POST /api/notify/new-report
    // =======================================================================
    if (path === '/new-report') {
      const { schoolId, reportId, urgency, type } = body;
      if (!schoolId) return cors({ error: 'schoolId requis' }, 400);

      if (await isRateLimited(schoolId)) {
        return cors({ error: 'Rate limit atteint (100 notifications/jour par ecole)' }, 429);
      }

      const id   = genId();
      const html = emailNewReport({ schoolId, reportId, urgency, type });

      const record: NotificationRecord = {
        id,
        type: 'new-report',
        schoolId,
        status: 'queued',
        reason: 'email_not_configured',
        payload: { schoolId, reportId, urgency, type },
        email_preview: html,
        created_at: new Date().toISOString(),
      };
      await storeNotification(record);
      console.log(`[NOTIFY] New report for school ${schoolId}: ${reportId} (${type}, urgency: ${urgency})`);

      return cors({
        id,
        sent: false,
        reason: 'email_not_configured',
        message: 'Notification enregistree. L\'envoi d\'emails sera active apres configuration du provider.',
        email_preview: html,
      });
    }

    // =======================================================================
    // POST /api/notify/status-update
    // =======================================================================
    if (path === '/status-update') {
      const { reportId, trackingCode, newStatus, email, schoolId } = body;

      if (!email) {
        return cors({ id: null, sent: false, reason: 'no_email', message: 'Pas d\'email fourni par le declarant.' });
      }

      const sid = schoolId || 'unknown';
      if (await isRateLimited(sid)) {
        return cors({ error: 'Rate limit atteint (100 notifications/jour par ecole)' }, 429);
      }

      const id   = genId();
      const html = emailStatusUpdate({ trackingCode, newStatus });

      const record: NotificationRecord = {
        id,
        type: 'status-update',
        schoolId: sid,
        recipient: email,
        status: 'queued',
        reason: 'email_not_configured',
        payload: { reportId, trackingCode, newStatus, email },
        email_preview: html,
        created_at: new Date().toISOString(),
      };
      await storeNotification(record);
      console.log(`[NOTIFY] Status update for ${trackingCode}: ${newStatus} -> ${email}`);

      return cors({
        id,
        sent: false,
        reason: 'email_not_configured',
        message: 'Notification enregistree. L\'email sera envoye apres configuration du provider.',
        email_preview: html,
      });
    }

    // =======================================================================
    // POST /api/notify/staff-reply
    // =======================================================================
    if (path === '/staff-reply') {
      const { reportId, trackingCode, email, message, schoolId } = body;

      if (!email) {
        return cors({ id: null, sent: false, reason: 'no_email' });
      }

      const sid = schoolId || 'unknown';
      if (await isRateLimited(sid)) {
        return cors({ error: 'Rate limit atteint (100 notifications/jour par ecole)' }, 429);
      }

      const id   = genId();
      const html = emailStaffReply({ trackingCode, message });

      const record: NotificationRecord = {
        id,
        type: 'staff-reply',
        schoolId: sid,
        recipient: email,
        status: 'queued',
        reason: 'email_not_configured',
        payload: { reportId, trackingCode, email, message },
        email_preview: html,
        created_at: new Date().toISOString(),
      };
      await storeNotification(record);
      console.log(`[NOTIFY] Staff reply for ${trackingCode} -> ${email}`);

      return cors({
        id,
        sent: false,
        reason: 'email_not_configured',
        message: 'Notification enregistree.',
        email_preview: html,
      });
    }

    return cors({ error: 'Route de notification inconnue' }, 404);
  } catch (e: any) {
    console.error('[NOTIFY] Error:', e?.message || e);
    return cors({ error: 'Requete invalide', detail: e?.message }, 400);
  }
};

export const config: Config = {
  path: '/api/notify/*',
};
