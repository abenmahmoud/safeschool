import { getStore } from '@netlify/blobs';
import type { Context, Config } from '@netlify/functions';
import crypto from 'node:crypto';

const SUPABASE_URL = Netlify.env.get('SUPABASE_URL') || '';
const SUPABASE_KEY = Netlify.env.get('SUPABASE_SERVICE_ROLE_KEY') || Netlify.env.get('SUPABASE_ANON_KEY') || '';
const RESEND_API_KEY = Netlify.env.get('RESEND_API_KEY') || '';
const FROM_EMAIL = Netlify.env.get('NOTIFY_FROM_EMAIL') || 'notifications@safeschool.fr';
const SUPERADMIN_EMAIL = Netlify.env.get('SUPERADMIN_EMAIL') || '';
const SUPERADMIN_PASS = Netlify.env.get('SUPERADMIN_PASS') || '';

// Cache mémoire 60s pour slugs et signalements
const _cache = new Map<string, { data: any; ts: number }>();
const TTL = 60_000;
const fromCache = (k: string) => { const c = _cache.get(k); return c && Date.now() - c.ts < TTL ? c.data : null; };
const toCache = (k: string, d: any) => _cache.set(k, { data: d, ts: Date.now() });

function genCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = 'SS-';
  for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

function authCheck(req: Request): boolean {
  if (!SUPERADMIN_EMAIL || !SUPERADMIN_PASS) return false;
  const auth = req.headers.get('x-sa-token');
  if (!auth) return false;
  try { return atob(auth) === `${SUPERADMIN_EMAIL}:${SUPERADMIN_PASS}`; } catch { return false; }
}

function cors(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-sa-token',
    },
  });
}

// Appel Supabase REST direct (sans SDK)
async function sbFetch(path: string, opts: RequestInit = {}) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) { console.error('Supabase error:', res.status, await res.text().catch(() => '')); return null; }
  return res.json().catch(() => null);
}

// Résoudre school_id depuis Blobs via slug
async function resolveSchool(slug: string) {
  const cacheKey = `school_slug:${slug}`;
  let cached = fromCache(cacheKey);
  if (cached) return cached;
  
  const store = getStore({ name: 'establishments', consistency: 'strong' });
  const index = ((await store.get('_index', { type: 'json' })) as any[]) || [];
  const entry = index.find((e: any) => e.slug === slug && e.is_active);
  if (!entry) return null;
  
  const data = await store.get(`school_${entry.id}`, { type: 'json' }) as any;
  if (!data) return null;
  
  const school = { id: data.id, name: data.name, slug: data.slug, admin_email: data.admin_email, supabase_id: data.supabase_id };
  toCache(cacheKey, school);
  return school;
}

export default async function handler(req: Request, context: Context) {
  if (req.method === 'OPTIONS') return cors({}, 200);

  const url = new URL(req.url);

  // GET /api/reports?code=SS-XXXXXX — suivi signalement
  if (req.method === 'GET') {
    const code = url.searchParams.get('code');
    if (!code) return cors({ error: 'Code requis' }, 400);

    const cached = fromCache(`report:${code}`);
    if (cached) return cors({ report: cached });

    // Chercher dans Supabase
    const rows = await sbFetch(`reports?tracking_code=eq.${encodeURIComponent(code)}&select=id,tracking_code,status,type,urgence,created_at,updated_at,school_id`);
    if (!rows || rows.length === 0) return cors({ error: 'Signalement introuvable' }, 404);
    toCache(`report:${code}`, rows[0]);
    return cors({ report: rows[0] });
  }

  // POST /api/reports — soumettre signalement
  if (req.method === 'POST') {
    let body: any;
    try { body = await req.json(); } catch { return cors({ error: 'JSON invalide' }, 400); }

    const { school_id, slug, type, urgence, description, anonymous, email, phone } = body;
    if (!type || !description) return cors({ error: 'type et description requis' }, 400);

    // Résoudre l'établissement
    let school: any = null;
    if (slug) {
      school = await resolveSchool(slug);
      if (!school) return cors({ error: `Etablissement "${slug}" introuvable` }, 404);
    }

    const sid = school?.supabase_id || school?.id || school_id;
    if (!sid) return cors({ error: 'school_id requis' }, 400);

    const tracking_code = genCode();
    const reportData = {
      tracking_code,
      type,
      urgence: urgence || 'moyen',
      description,
      anonymous: anonymous !== false,
      reporter_email: anonymous !== false ? null : (email || null),
      reporter_phone: anonymous !== false ? null : (phone || null),
      status: 'nouveau',
      school_id: sid,
    };

    // Insérer en Supabase via REST
    const inserted = await sbFetch('reports', {
      method: 'POST',
      body: JSON.stringify(reportData),
    });

    if (!inserted || !inserted[0]) {
      // Fallback Blobs si Supabase indisponible
      console.warn('Supabase insert failed, using Blobs fallback');
      const store = getStore({ name: 'reports', consistency: 'strong' });
      const report = { ...reportData, id: crypto.randomUUID(), created_at: new Date().toISOString() };
      await store.setJSON(`report_${tracking_code}`, report);
    }

    const report_id = inserted?.[0]?.id || tracking_code;

    // Notifications en background
    context.waitUntil((async () => {
      try {
        const adminEmail = school?.admin_email;
        if (adminEmail && RESEND_API_KEY) {
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: FROM_EMAIL,
              to: adminEmail,
              subject: `Nouveau signalement [${(urgence || 'moyen').toUpperCase()}] - ${school?.name || 'Etablissement'}`,
              html: `<div style="font-family:sans-serif;max-width:600px"><div style="background:#dc2626;color:white;padding:20px;border-radius:8px 8px 0 0"><h2 style="margin:0">Nouveau signalement</h2><p>Code : <strong>${tracking_code}</strong></p></div><div style="padding:20px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:0 0 8px 8px"><p><b>Type :</b> ${type}</p><p><b>Urgence :</b> ${urgence || 'moyen'}</p><p><b>Description :</b> ${description.substring(0, 400)}</p><p style="text-align:center;margin-top:20px"><a href="https://app.safeschool.fr/admin?code=${tracking_code}" style="background:#dc2626;color:white;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:bold">Voir le signalement</a></p></div></div>`,
            }),
          });
        }
        if (anonymous === false && email && RESEND_API_KEY) {
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: FROM_EMAIL,
              to: email,
              subject: `Signalement recu - Code ${tracking_code}`,
              html: `<div style="font-family:sans-serif;max-width:600px"><div style="background:#2563eb;color:white;padding:20px;border-radius:8px 8px 0 0"><h2 style="margin:0">Signalement recu</h2></div><div style="padding:20px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:0 0 8px 8px"><p>Votre signalement a ete transmis.</p><p><b>Code de suivi : <span style="color:#dc2626;font-size:1.3em;letter-spacing:3px">${tracking_code}</span></b></p><p style="text-align:center;margin-top:20px"><a href="https://app.safeschool.fr?code=${tracking_code}" style="background:#2563eb;color:white;padding:12px 28px;border-radius:6px;text-decoration:none">Suivre mon dossier</a></p></div></div>`,
            }),
          });
        }
      } catch (e) { console.error('notify error', e); }
    })());

    return cors({
      success: true,
      tracking_code,
      report_id,
      message: anonymous !== false ? 'Signalement enregistre. Notez votre code.' : 'Email de confirmation envoye.',
    }, 201);
  }

  return cors({ error: 'Methode non supportee' }, 405);
}

export const config: Config = {
  path: ['/api/reports', '/api/reports/*'],
};
