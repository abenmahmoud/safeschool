import { getStore } from '@netlify/blobs';
import type { Context, Config } from '@netlify/functions';

// ── V8 Extra Pro — Environment-driven auth ──
const SUPERADMIN_EMAIL = Netlify.env.get('SUPERADMIN_EMAIL') || 'admin@safeschool.fr';
const SUPERADMIN_PASS = Netlify.env.get('SUPERADMIN_PASS') || 'SafeSchool2026!';

// Supabase config for statistics persistence
const SUPABASE_URL = Netlify.env.get('SUPABASE_URL') || '';
const SUPABASE_KEY = Netlify.env.get('SUPABASE_ANON_KEY') || '';

function cors(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, x-sa-token',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    }
  });
}

function authCheck(req: Request): boolean {
  const auth = req.headers.get('x-sa-token');
  if (!auth) return false;
  try {
    return atob(auth) === `${SUPERADMIN_EMAIL}:${SUPERADMIN_PASS}`;
  } catch { return false; }
}

// Supabase REST helper — saves stats to Supabase in parallel with Blobs
async function supaRest(table: string, method: string, body?: any, query?: string): Promise<any> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  const url = `${SUPABASE_URL}/rest/v1/${table}${query ? '?' + query : ''}`;
  const headers: Record<string, string> = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': method === 'POST' ? 'resolution=merge-duplicates,return=minimal' : 'return=minimal'
  };
  try {
    const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      console.warn(`Supabase ${method} ${table} failed:`, res.status, err);
      return null;
    }
    if (res.status === 204) return { ok: true };
    return res.json().catch(() => ({ ok: true }));
  } catch (e) {
    console.warn('Supabase request failed:', e);
    return null;
  }
}

// Find school UUID in Supabase by slug or establishment ID
async function findSchoolUUID(schoolId: string): Promise<string | null> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  try {
    // Try to find by slug first (most common case)
    const url = `${SUPABASE_URL}/rest/v1/schools?select=id&or=(slug.eq.${encodeURIComponent(schoolId)},id.eq.${encodeURIComponent(schoolId)})&limit=1`;
    const res = await fetch(url, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.length > 0) return data[0].id;
    }
  } catch (e) { console.warn('findSchoolUUID failed:', e); }
  return null;
}

