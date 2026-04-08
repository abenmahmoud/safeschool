import { getStore } from '@netlify/blobs';
import type { Context, Config } from '@netlify/functions';

const SUPABASE_URL = Netlify.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_KEY = Netlify.env.get('SUPABASE_SERVICE_ROLE_KEY') || Netlify.env.get('SUPABASE_ANON_KEY') || '';

// ---------------------------------------------------------------------------
// Rate limiting — 10 requests per IP per 15 minutes for GDPR endpoints
// ---------------------------------------------------------------------------
const GDPR_RATE_LIMIT = 10;
const GDPR_RATE_WINDOW_MS = 15 * 60 * 1000;

async function checkGdprRateLimit(ip: string): Promise<boolean> {
  const store = getStore({ name: 'rate-limits', consistency: 'strong' });
  const key = `gdpr_${ip.replace(/[^a-zA-Z0-9]/g, '_')}`;
  const now = Date.now();
  let entry: { attempts: number[] } | null = null;
  try {
    entry = await store.get(key, { type: 'json' }) as any;
  } catch { entry = null; }
  const recent = entry?.attempts?.filter((ts: number) => now - ts < GDPR_RATE_WINDOW_MS) || [];
  if (recent.length >= GDPR_RATE_LIMIT) return true;
  recent.push(now);
  await store.setJSON(key, { attempts: recent });
  return false;
}

function cors(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    }
  });
}

async function supabaseQuery(table: string, params: string) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json'
    }
  });
  if (!res.ok) return null;
  return res.json();
}

export default async function handler(req: Request, context: Context) {
  if (req.method === 'OPTIONS') {
    return cors({ ok: true });
  }

  try {
  const url = new URL(req.url);
  const path = url.pathname.replace('/api/gdpr', '').replace(/^\//, '');

  // Rate limit all GDPR endpoints
  const clientIp = context.ip || req.headers.get('x-forwarded-for') || 'unknown';
  if (await checkGdprRateLimit(clientIp)) {
    return cors({ error: 'Too many requests. Please try again later.' }, 429);
  }

  // GET /api/gdpr/export?code=SS-XXXXXX — export all data for a tracking code
  if (req.method === 'GET' && path === 'export') {
    const code = url.searchParams.get('code')?.trim().toUpperCase();
    if (!code || !/^SS-[A-Z0-9]{4,8}$/.test(code)) {
      return cors({ error: 'Invalid tracking code format' }, 400);
    }

    const exportData: Record<string, any> = { trackingCode: code, exportedAt: new Date().toISOString() };

    // Try Supabase
    const reports = await supabaseQuery('reports', `tracking_code=eq.${encodeURIComponent(code)}&select=id,tracking_code,case_number,type,status,urgence,description,location,frequency,reporter_role,is_anonymous,created_at,updated_at,staff_reply`);
    if (reports && reports.length > 0) {
      exportData.report = {
        id: reports[0].id,
        trackingCode: reports[0].tracking_code,
        caseNumber: reports[0].case_number,
        type: reports[0].type,
        status: reports[0].status,
        urgency: reports[0].urgence,
        description: reports[0].description,
        location: reports[0].location,
        frequency: reports[0].frequency,
        reporterRole: reports[0].reporter_role,
        isAnonymous: reports[0].is_anonymous,
        createdAt: reports[0].created_at,
        updatedAt: reports[0].updated_at,
        staffReply: reports[0].staff_reply
      };
    }

    // Also check Netlify Blobs for any stored data
    try {
      const reportStore = getStore({ name: 'report-photos', consistency: 'strong' });
      const { blobs } = await reportStore.list({ prefix: `${code}/` });
      if (blobs.length > 0) {
        exportData.attachments = blobs.map(b => ({ key: b.key }));
      }
    } catch (e) { /* no photos */ }

    return cors(exportData);
  }

  // POST /api/gdpr/delete-request — request data deletion (soft-delete + audit)
  if (req.method === 'POST' && path === 'delete-request') {
    let body: any;
    try { body = await req.json(); } catch { return cors({ error: 'Invalid JSON' }, 400); }

    const code = body.code?.trim().toUpperCase();
    if (!code || !/^SS-[A-Z0-9]{4,8}$/.test(code)) {
      return cors({ error: 'Invalid tracking code format' }, 400);
    }

    // Mark the report with a deletion request flag
    if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
      try {
        // Check report exists
        const reports = await supabaseQuery('reports', `tracking_code=eq.${encodeURIComponent(code)}&select=id,school_id`);
        if (!reports || reports.length === 0) {
          return cors({ error: 'Report not found' }, 404);
        }

        const reportId = reports[0].id;
        const schoolId = reports[0].school_id;

        // Update status to indicate deletion requested
        await fetch(`${SUPABASE_URL}/rest/v1/reports?id=eq.${reportId}`, {
          method: 'PATCH',
          headers: {
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({
            status: 'withdrawal_requested',
            updated_at: new Date().toISOString()
          })
        });

        // Write audit log
        await fetch(`${SUPABASE_URL}/rest/v1/audit_logs`, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({
            school_id: schoolId,
            report_id: reportId,
            actor_type: 'user',
            action: 'gdpr_delete_request',
            message: `GDPR deletion requested for report ${code}`
          })
        });

        return cors({
          success: true,
          message: 'Deletion request recorded. Your data will be processed within 30 days as per GDPR requirements.'
        });
      } catch (e) {
        return cors({ error: 'Failed to process deletion request' }, 500);
      }
    }

    return cors({ error: 'Database not configured' }, 503);
  }

  return cors({ error: 'Not found' }, 404);
  } catch (err: any) {
    console.error('[api-gdpr] Unhandled error:', err);
    return cors({ error: 'Erreur interne du serveur', detail: err?.message }, 500);
  }
}

export const config: Config = {
  path: '/api/gdpr/*'
};
