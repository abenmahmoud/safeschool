import { getStore } from '@netlify/blobs';
import type { Context, Config } from '@netlify/functions';
import { isSuperadminRequest, jsonCors, safeJson, sanitizeText } from './_lib/security.mts';

// ---------------------------------------------------------------------------
// Auth & helpers
// ---------------------------------------------------------------------------

// ── V8 Extra Pro — Environment-driven auth ──
const SA_EMAIL = () => Netlify.env.get('SUPERADMIN_EMAIL') || '';

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

function emailWelcome(p: Record<string, any>): string {
  return wrapHtml('Bienvenue sur SafeSchool', `
    <p>Bienvenue ${p.name ? `<strong>${sanitizeText(p.name, 80)}</strong>` : ''}.</p>
    <p>Votre espace SafeSchool est pret. Vous pouvez vous connecter et commencer la configuration de votre etablissement.</p>
  `);
}

function emailVerification(p: Record<string, any>): string {
  return wrapHtml('Verification de votre email', `
    <p>Confirmez votre adresse email pour activer votre compte.</p>
    <p><a href="${sanitizeText(p.verifyUrl || '#', 500)}" style="display:inline-block;padding:10px 20px;background:#1a56db;color:#fff;text-decoration:none;border-radius:4px;">Verifier mon email</a></p>
  `);
}

function emailPasswordReset(p: Record<string, any>): string {
  return wrapHtml('Reinitialisation de mot de passe', `
    <p>Une demande de reinitialisation a ete recue.</p>
    <p><a href="${sanitizeText(p.resetUrl || '#', 500)}" style="display:inline-block;padding:10px 20px;background:#1a56db;color:#fff;text-decoration:none;border-radius:4px;">Reinitialiser mon mot de passe</a></p>
  `);
}

function emailAdminAlert(p: Record<string, any>): string {
  return wrapHtml('Alerte administrateur', `
    <p>${sanitizeText(p.message || 'Une action administrateur requiert votre attention.', 1000)}</p>
    <p>Etablissement: <strong>${sanitizeText(p.schoolName || p.schoolId || '-', 120)}</strong></p>
  `);
}

function emailAcknowledgement(p: Record<string, any>): string {
  return wrapHtml('Accuse de reception', `
    <p>Le signalement <strong>${sanitizeText(p.trackingCode || '-', 80)}</strong> a bien ete recu.</p>
    <p>Une equipe habilitee prendra en charge votre demande selon le niveau d'urgence.</p>
  `);
}

