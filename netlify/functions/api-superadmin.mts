import { getStore } from '@netlify/blobs';
import type { Context, Config } from '@netlify/functions';
import {
  createSuperadminSessionToken,
  extractClientIp,
  isSuperadminRequest,
  jsonCors,
  safeJson,
  sanitizeText
} from './_lib/security.mts';

// ── V8 Extra Pro — Environment-driven auth ──
const SUPERADMIN_EMAIL = Netlify.env.get('SUPERADMIN_EMAIL') || '';
const SUPERADMIN_PASS = Netlify.env.get('SUPERADMIN_PASS') || '';

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

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
  if (req.method === 'OPTIONS') return jsonCors({ ok: true }, 200, req);

  const url = new URL(req.url);
  const path = url.pathname.replace('/api/superadmin', '');
  const clientIp = extractClientIp(req, context);

  // ─── POST /api/superadmin/login ───
  if (req.method === 'POST' && path === '/login') {
    // Rate limit check
    const rateCheck = await checkRateLimit(clientIp);
    if (rateCheck.blocked) {
      return jsonCors({
        error: 'Trop de tentatives. Réessayez dans 15 minutes.',
        retry_after_seconds: RATE_LIMIT_WINDOW_MS / 1000
      }, 429, req);
    }

    try {
      const body = await safeJson(req);
      const email = sanitizeText(body.email || '', 140).toLowerCase();
      const password = String(body.password || '');

      // Input validation
      if (!email || !isValidEmail(email)) {
        return jsonCors({ error: 'Format d\'email invalide' }, 400, req);
      }
      if (!password || password.length === 0) {
        return jsonCors({ error: 'Mot de passe requis' }, 400, req);
      }

      if (email === SUPERADMIN_EMAIL && password === SUPERADMIN_PASS) {
        await clearRateLimit(clientIp);
        const token = await createSuperadminSessionToken(SUPERADMIN_EMAIL);
        return jsonCors({ ok: true, token, email: SUPERADMIN_EMAIL, role: 'superadmin' }, 200, req);
      }

      await recordFailedAttempt(clientIp);
      const updated = await checkRateLimit(clientIp);
      return jsonCors({
        error: 'Identifiants incorrects',
        attempts_remaining: Math.max(updated.remaining, 0)
      }, 401, req);
    } catch {
      return jsonCors({ error: 'Corps de requête invalide' }, 400, req);
    }
  }

  // All routes below require authentication
  if (!(await isSuperadminRequest(req))) return jsonCors({ error: 'Non autorisé' }, 401, req);

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

    return jsonCors({
      total_schools: schools.length,
      active,
      trial,
      expired,
      mrr,
      arr: mrr * 12,
      total_reports: totalReports,
      schools
    }, 200, req);
  }

  // ─── GET /api/superadmin/school/:id/reports — Access school reports ───
  if (req.method === 'GET' && path.match(/^\/school\/[a-zA-Z0-9_-]+\/reports$/)) {
    const id = path.split('/')[2];
    const store = getStore({ name: 'establishments', consistency: 'strong' });
    const data = await store.get(`school_${id}`, { type: 'json' }) as any;
    if (!data) return jsonCors({ error: 'Non trouvé' }, 404, req);
    return jsonCors({ school: data, supabase_school_id: data.supabase_id || data.id }, 200, req);
  }

  // ─── GET /api/superadmin/reports/latest — Latest auto-generated report ───
  if (req.method === 'GET' && path === '/reports/latest') {
    const store = getStore({ name: 'reports-generated', consistency: 'strong' });
    try {
      const latest = await store.get('_latest', { type: 'json' }) as any;
      if (!latest) {
        return jsonCors({ error: 'Aucun rapport disponible' }, 404, req);
      }
      return jsonCors({ report: latest }, 200, req);
    } catch {
      return jsonCors({ error: 'Erreur lors de la récupération du rapport' }, 500, req);
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

      return jsonCors({ count: reports.length, reports }, 200, req);
    } catch {
      return jsonCors({ error: 'Erreur lors de la récupération des rapports' }, 500, req);
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

      return jsonCors({ count: events.length, events }, 200, req);
    } catch {
      return jsonCors({ error: 'Erreur lors de la récupération de l\'activité' }, 500, req);
    }
  }

  // ─── POST /api/superadmin/activity — Log an activity event ───
  if (req.method === 'POST' && path === '/activity') {
    try {
      const body = await safeJson(req);
      const eventType = sanitizeText(body.type, 80);
      if (!eventType) {
        return jsonCors({ error: 'Le champ "type" est requis' }, 400, req);
      }

      const store = getStore({ name: 'activity-log', consistency: 'strong' });
      const timestamp = new Date().toISOString();
      const key = `event_${timestamp.replace(/[:.]/g, '-')}_${Math.random().toString(36).slice(2, 8)}`;

      const event = {
        type: eventType,
        message: sanitizeText(body.message || '', 1000),
        metadata: (body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)) ? body.metadata : {},
        timestamp,
        ip: clientIp
      };

      await store.setJSON(key, event);
      return jsonCors({ ok: true, key, event }, 200, req);
    } catch {
      return jsonCors({ error: 'Corps de requête invalide' }, 400, req);
    }
  }

  // ─── GET /api/superadmin/settings — Platform settings ───
  if (req.method === 'GET' && path === '/settings') {
    const store = getStore({ name: 'platform-settings', consistency: 'strong' });
    try {
      const settings = await store.get('current', { type: 'json' }) as any;
      return jsonCors({ settings: settings || {} }, 200, req);
    } catch {
      return jsonCors({ error: 'Erreur lors de la récupération des paramètres' }, 500, req);
    }
  }

  // ─── PUT /api/superadmin/settings — Update platform settings ───
  if (req.method === 'PUT' && path === '/settings') {
    try {
      const body = await safeJson(req);
      if (!body || typeof body !== 'object') {
        return jsonCors({ error: 'Les paramètres doivent être un objet' }, 400, req);
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

      return jsonCors({ ok: true, settings: merged }, 200, req);
    } catch {
      return jsonCors({ error: 'Corps de requête invalide' }, 400, req);
    }
  }

  return jsonCors({ error: 'Route non trouvée' }, 404, req);
};

export const config: Config = {
  path: ['/api/superadmin', '/api/superadmin/*']
};
