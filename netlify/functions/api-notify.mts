import type { Context, Config } from '@netlify/functions';

// Email notification stub — will integrate with a real email provider (SendGrid, Resend, etc.)
// For now, logs the notification intent and returns success

function cors(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS'
    }
  });
}

export default async (req: Request, context: Context) => {
  if (req.method === 'OPTIONS') return cors({ ok: true });

  if (req.method !== 'POST') return cors({ error: 'Method not allowed' }, 405);

  const url = new URL(req.url);
  const path = url.pathname.replace('/api/notify', '');

  try {
    const body = await req.json() as any;

    // POST /api/notify/new-report — Notify admin of new report
    if (path === '/new-report') {
      const { schoolId, reportId, urgency, type } = body;
      // In production: send email to admin via SendGrid/Resend
      console.log(`[NOTIFY] New report for school ${schoolId}: ${reportId} (${type}, urgency: ${urgency})`);
      return cors({
        sent: false,
        reason: 'email_not_configured',
        message: 'Notification enregistrée. L\'envoi d\'emails sera activé après configuration du provider.'
      });
    }

    // POST /api/notify/status-update — Notify reporter of status change
    if (path === '/status-update') {
      const { reportId, trackingCode, newStatus, email } = body;
      if (!email) return cors({ sent: false, reason: 'no_email', message: 'Pas d\'email fourni par le déclarant.' });
      console.log(`[NOTIFY] Status update for ${trackingCode}: ${newStatus} → ${email}`);
      return cors({
        sent: false,
        reason: 'email_not_configured',
        message: 'Notification enregistrée. L\'email sera envoyé après configuration du provider.'
      });
    }

    // POST /api/notify/staff-reply — Notify reporter of staff reply
    if (path === '/staff-reply') {
      const { reportId, trackingCode, email } = body;
      if (!email) return cors({ sent: false, reason: 'no_email' });
      console.log(`[NOTIFY] Staff reply for ${trackingCode} → ${email}`);
      return cors({
        sent: false,
        reason: 'email_not_configured',
        message: 'Notification enregistrée.'
      });
    }

    return cors({ error: 'Route de notification inconnue' }, 404);
  } catch (e) {
    return cors({ error: 'Requête invalide' }, 400);
  }
};

export const config: Config = {
  path: '/api/notify/*'
};