export default async (req: Request, context: Context) => {
  if (req.method === 'OPTIONS') return cors({ ok: true });

  const url = new URL(req.url);
  const path = url.pathname.replace('/api/lea-stats', '');
  const store = getStore({ name: 'lea-stats', consistency: 'strong' });

  // POST /api/lea-stats — Push stats or alerts from client (anonymous but rate-limited)
  if (req.method === 'POST' && (path === '' || path === '/')) {
    try {
      const body = await req.json() as any;

      if (!body.schoolId || typeof body.schoolId !== 'string') {
        return cors({ error: 'schoolId is required' }, 400);
      }

      if (body.type === 'alert' && body.schoolId) {
        if (!body.cat || typeof body.cat !== 'string') {
          return cors({ error: 'alert requires cat field' }, 400);
        }
        // Store alert in Blobs
        const alertsKey = `alerts/${body.schoolId}`;
        const existing = await store.get(alertsKey, { type: 'json' }).catch(() => []) as any[] || [];
        const alertData = {
          cat: String(body.cat).slice(0, 100),
          severity: Math.min(Math.max(Number(body.severity) || 0, 0), 5),
          schoolName: String(body.schoolName || '').slice(0, 200),
          ts: body.ts || new Date().toISOString()
        };
        existing.push(alertData);
        // Keep last 200 alerts per school
        await store.setJSON(alertsKey, existing.slice(-200));

        // Also save to Supabase (non-blocking)
        const schoolUUID = await findSchoolUUID(body.schoolId);
        if (schoolUUID) {
          supaRest('lea_alerts', 'POST', {
            school_id: schoolUUID,
            category: alertData.cat,
            severity: alertData.severity,
            school_name: alertData.schoolName,
            alert_timestamp: alertData.ts
          }).catch(() => {});
        }

        return cors({ ok: true });
      }

      if (body.type === 'stats' && body.schoolId) {
        // Store aggregated stats in Blobs
        const statsPayload = {
          ...body.stats,
          lastUpdated: new Date().toISOString()
        };
        await store.setJSON(`stats/${body.schoolId}`, statsPayload);

        // Also save to Supabase (non-blocking, upsert by school_id)
        const schoolUUID = await findSchoolUUID(body.schoolId);
        if (schoolUUID) {
          supaRest('lea_statistics', 'POST', {
            school_id: schoolUUID,
            total_conversations: body.stats?.totalConversations || 0,
            total_messages: body.stats?.totalMessages || 0,
            categories: body.stats?.categories || {},
            severity_hits: body.stats?.severityHits || {},
            last_updated: new Date().toISOString()
          }, 'on_conflict=school_id').catch(() => {});
        }

        return cors({ ok: true });
      }

      return cors({ error: 'Invalid type' }, 400);
    } catch (e) {
      return cors({ error: 'Invalid request' }, 400);
    }
  }

  // GET endpoints require superadmin auth
  if (!authCheck(req)) return cors({ error: 'Non autorisé' }, 401);

  // GET /api/lea-stats/all — Get all school stats (superadmin)
  if (req.method === 'GET' && path === '/all') {
    const { blobs } = await store.list({ prefix: 'stats/' });
    const allStats: any[] = [];
    for (const blob of blobs) {
      const data = await store.get(blob.key, { type: 'json' });
      if (data) {
        const schoolId = blob.key.replace('stats/', '');
        allStats.push({ schoolId, ...data as any });
      }
    }
    return cors(allStats);
  }

  // GET /api/lea-stats/alerts — Get all alerts (superadmin)
  if (req.method === 'GET' && path === '/alerts') {
    const { blobs } = await store.list({ prefix: 'alerts/' });
    const allAlerts: any[] = [];
    for (const blob of blobs) {
      const data = await store.get(blob.key, { type: 'json' }) as any[];
      if (data) {
        const schoolId = blob.key.replace('alerts/', '');
        allAlerts.push({ schoolId, alerts: data });
      }
    }
    return cors(allAlerts);
  }

  // GET /api/lea-stats/school/:id — Get stats for specific school
  if (req.method === 'GET' && path.startsWith('/school/')) {
    const schoolId = path.replace('/school/', '');
    const stats = await store.get(`stats/${schoolId}`, { type: 'json' });
    const alerts = await store.get(`alerts/${schoolId}`, { type: 'json' }) as any[] || [];
    return cors({ stats: stats || {}, alerts });
  }

  // GET /api/lea-stats/report — Generate aggregated report (superadmin)
  if (req.method === 'GET' && path === '/report') {
    const { blobs: statBlobs } = await store.list({ prefix: 'stats/' });
    const { blobs: alertBlobs } = await store.list({ prefix: 'alerts/' });

    let totalConversations = 0, totalMessages = 0;
    const globalCategories: Record<string, number> = {};
    const globalSeverity: Record<string, number> = { '0': 0, '1': 0, '2': 0, '3': 0 };
    const schoolBreakdown: any[] = [];

    for (const blob of statBlobs) {
      const data = await store.get(blob.key, { type: 'json' }) as any;
      if (!data) continue;
      const schoolId = blob.key.replace('stats/', '');
      totalConversations += data.totalConversations || 0;
      totalMessages += data.totalMessages || 0;

      if (data.categories) {
        Object.entries(data.categories).forEach(([cat, count]) => {
          globalCategories[cat] = (globalCategories[cat] || 0) + (count as number);
        });
      }
      if (data.severityHits) {
        Object.entries(data.severityHits).forEach(([sev, count]) => {
          globalSeverity[sev] = (globalSeverity[sev] || 0) + (count as number);
        });
      }
      schoolBreakdown.push({ schoolId, ...data });
    }

    let totalAlerts = 0;
    for (const blob of alertBlobs) {
      const data = await store.get(blob.key, { type: 'json' }) as any[];
      if (data) totalAlerts += data.length;
    }

    return cors({
      totalConversations,
      totalMessages,
      totalAlerts,
      globalCategories,
      globalSeverity,
      schoolBreakdown,
      generatedAt: new Date().toISOString()
    });
  }

  return cors({ error: 'Not found' }, 404);
};

export const config: Config = {
  path: '/api/lea-stats/*'
};
