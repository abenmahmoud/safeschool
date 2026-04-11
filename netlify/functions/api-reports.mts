import { getStore } from '@netlify/blobs';
import type { Context, Config } from '@netlify/functions';
import crypto from 'node:crypto';

// Diagnostic: lire toutes les vars disponibles
const ALL_VARS = Object.keys(Netlify.env.toObject ? Netlify.env.toObject() : {});

const SUPABASE_URL = Netlify.env.get('SUPABASE_URL') || Netlify.env.get('aSUPABASE_URL') || '';
const SUPABASE_KEY = Netlify.env.get('SUPABASE_SERVICE_ROLE_KEY') || Netlify.env.get('aSUPABASE_SERVICE_ROLE_KEY') || Netlify.env.get('SUPABASE_ANON_KEY') || '';
const RESEND_API_KEY = Netlify.env.get('RESEND_API_KEY') || '';
const FROM_EMAIL = Netlify.env.get('NOTIFY_FROM_EMAIL') || 'notifications@safeschool.fr';

const _cache = new Map();
const TTL = 60000;
const fromCache = (k) => { const c = _cache.get(k); return c && Date.now() - c.ts < TTL ? c.data : null; };
const toCache = (k, d) => _cache.set(k, { data: d, ts: Date.now() });


function mapType(t) {
  const m = {
    'harcelement': 'autre', 'harcèlement': 'autre',
    'harcelement_physique': 'physique', 'physique': 'physique',
    'harcelement_verbal': 'verbal', 'verbal': 'verbal',
    'cyber': 'cyber', 'cyberharcelement': 'cyber', 'cyberharcèlement': 'cyber',
    'exclusion': 'exclusion', 'autre': 'autre'
  };
  return m[t] || 'autre';
}

function mapUrgence(u) {
  const m = { 'faible': 'faible', 'moyen': 'moyenne', 'moyenne': 'moyenne', 'eleve': 'haute', 'haute': 'haute', 'high': 'haute', 'medium': 'moyenne', 'low': 'faible' };
  return m[u] || 'moyenne';
}

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = 'SS-';
  for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

function cors(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-sa-token',
    },
  });
}

async function sbFetch(path, opts = {}) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('SB CONFIG MISSING - URL:', SUPABASE_URL ? 'ok' : 'EMPTY', '| KEY:', SUPABASE_KEY ? 'ok' : 'EMPTY', '| ALL_VARS:', ALL_VARS.join(','));
    return null;
  }
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...opts,
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(opts.headers || {}) },
    });
    if (!res.ok) { console.error('SB error:', res.status, await res.text().catch(() => '')); return null; }
    return res.json().catch(() => null);
  } catch(e) { console.error('SB fetch error:', e.message); return null; }
}

async function resolveSchool(slug) {
  const cacheKey = `school_slug:${slug}`;
  const cached = fromCache(cacheKey);
  if (cached) return cached;
  // Chercher dans Supabase en priorité
  const rows = await sbFetch(`schools?slug=eq.${encodeURIComponent(slug)}&select=id,name,slug,admin_email&limit=1`);
  if (rows && rows.length > 0) {
    const school = { id: rows[0].id, name: rows[0].name, slug: rows[0].slug, admin_email: rows[0].admin_email, supabase_id: rows[0].id };
    toCache(cacheKey, school);
    return school;
  }
  // Fallback Blobs
  try {
    const store = getStore({ name: 'establishments', consistency: 'strong' });
    const index = (await store.get('_index', { type: 'json' })) || [];
    const entry = index.find((e) => e.slug === slug && e.is_active);
    if (!entry) return null;
    const bdata = await store.get(`school_${entry.id}`, { type: 'json' });
    if (!bdata) return null;
    const school = { id: bdata.id, name: bdata.name, slug: bdata.slug, admin_email: bdata.admin_email, supabase_id: bdata.supabase_id || bdata.id };
    toCache(cacheKey, school);
    return school;
  } catch(e) { return null; }
}

export default async function handler(req, context) {
  if (req.method === 'OPTIONS') return cors({}, 200);
  const url = new URL(req.url);

  if (req.method === 'GET') {
    let code = url.searchParams.get('code');
    if (!code) return cors({ error: 'Code requis' }, 400);
    const codeClean = code.startsWith('SS-') ? code.substring(3) : code;
    const codeWithPrefix = code.startsWith('SS-') ? code : `SS-${code}`;
    const cached = fromCache(`report:${codeClean}`);
    if (cached) return cors({ report: cached });
    let rows = await sbFetch(`reports?tracking_code=eq.${encodeURIComponent(codeWithPrefix)}&select=id,tracking_code,status,type,urgence,created_at,updated_at,school_id`);
    if (!rows || rows.length === 0) {
      rows = await sbFetch(`reports?tracking_code=eq.${encodeURIComponent(codeClean)}&select=id,tracking_code,status,type,urgence,created_at,updated_at,school_id`);
    }
    if (!rows || rows.length === 0) return cors({ error: 'Signalement introuvable', debug: { url_ok: !!SUPABASE_URL, key_ok: !!SUPABASE_KEY } }, 404);
    toCache(`report:${codeClean}`, rows[0]);
    return cors({ report: rows[0] });
  }

  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch { return cors({ error: 'JSON invalide' }, 400); }
    const { school_id, slug, type, urgence, description, anonymous, email, phone } = body;
    if (!type || !description) return cors({ error: 'type et description requis' }, 400);

    let school = null;
    if (slug) {
      school = await resolveSchool(slug);
      if (!school) return cors({ error: `Etablissement introuvable` }, 404);
    }
    const sid = school?.supabase_id || school?.id || school_id;
    if (!sid) return cors({ error: 'school_id requis' }, 400);

    const tracking_code = genCode();
    console.log('INSERT attempt - URL:', SUPABASE_URL ? SUPABASE_URL.substring(0,30) : 'EMPTY', '| KEY:', SUPABASE_KEY ? 'present' : 'EMPTY');

    const inserted = await sbFetch('reports', {
      method: 'POST',
      body: JSON.stringify({ tracking_code, type: mapType(type), urgency: mapUrgence(urgence || 'moyen'), description, anonymous: anonymous !== false, reporter_email: anonymous !== false ? null : (email || null), status: 'nouveau', school_id: sid }),
    });

    if (!inserted || !inserted[0]) {
      console.warn('SB insert failed - using Blobs fallback');
      const store = getStore({ name: 'reports', consistency: 'strong' });
      await store.setJSON(`report_${tracking_code}`, { tracking_code, type, urgence, description, anonymous, school_id: sid, id: crypto.randomUUID(), created_at: new Date().toISOString() });
    }

    const report_id = inserted?.[0]?.id || tracking_code;

    context.waitUntil((async () => {
      try {
        if (school?.admin_email && RESEND_API_KEY) {
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: FROM_EMAIL, to: school.admin_email, subject: `Nouveau signalement - ${school?.name||''}`, html: `<p>Code: ${tracking_code}</p>` }),
          });
        }
      } catch(e) { console.error('notify error', e.message); }
    })());

    return cors({ success: true, tracking_code, report_id, message: 'Signalement enregistre.' }, 201);
  }

  return cors({ error: 'Methode non supportee' }, 405);
}

export const config = { path: ['/api/reports', '/api/reports/*'] };
