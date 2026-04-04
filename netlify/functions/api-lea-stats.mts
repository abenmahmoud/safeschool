import { getStore } from '@netlify/blobs';
import type { Context, Config } from '@netlify/functions';

const SUPERADMIN_EMAIL = 'am.ad.bm@gmail.com';
const SUPERADMIN_PASS = 'SafeSchool2026!';

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

export default async (req: Request, context: Context) => {
  if (req.method === 'OPTIONS') return cors({ ok: true });

  const url = new URL(req.url);
  const path = url.pathname.replace('/api/lea-stats', '');
  const store = getStore({ name: 'lea-stats', consistency: 'strong' });

  // POST /api/lea-stats — Push stats or alerts from client (no auth needed, data is anonymous)
  if (req.method === 'POST' && (path === '' || path === '/')) {
    try {
      const body = await req.json() as any;

      if (body.type === 'alert' && body.schoolId) {
        // Store alert
        const alertsKey = `alerts/${body.schoolId}`;
        const existing = await store.get(alertsKey, { type: 'json' }) as any[] || [];
        existing.push({
          cat: body.cat,
          severity: body.severity,
          schoolName: body.schoolName,
          ts: body.ts || new Date().toISOString()
        });
        // Keep last 200 alerts per school
        await store.setJSON(alertsKey, existing.slice(-200));
        return cors({ ok: true });
      }

      if (body.type === 'stats' && body.schoolId) {
        // Store aggregated stats for school
        await store.setJSON(`stats/${body.schoolId}`, {
          ...body.stats,
          lastUpdated: new Date().toISOString()
        });
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
