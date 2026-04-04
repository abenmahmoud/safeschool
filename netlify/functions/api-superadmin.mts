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
  const path = url.pathname.replace('/api/superadmin', '');

  // POST /api/superadmin/login
  if (req.method === 'POST' && path === '/login') {
    const body = await req.json() as any;
    if (body.email === SUPERADMIN_EMAIL && body.password === SUPERADMIN_PASS) {
      const token = btoa(`${SUPERADMIN_EMAIL}:${SUPERADMIN_PASS}`);
      return cors({ ok: true, token, email: SUPERADMIN_EMAIL });
    }
    return cors({ error: 'Identifiants incorrects' }, 401);
  }

  if (!authCheck(req)) return cors({ error: 'Non autorisé' }, 401);

  // GET /api/superadmin/dashboard - Global stats
  if (req.method === 'GET' && path === '/dashboard') {
    const store = getStore({ name: 'establishments', consistency: 'strong' });
    const index = await store.get('_index', { type: 'json' }) as any[] || [];

    let totalReports = 0;
    let mrr = 0;
    const schools = [];

    for (const entry of index) {
      const data = await store.get(`school_${entry.id}`, { type: 'json' }) as any;
      if (data) {
        schools.push(data);
        totalReports += data.report_count || 0;
        if (data.plan === 'pro' && data.status === 'active') mrr += 49;
        if (data.plan === 'enterprise' && data.status === 'active') mrr += 199;
      }
    }

    const active = schools.filter(s => s.status === 'active').length;
    const trial = schools.filter(s => s.status === 'trial').length;
    const expired = schools.filter(s => s.status === 'expired').length;

    return cors({
      total_schools: schools.length,
      active,
      trial,
      expired,
      mrr,
      arr: mrr * 12,
      total_reports: totalReports,
      schools
    });
  }

  // GET /api/superadmin/school/:id/reports - Access school reports (SAV)
  if (req.method === 'GET' && path.match(/^\/school\/[a-zA-Z0-9_-]+\/reports$/)) {
    const id = path.split('/')[2];
    // Return the school ID so the frontend can query Supabase with it
    const store = getStore({ name: 'establishments', consistency: 'strong' });
    const data = await store.get(`school_${id}`, { type: 'json' }) as any;
    if (!data) return cors({ error: 'Non trouvé' }, 404);
    return cors({ school: data, supabase_school_id: data.supabase_id || data.id });
  }

  return cors({ error: 'Route non trouvée' }, 404);
};

export const config: Config = {
  path: '/api/superadmin/*'
};