async function sendEmail(params: {
  to: string;
  subject: string;
  html: string;
}): Promise<{ sent: boolean; provider: string; reason?: string }> {
  const resendKey = Netlify.env.get('RESEND_API_KEY') || '';
  const from = Netlify.env.get('EMAIL_FROM') || 'SafeSchool <no-reply@safeschool.fr>';
  if (!resendKey) {
    return { sent: false, provider: 'none', reason: 'email_not_configured' };
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from,
        to: [params.to],
        subject: params.subject,
        html: params.html
      })
    });

    if (!response.ok) {
      return { sent: false, provider: 'resend', reason: `resend_${response.status}` };
    }
    return { sent: true, provider: 'resend' };
  } catch {
    return { sent: false, provider: 'resend', reason: 'resend_network_error' };
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export default async (req: Request, context: Context) => {
  if (req.method === 'OPTIONS') return jsonCors({ ok: true }, 200, req);

  const url  = new URL(req.url);
  const path = url.pathname.replace('/api/notify', '');

  try {
    // =======================================================================
    // GET /api/notify/history  (superadmin only)
    // =======================================================================
    if (req.method === 'GET' && path === '/history') {
      if (!(await isSuperadminRequest(req))) return jsonCors({ error: 'Non autorise' }, 401, req);

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

      return jsonCors({ day, total: ids.length, showing: records.length, notifications: records }, 200, req);
    }

    // =======================================================================
    // GET /api/notify/stats  (superadmin only)
    // =======================================================================
    if (req.method === 'GET' && path === '/stats') {
      if (!(await isSuperadminRequest(req))) return jsonCors({ error: 'Non autorise' }, 401, req);

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

      return jsonCors({ day, total: ids.length, sent, skipped, failed, by_type: byType, by_school: bySchool }, 200, req);
    }

    // =======================================================================
    // POST endpoints — parse body once
    // =======================================================================
    if (req.method !== 'POST') return jsonCors({ error: 'Method not allowed' }, 405, req);

    const body = await safeJson(req);

    // =======================================================================
    // POST /api/notify/test  (superadmin only)
    // =======================================================================
    if (path === '/test') {
      if (!(await isSuperadminRequest(req))) return jsonCors({ error: 'Non autorise' }, 401, req);

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

      return jsonCors({
        id,
        sent: false,
        reason: 'email_not_configured',
        message: 'Notification de test enregistree. L\'email sera envoye apres configuration du provider.',
        email_preview: html,
      }, 200, req);
    }

    // =======================================================================
    // POST /api/notify/digest
    // =======================================================================
    if (path === '/digest') {
      if (!(await isSuperadminRequest(req))) return jsonCors({ error: 'Non autorise' }, 401, req);

      const { schoolId } = body;
      if (!schoolId) return jsonCors({ error: 'schoolId requis' }, 400, req);

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

      return jsonCors({
        id,
        sent: false,
        reason: 'email_not_configured',
        message: 'Digest genere et enregistre.',
        schoolId,
        stats: digestStats,
        email_preview: html,
      }, 200, req);
    }

    // =======================================================================
    // POST /api/notify/welcome | /email-verification | /password-reset | /admin-alert | /ack
    // =======================================================================
    if (['/welcome', '/email-verification', '/password-reset', '/admin-alert', '/ack'].includes(path)) {
      const email = sanitizeText(String(body.email || ''), 160);
      if (!email) return jsonCors({ error: 'email requis' }, 400, req);
      const schoolId = sanitizeText(String(body.schoolId || 'platform'), 120);
      if (await isRateLimited(schoolId)) {
        return jsonCors({ error: 'Rate limit atteint (100 notifications/jour par ecole)' }, 429, req);
      }

      const cfg: Record<string, { type: string; subject: string; html: string }> = {
        '/welcome': { type: 'welcome', subject: 'Bienvenue sur SafeSchool', html: emailWelcome(body) },
        '/email-verification': { type: 'email-verification', subject: 'Verification de votre email', html: emailVerification(body) },
        '/password-reset': { type: 'password-reset', subject: 'Reinitialisation de mot de passe', html: emailPasswordReset(body) },
        '/admin-alert': { type: 'admin-alert', subject: 'Alerte administrateur SafeSchool', html: emailAdminAlert(body) },
        '/ack': { type: 'acknowledgement', subject: 'Accuse de reception SafeSchool', html: emailAcknowledgement(body) }
      };
      const selected = cfg[path];

      const id = genId();
      const sendResult = await sendEmail({ to: email, subject: selected.subject, html: selected.html });
      const record: NotificationRecord = {
        id,
        type: selected.type,
        schoolId,
        recipient: email,
        status: sendResult.sent ? 'sent' : 'queued',
        reason: sendResult.reason || undefined,
        payload: body,
        email_preview: selected.html,
        created_at: new Date().toISOString()
      };
      await storeNotification(record);

      return jsonCors({
        id,
        sent: sendResult.sent,
        reason: sendResult.reason || null,
        provider: sendResult.provider
      }, 200, req);
    }

    // =======================================================================
    // POST /api/notify/new-report
    // =======================================================================
    if (path === '/new-report') {
      const { schoolId, reportId, urgency, type } = body;
      if (!schoolId) return jsonCors({ error: 'schoolId requis' }, 400, req);

      if (await isRateLimited(schoolId)) {
        return jsonCors({ error: 'Rate limit atteint (100 notifications/jour par ecole)' }, 429, req);
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
      console.log(`[NOTIFY] New report for school ${schoolId}: ${reportId} (${type}, urgency: ${urgency})`);

      const adminEmail = sanitizeText(String(body.adminEmail || ''), 160);
      const sendResult = adminEmail ? await sendEmail({
        to: adminEmail,
        subject: 'SafeSchool - Nouveau signalement',
        html
      }) : { sent: false, provider: 'none', reason: 'missing_admin_email' };

      record.status = sendResult.sent ? 'sent' : 'queued';
      record.reason = sendResult.reason || undefined;
      await storeNotification(record);

      return jsonCors({
        id,
        sent: sendResult.sent,
        reason: sendResult.reason || null,
        message: sendResult.sent ? 'Notification envoyee.' : 'Notification enregistree.',
        provider: sendResult.provider,
        email_preview: html,
      }, 200, req);
    }

    // =======================================================================
    // POST /api/notify/status-update
    // =======================================================================
    if (path === '/status-update') {
      const { reportId, trackingCode, newStatus, email, schoolId } = body;

      if (!email) {
        return jsonCors({ id: null, sent: false, reason: 'no_email', message: 'Pas d\'email fourni par le declarant.' }, 200, req);
      }

      const sid = schoolId || 'unknown';
      if (await isRateLimited(sid)) {
        return jsonCors({ error: 'Rate limit atteint (100 notifications/jour par ecole)' }, 429, req);
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
      const recipient = sanitizeText(String(email), 160);
      const sendResult = await sendEmail({
        to: recipient,
        subject: 'SafeSchool - Mise a jour de votre signalement',
        html
      });
      record.status = sendResult.sent ? 'sent' : 'queued';
      record.reason = sendResult.reason || undefined;
      await storeNotification(record);
      console.log(`[NOTIFY] Status update for ${trackingCode}: ${newStatus} -> ${email}`);

      return jsonCors({
        id,
        sent: sendResult.sent,
        reason: sendResult.reason || null,
        provider: sendResult.provider,
        message: sendResult.sent ? 'Notification envoyee.' : 'Notification enregistree.',
        email_preview: html,
      }, 200, req);
    }

    // =======================================================================
    // POST /api/notify/staff-reply
    // =======================================================================
    if (path === '/staff-reply') {
      const { reportId, trackingCode, email, message, schoolId } = body;

      if (!email) {
        return jsonCors({ id: null, sent: false, reason: 'no_email' }, 200, req);
      }

      const sid = schoolId || 'unknown';
      if (await isRateLimited(sid)) {
        return jsonCors({ error: 'Rate limit atteint (100 notifications/jour par ecole)' }, 429, req);
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
      const recipient = sanitizeText(String(email), 160);
      const sendResult = await sendEmail({
        to: recipient,
        subject: 'SafeSchool - Reponse de l\'equipe educative',
        html
      });
      record.status = sendResult.sent ? 'sent' : 'queued';
      record.reason = sendResult.reason || undefined;
      await storeNotification(record);
      console.log(`[NOTIFY] Staff reply for ${trackingCode} -> ${email}`);

      return jsonCors({
        id,
        sent: sendResult.sent,
        reason: sendResult.reason || null,
        provider: sendResult.provider,
        message: sendResult.sent ? 'Notification envoyee.' : 'Notification enregistree.',
        email_preview: html,
      }, 200, req);
    }

    return jsonCors({ error: 'Route de notification inconnue' }, 404, req);
  } catch (e: any) {
    console.error('[NOTIFY] Error:', e?.message || e);
    return jsonCors({ error: 'Requete invalide' }, 400, req);
  }
};

export const config: Config = {
  path: '/api/notify/*',
};
