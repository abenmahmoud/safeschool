import { getStore } from '@netlify/blobs';
import type { Context, Config } from '@netlify/functions';

// ── V8 Extra Pro — Environment-driven auth ──
const SUPERADMIN_EMAIL = Netlify.env.get('SUPERADMIN_EMAIL') || 'admin@safeschool.fr';
const SUPERADMIN_PASS = Netlify.env.get('SUPERADMIN_PASS') || 'SafeSchool2026!';

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

function cors(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, x-sa-token',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS'
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

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

interface RateLimitEntry {
  attempts: number[];
}

async function checkRateLimit(ip: string): Promise<{ blocked: boolean; remaining: number }> {
  const store = getStore({ name: 'rate-limits', consistency: 'strong' });
  const key = `login_${ip.replace(/[^a-zA-Z0-9]/g, '_')}`;
  const now = Date.now();

  let entry: RateLimitEntry | null = null;
  try {
    entry = await store.get(key, { type: 'json' }) as RateLimitEntry | null;
  } catch {
    entry = null;
  }

  if (!entry) {
    return { blocked: false, remaining: RATE_LIMIT_MAX };
  }

  // Filter to only attempts within the window
  const recentAttempts = entry.attempts.filter(ts => now - ts < RATE_LIMIT_WINDOW_MS);

  if (recentAttempts.length >= RATE_LIMIT_MAX) {
    return { blocked: true, remaining: 0 };
  }

  return { blocked: false, remaining: RATE_LIMIT_MAX - recentAttempts.length };
}

async function recordFailedAttempt(ip: string): Promise<void> {
  const store = getStore({ name: 'rate-limits', consistency: 'strong' });
  const key = `login_${ip.replace(/[^a-zA-Z0-9]/g, '_')}`;
  const now = Date.now();

  let entry: RateLimitEntry | null = null;
  try {
    entry = await store.get(key, { type: 'json' }) as RateLimitEntry | null;
  } catch {
    entry = null;
  }

  const attempts = entry
    ? entry.attempts.filter(ts => now - ts < RATE_LIMIT_WINDOW_MS)
    : [];

  attempts.push(now);
  await store.setJSON(key, { attempts });
}

async function clearRateLimit(ip: string): Promise<void> {
  const store = getStore({ name: 'rate-limits', consistency: 'strong' });
  const key = `login_${ip.replace(/[^a-zA-Z0-9]/g, '_')}`;
  try {
    await store.delete(key);
  } catch {
    // Ignore deletion errors
  }
}

export default async (req: Request, context: Context) => {
  if (req.method === 'OPTIONS') return cors({ ok: true });

  const url = new URL(req.url);
  const path = url.pathname.replace('/api/superadmin', '');
  const clientIp = context.ip || req.headers.get('x-forwarded-for') || 'unknown';

  // ─── POST /api/superadmin/login ───
  if (req.method === 'POST' && path === '/login') {
    // Rate limit check
    const rateCheck = await checkRateLimit(clientIp);
    if (rateCheck.blocked) {
      return cors({
        error: 'Trop de tentatives. Réessayez dans 15 minutes.',
        retry_after_seconds: RATE_LIMIT_WINDOW_MS / 1000
      }, 429);
    }

    let body: any;
    try {
      body = await req.json();
    } catch {
      return cors({ error: 'Corps de requête invalide' }, 400);
    }

    // Input validation
    if (!body.email || typeof body.email !== 'string' || !isValidEmail(body.email)) {
      return cors({ error: 'Format d\'email invalide' }, 400);
    }
    if (!body.password || typeof body.password !== 'string' || body.password.length === 0) {
      return cors({ error: 'Mot de passe requis' }, 400);
    }

    if (body.email === SUPERADMIN_EMAIL && body.password === SUPERADMIN_PASS) {
      await clearRateLimit(clientIp);
      const token = btoa(`${SUPERADMIN_EMAIL}:${SUPERADMIN_PASS}`);
      return cors({ ok: true, token, email: SUPERADMIN_EMAIL });
    }

    await recordFailedAttempt(clientIp);
    const updated = await checkRateLimit(clientIp);
    return cors({
      error: 'Identifiants incorrects',
      attempts_remaining: updated.remaining
    }, 401);
  }

  // All routes below require authentication
  if (!authCheck(req)) return cors({ error: 'Non autorisé' }, 401);

  // ─── GET /api/superadmin/dashboard — Global stats ───
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
        // Enterprise is "sur devis" — custom pricing, not included in automatic MRR
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

  // ─── GET /api/superadmin/school/:id/reports — Access school reports ───
  if (req.method === 'GET' && path.match(/^\/school\/[a-zA-Z0-9_-]+\/reports$/)) {
    const id = path.split('/')[2];
    const store = getStore({ name: 'establishments', consistency: 'strong' });
    const data = await store.get(`school_${id}`, { type: 'json' }) as any;
    if (!data) return cors({ error: 'Non trouvé' }, 404);
    return cors({ school: data, supabase_school_id: data.supabase_id || data.id });
  }

  // ─── GET /api/superadmin/reports/latest — Latest auto-generated report ───
  if (req.method === 'GET' && path === '/reports/latest') {
    const store = getStore({ name: 'reports-generated', consistency: 'strong' });
    try {
      const latest = await store.get('_latest', { type: 'json' }) as any;
      if (!latest) {
        return cors({ error: 'Aucun rapport disponible' }, 404);
      }
      return cors({ report: latest });
    } catch {
      return cors({ error: 'Erreur lors de la récupération du rapport' }, 500);
    }
  }

  // ─── GET /api/superadmin/reports/list — List generated reports (last 30) ───
  if (req.method === 'GET' && path === '/reports/list') {
    const store = getStore({ name: 'reports-generated', consistency: 'strong' });
    try {
      const { blobs } = await store.list({ prefix: 'report_' });

      // Sort by key descending (newest first) and take last 30
      const sorted = blobs
        .sort((a, b) => b.key.localeCompare(a.key))
        .slice(0, 30);

      const reports = [];
      for (const blob of sorted) {
        const data = await store.get(blob.key, { type: 'json' }) as any;
        if (data) {
          reports.push({ key: blob.key, ...data });
        }
      }

      return cors({ count: reports.length, reports });
    } catch {
      return cors({ error: 'Erreur lors de la récupération des rapports' }, 500);
    }
  }

  // ─── GET /api/superadmin/activity — Recent platform activity log ───
  if (req.method === 'GET' && path === '/activity') {
    const store = getStore({ name: 'activity-log', consistency: 'strong' });
    try {
      const { blobs } = await store.list({ prefix: 'event_' });

      const sorted = blobs
        .sort((a, b) => b.key.localeCompare(a.key))
        .slice(0, 50);

      const events = [];
      for (const blob of sorted) {
        const data = await store.get(blob.key, { type: 'json' }) as any;
        if (data) {
          events.push({ key: blob.key, ...data });
        }
      }

      return cors({ count: events.length, events });
    } catch {
      return cors({ error: 'Erreur lors de la récupération de l\'activité' }, 500);
    }
  }

  // ─── POST /api/superadmin/activity — Log an activity event ───
  if (req.method === 'POST' && path === '/activity') {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return cors({ error: 'Corps de requête invalide' }, 400);
    }

    if (!body.type || typeof body.type !== 'string') {
      return cors({ error: 'Le champ "type" est requis' }, 400);
    }

    const store = getStore({ name: 'activity-log', consistency: 'strong' });
    const timestamp = new Date().toISOString();
    const key = `event_${timestamp.replace(/[:.]/g, '-')}_${Math.random().toString(36).slice(2, 8)}`;

    const event = {
      type: body.type,
      message: body.message || '',
      metadata: body.metadata || {},
      timestamp,
      ip: clientIp
    };

    await store.setJSON(key, event);
    return cors({ ok: true, key, event });
  }

  // ─── GET /api/superadmin/settings — Platform settings ───
  if (req.method === 'GET' && path === '/settings') {
    const store = getStore({ name: 'platform-settings', consistency: 'strong' });
    try {
      const settings = await store.get('current', { type: 'json' }) as any;
      return cors({ settings: settings || {} });
    } catch {
      return cors({ error: 'Erreur lors de la récupération des paramètres' }, 500);
    }
  }

  // ─── PUT /api/superadmin/settings — Update platform settings ───
  if (req.method === 'PUT' && path === '/settings') {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return cors({ error: 'Corps de requête invalide' }, 400);
    }

    if (!body || typeof body !== 'object') {
      return cors({ error: 'Les paramètres doivent être un objet' }, 400);
    }

    const store = getStore({ name: 'platform-settings', consistency: 'strong' });

    // Merge with existing settings
    let existing: any = {};
    try {
      existing = await store.get('current', { type: 'json' }) || {};
    } catch {
      existing = {};
    }

    const merged = { ...existing, ...body, updated_at: new Date().toISOString() };
    await store.setJSON('current', merged);

    return cors({ ok: true, settings: merged });
  }

  return cors({ error: 'Route non trouvée' }, 404);
};

export const config: Config = {
  path: '/api/superadmin/*'
};
