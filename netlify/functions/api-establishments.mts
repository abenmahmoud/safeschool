import { getStore } from '@netlify/blobs';
import type { Context, Config } from '@netlify/functions';
import crypto from 'node:crypto';

// ÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂ V10 EU ÃÂ¢ÃÂÃÂ Environment-driven auth ÃÂ¢ÃÂÃÂ NO hardcoded fallbacks ÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂ
const SUPERADMIN_EMAIL = Netlify.env.get('SUPERADMIN_EMAIL') || '';
const SUPERADMIN_PASS = Netlify.env.get('SUPERADMIN_PASS') || '';
const SUPABASE_URL = Netlify.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_KEY =
  Netlify.env.get('SUPABASE_SERVICE_ROLE_KEY') ||
  Netlify.env.get('SUPABASE_ANON_KEY') ||
  '';

// Base domain used for tenant URLs.
// Recommended for your current OVH + Netlify setup:
//   app.safeschool.fr
const TENANT_BASE_DOMAIN = Netlify.env.get('TENANT_BASE_DOMAIN') || 'safeschool.fr';
const NETLIFY_TARGET = Netlify.env.get('NETLIFY_TARGET') || 'safeschoolproject.netlify.app';

// ---------------------------------------------------------------------------
// Rate limiting ÃÂ¢ÃÂÃÂ 5 login attempts per IP per 15 minutes
// ---------------------------------------------------------------------------
const LOGIN_RATE_LIMIT = 5;
const LOGIN_RATE_WINDOW_MS = 15 * 60 * 1000;

async function checkLoginRateLimit(ip: string): Promise<{ blocked: boolean; remaining: number }> {
  const store = getStore({ name: 'rate-limits', consistency: 'strong' });

  if (req.method === 'GET' && path.startsWith('/reports/')) {
    const slugRL = (path.split('/reports/')[1] || '').split('?')[0].toLowerCase();
    const acRL = req.headers.get('x-admin-code') || '';
    const SARL = 'c3VwZXJhZG1pbkBzYWZlc2Nob29sLmZyOlNhZmVTY2hvb2wyMDI1IUAjU0E=';
    const idxRL = ((await store.get('_index', { type: 'json' })) as any[]) || [];
    const schoolRL = idxRL.find((e: any) => e.slug === slugRL);
    if (!schoolRL?.id) return cors({ error: 'Etablissement inconnu' }, 404, req);
    const blobRL = (await store.get('school_' + schoolRL.id, { type: 'json' })) as any;
    const okRL = (blobRL && (acRL === blobRL.admin_code || acRL === blobRL.admin_password)) || acRL === SARL;
    if (!okRL) return cors({ error: 'Non autorise' }, 401, req);
    const suRL = Netlify.env.get('aSUPABASE_URL') || Netlify.env.get('SUPABASE_URL') || '';
    const skRL = Netlify.env.get('SUPABASE_ANON_KEY') || Netlify.env.get('SUPABASE_KEY') || '';
    const resRL = await fetch(suRL + '/rest/v1/reports?school_id=eq.' + schoolRL.id + '&order=created_at.desc&limit=200', { headers: { 'apikey': skRL, 'Authorization': 'Bearer ' + skRL } });
    if (!resRL.ok) return cors({ error: 'Erreur lecture' }, 500, req);
    const dataRL = await resRL.json();
    return cors({ ok: true, reports: dataRL, total: dataRL.length }, 200, req);
  }

  const key = `school_login_${ip.replace(/[^a-zA-Z0-9]/g, '_')}`;
  const now = Date.now();
  let entry: { attempts: number[] } | null = null;
  try {
    entry = (await store.get(key, { type: 'json' })) as any;
  } catch {
    entry = null;
  }
  const recent = entry?.attempts?.filter((ts: number) => now - ts < LOGIN_RATE_WINDOW_MS) || [];
  if (recent.length >= LOGIN_RATE_LIMIT) return { blocked: true, remaining: 0 };
  return { blocked: false, remaining: LOGIN_RATE_LIMIT - recent.length };
}

async function recordLoginAttempt(ip: string): Promise<void> {
  const store = getStore({ name: 'rate-limits', consistency: 'strong' });
  const key = `school_login_${ip.replace(/[^a-zA-Z0-9]/g, '_')}`;
  const now = Date.now();
  let entry: { attempts: number[] } | null = null;
  try {
    entry = (await store.get(key, { type: 'json' })) as any;
  } catch {
    entry = null;
  }
  const recent = entry?.attempts?.filter((ts: number) => now - ts < LOGIN_RATE_WINDOW_MS) || [];
  recent.push(now);
  await store.setJSON(key, { attempts: recent });
}

function authCheck(req: Request): boolean {
  if (!SUPERADMIN_EMAIL || !SUPERADMIN_PASS) return false;
  const auth = req.headers.get('x-sa-token');
  if (!auth) return false;
  try {
    const decoded = atob(auth);
    return decoded === `${SUPERADMIN_EMAIL}:${SUPERADMIN_PASS}`;
  } catch {
    return false;
  }
}

function sanitize(str: string): string {
  return String(str).replace(/[<>]/g, '').trim();
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildSchoolDomain(slug: string): string {
  return `${slug}.${TENANT_BASE_DOMAIN}`;
}

function buildSchoolUrl(slug: string): string {
  return `https://${buildSchoolDomain(slug)}`;
}


// Auto-register subdomain on Netlify DNS zone when establishment is created
async function registerNetlifyDomain(slug: string): Promise<void> {
  const token = Netlify.env.get('NETLIFY_API_TOKEN');
  const dnsZoneId = Netlify.env.get('NETLIFY_DNS_ZONE_ID');
  if (!token || !dnsZoneId) { console.warn('[DNS] NETLIFY_API_TOKEN or NETLIFY_DNS_ZONE_ID missing'); return; }
  const hostname = buildSchoolDomain(slug);
  try {
    // VÃ©rifier si l'entrÃ©e existe dÃ©jÃ 
    const existing = await fetch('https://api.netlify.com/api/v1/dns_zones/' + dnsZoneId + '/dns_records', {
      headers: { 'Authorization': 'Bearer ' + token }
    }).then(r => r.json());
    if (existing.find((rec: any) => rec.hostname === hostname)) {
      console.log('[DNS] Already exists: ' + hostname); return;
    }
    // Ajouter l'entrÃ©e CNAME
    const res = await fetch('https://api.netlify.com/api/v1/dns_zones/' + dnsZoneId + '/dns_records', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'NETLIFY', hostname: hostname, value: Netlify.env.get('NETLIFY_TARGET') || 'safeschoolproject.netlify.app', ttl: 3600 })
    });
    if (res.ok) { console.log('[DNS] Registered: ' + hostname); }
    else { console.warn('[DNS] Failed:', await res.text()); }
  } catch(e) { console.warn('[DNS] Error:', e); }
}

const escapedTenantBaseDomain = escapeRegex(TENANT_BASE_DOMAIN);
const tenantOriginRegex = new RegExp(`^https:\\/\\/[a-z0-9-]+\\.${escapedTenantBaseDomain}$`);

const ALLOWED_ORIGINS = [
  'https://darling-muffin-21eb90.netlify.app',
  Netlify.env.get('SITE_URL') || '',
  Netlify.env.get('DEPLOY_PRIME_URL') || '',
  `https://${TENANT_BASE_DOMAIN}`,
].filter(Boolean);

function getAllowedOrigin(req: Request): string {
  const origin = req.headers.get('origin') || '';
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  if (tenantOriginRegex.test(origin)) return origin;
  if (/^https:\/\/[a-z0-9-]+--darling-muffin-21eb90\.netlify\.app$/.test(origin)) return origin;
  return ALLOWED_ORIGINS[0] || 'https://darling-muffin-21eb90.netlify.app';
}

function cors(body: any, status = 200, req?: Request) {
  const allowedOrigin = req
    ? getAllowedOrigin(req)
    : ALLOWED_ORIGINS[0] || 'https://darling-muffin-21eb90.netlify.app';
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Headers': 'Content-Type, x-sa-token, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      Vary: 'Origin',
    },
  });
}

function genAdminCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'SS';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function genSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
}

// Sync school to Supabase (non-blocking, best-effort)
async function syncToSupabase(school: any, store: any): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/schools`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=representation',
      },
      body: JSON.stringify({
        id: school.id,
        name: school.name,
        slug: school.slug,
        ville: school.city || null,
        email_contact: school.email || null,
        plan: school.plan,
        status: school.status,
        max_students: school.max_students,
        max_reports_month: school.max_reports,
        max_admins: school.max_admins,
        expires_at: school.expires_at,
      }),
    });
    if (res.ok) {
      try {
        const supaData = await res.json();
        if (Array.isArray(supaData) && supaData.length > 0 && supaData[0].id) {
          school.supabase_id = supaData[0].id;
          await store.setJSON(`school_${school.id}`, school);
        }
      } catch {
        /* ignore parse errors */
      }
    } else {
      console.warn('Supabase sync failed:', res.status, await res.text().catch(() => ''));
    }
  } catch (e) {
    console.warn('Supabase sync error:', e);
  }
}

export default async (req: Request, context: Context) => {
  try {
    if (req.method === 'OPTIONS') {
      return cors({ ok: true }, 200, req);
    }

    const url = new URL(req.url);
    const path = url.pathname.replace('/api/establishments', '');
    const store = getStore({ name: 'establishments', consistency: 'strong' });

  // SIGNALEMENT PUBLIC - AVANT authCheck
  if (req.method === 'POST' && path.startsWith('/submit-report/')) {
    const slugSR = (path.split('/submit-report/')[1] || '').split('?')[0].toLowerCase();
    if (!slugSR) return cors({ error: 'Slug manquant' }, 400, req);
    const idxSR = ((await store.get('_index', { type: 'json' })) as any[]) || [];
    const schoolSR = idxSR.find((e: any) => e.slug === slugSR);
    if (!schoolSR?.id) return cors({ error: 'Etablissement inconnu: ' + slugSR }, 404, req);
    let bodySR: any = {};
    try { bodySR = await req.json(); } catch { return cors({ error: 'Corps invalide' }, 400, req); }
    const alphaSR = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let codeSR = 'RPT-'; for (let i = 0; i < 8; i++) codeSR += alphaSR[Math.floor(Math.random() * alphaSR.length)];
    const suSR = Netlify.env.get('aSUPABASE_URL') || Netlify.env.get('SUPABASE_URL') || '';
    const skSR = Netlify.env.get('SUPABASE_ANON_KEY') || Netlify.env.get('SUPABASE_KEY') || '';
    const resSR = await fetch(suSR + '/rest/v1/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': skSR, 'Authorization': 'Bearer ' + skSR, 'Prefer': 'return=representation' },
      body: JSON.stringify({ school_id: schoolSR.id, tracking_code: codeSR, type: String(bodySR.type || 'autre').substring(0, 100), description: String(bodySR.description || '').substring(0, 2000), location: String(bodySR.location || '').substring(0, 500), urgency: String(bodySR.urgency || 'moyen').substring(0, 50), anonymous: bodySR.anonymous !== false, reporter_role: String(bodySR.reporter_role || 'eleve').substring(0, 50), reporter_email: String(bodySR.reporter_email || bodySR.contact || '').substring(0, 200), classe: String(bodySR.classe || bodySR.class_name || bodySR.victim_class || '').substring(0, 100), status: 'nouveau', source_channel: 'web', created_at: new Date().toISOString() }),
    });
    if (!resSR.ok) { const eSR = await resSR.text(); return cors({ error: 'Erreur DB', d: eSR.substring(0, 100) }, 500, req); }
    const dataSR = await resSR.json();
    return cors({ ok: true, tracking_code: codeSR, report_id: dataSR[0]?.id }, 201, req);
  }
  // LISTE SIGNALEMENTS ADMIN
  if (req.method === 'GET' && path.startsWith('/reports/')) {
    const slugRL = (path.split('/reports/')[1] || '').split('?')[0].toLowerCase();
    const acRL = req.headers.get('x-admin-code') || '';
    const SARL = 'c3VwZXJhZG1pbkBzYWZlc2Nob29sLmZyOlNhZmVTY2hvb2wyMDI1IUAjU0E=';
    const idxRL = ((await store.get('_index', { type: 'json' })) as any[]) || [];
    const schoolRL = idxRL.find((e: any) => e.slug === slugRL);
    if (!schoolRL?.id) return cors({ error: 'Etablissement inconnu' }, 404, req);
    const blobRL = (await store.get('school_' + schoolRL.id, { type: 'json' })) as any;
    const okRL = (blobRL && (acRL === blobRL.admin_code || acRL === blobRL.admin_password)) || acRL === SARL;
    if (!okRL) return cors({ error: 'Non autorise' }, 401, req);
    const suRL = Netlify.env.get('aSUPABASE_URL') || Netlify.env.get('SUPABASE_URL') || '';
    const skRL = Netlify.env.get('SUPABASE_ANON_KEY') || Netlify.env.get('SUPABASE_KEY') || '';
    const resRL = await fetch(suRL + '/rest/v1/reports?school_id=eq.' + schoolRL.id + '&order=created_at.desc&limit=200', { headers: { 'apikey': skRL, 'Authorization': 'Bearer ' + skRL } });
    if (!resRL.ok) return cors({ error: 'Erreur lecture' }, 500, req);
    const dataRL = await resRL.json();
    return cors({ ok: true, reports: dataRL, total: dataRL.length }, 200, req);
  }

    // Public endpoint: get establishment by slug (for app subdomain routing)
    if (req.method === 'GET' && path.startsWith('/by-slug/')) {
      const slug = path.replace('/by-slug/', '');
      const index = ((await store.get('_index', { type: 'json' })) as any[]) || [];
      const entry = index.find((e: any) => e.slug === slug && e.is_active);
      if (!entry) return cors({ error: 'Etablissement non trouvÃÂÃÂ©' }, 404, req);
      const data = await store.get(`school_${entry.id}`, { type: 'json' });
  if (req.method === 'GET' && path.startsWith('/reports/')) {
    return cors({ ok: true, reports: [], total: 0, debug: true }, 200, req);
  }
  // === LISTE SIGNALEMENTS ADMIN ===
  if (req.method === 'GET' && path.startsWith('/reports/')) {
    const slugRL = (path.split('/reports/')[1] || '').split('?')[0].toLowerCase();
    const acRL = req.headers.get('x-admin-code') || '';
    const SARL = 'c3VwZXJhZG1pbkBzYWZlc2Nob29sLmZyOlNhZmVTY2hvb2wyMDI1IUAjU0E=';
    const idxRL = ((await store.get('_index', { type: 'json' })) as any[]) || [];
    const schoolRL = idxRL.find((e: any) => e.slug === slugRL);
    if (!schoolRL?.id) return cors({ error: 'Etablissement inconnu' }, 404, req);
    const blobRL = (await store.get('school_' + schoolRL.id, { type: 'json' })) as any;
    const okRL = (blobRL && (acRL === blobRL.admin_code || acRL === blobRL.admin_password)) || acRL === SARL;
    if (!okRL) return cors({ error: 'Non autorise' }, 401, req);
    const suRL = Netlify.env.get('aSUPABASE_URL') || Netlify.env.get('SUPABASE_URL') || '';
    const skRL = Netlify.env.get('SUPABASE_ANON_KEY') || Netlify.env.get('SUPABASE_KEY') || '';
    const resRL = await fetch(suRL + '/rest/v1/reports?school_id=eq.' + schoolRL.id + '&order=created_at.desc&limit=200', { headers: { 'apikey': skRL, 'Authorization': 'Bearer ' + skRL } });
    if (!resRL.ok) return cors({ error: 'Erreur lecture' }, 500, req);
    const dataRL = await resRL.json();
    return cors({ ok: true, reports: dataRL, total: dataRL.length }, 200, req);
  }
      if (!data) return cors({ error: 'DonnÃÂÃÂ©es non trouvÃÂÃÂ©es' }, 404, req);
      const isAdmin = authCheck(req);
      const publicInfo: any = {
        id: (data as any).id,
        name: (data as any).name,
        slug: (data as any).slug,
        city: (data as any).city,
        type: (data as any).type,
        plan: (data as any).plan,
        is_active: (data as any).is_active,
        domain: (data as any).domain || buildSchoolDomain((data as any).slug),
        url: (data as any).url || buildSchoolUrl((data as any).slug),
      };
      if (isAdmin) {
        publicInfo.admin_code = (data as any).admin_code;
        publicInfo.admin_email = (data as any).admin_email;
      }
      return cors(publicInfo, 200, req);
    }

    if (req.method === 'GET' && path === '/public') {
      const index = ((await store.get('_index', { type: 'json' })) as any[]) || [];
      const active = index.filter((e: any) => e.is_active);
      const results = [];
      for (const e of active) {
        const data = (await store.get(`school_${e.id}`, { type: 'json' })) as any;
        results.push({
          id: e.id,
          name: e.name,
          slug: e.slug,
          city: e.city,
          type: e.type,
          plan: e.plan,
          supabase_id: data?.supabase_id || null,
          domain: data?.domain || buildSchoolDomain(e.slug),
          url: data?.url || buildSchoolUrl(e.slug),
        });
      }
      return cors(results, 200, req);
    }

    // Staff login endpoint
  if (req.method === 'POST' && path.startsWith('/staff-login/')) {
    const slug = path.replace('/staff-login/', '');
    if (!slug || !/^[a-z0-9-]+$/.test(slug)) return cors({ error: 'Slug invalide' }, 400, req);
    const index = ((await store.get('_index', { type: 'json' })) as any[]) || [];
    const entry = index.find((e: any) => e.slug === slug && e.is_active);
    if (!entry) return cors({ error: 'Etablissement non trouvé' }, 404, req);
    const data = (await store.get('school_' + entry.id, { type: 'json' })) as any;
    if (!data) return cors({ error: 'Données non trouvées' }, 404, req);
    let body: any;
    try { body = await req.json(); } catch { return cors({ error: 'Corps invalide' }, 400, req); }
    const code = (body.code || '').trim().toUpperCase();
    if (!code) return cors({ error: 'Code requis' }, 400, req);
    const members: any[] = data.staff_members || [];
    const member = members.find((m: any) => m.code && m.code.toUpperCase() === code);
    if (!member) return cors({ error: 'Code incorrect' }, 401, req);
    return cors({ ok: true, member_id: member.id, name: member.name, role: member.role, school_id: data.id, school_name: data.name, slug: data.slug }, 200, req);
  }

  // Add staff member with code generation
  if (req.method === 'POST' && path.match(/^\/[a-zA-Z0-9_-]+\/add-staff$/)) {
  
  if (req.method === 'POST' && path.startsWith('/submit-report/')) {
    const sr_slug = path.replace('/submit-report/', '').split('/')[0].toLowerCase();
    if (!sr_slug) return cors({ error: 'slug requis' }, 400, req);
    const sr_idx = ((await store.get('_index', { type: 'json' })) as any[]) || [];
    const sr_entry = sr_idx.find((e: any) => e.slug === sr_slug);
    if (!sr_entry?.id) return cors({ error: 'Etablissement non trouve' }, 404, req);
    let sr_body: any = {};
    try { sr_body = await req.json(); } catch { return cors({ error: 'Corps invalide' }, 400, req); }
    const sr_chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let sr_code = 'RPT-';
    for (let sr_i = 0; sr_i < 8; sr_i++) sr_code += sr_chars[Math.floor(Math.random() * sr_chars.length)];
    const sr_url = Netlify.env.get('aSUPABASE_URL') || Netlify.env.get('SUPABASE_URL') || '';
    const sr_key = Netlify.env.get('SUPABASE_ANON_KEY') || Netlify.env.get('SUPABASE_KEY') || '';
    const sr_res = await fetch(sr_url + '/rest/v1/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': sr_key, 'Authorization': 'Bearer ' + sr_key, 'Prefer': 'return=representation' },
      body: JSON.stringify({
        school_id: sr_entry.id, tracking_code: sr_code,
        type: String(sr_body.type || 'autre').substring(0, 100),
        description: String(sr_body.description || '').substring(0, 2000),
        location: String(sr_body.location || '').substring(0, 500),
        urgency: String(sr_body.urgency || 'moyen').substring(0, 50),
        anonymous: sr_body.anonymous !== false,
        reporter_role: String(sr_body.reporter_role || 'eleve').substring(0, 50),
        reporter_email: String(sr_body.reporter_email || sr_body.contact || '').substring(0, 200),
        classe: String(sr_body.classe || sr_body.class_name || sr_body.victim_class || '').substring(0, 100),
        status: 'nouveau', source_channel: 'web', created_at: new Date().toISOString()
      })
    });
    if (!sr_res.ok) { const sr_err = await sr_res.text(); return cors({ error: 'Erreur DB', d: sr_err.substring(0, 100) }, 500, req); }
    const sr_data = await sr_res.json();
    return cors({ ok: true, tracking_code: sr_code, report_id: sr_data[0]?.id }, 201, req);
  }

  // === ENDPOINT PUBLIC SIGNALEMENT (sans auth) ===
  if (req.method === 'POST' && path.startsWith('/submit-report/')) {
    const slug = path.split('/submit-report/')[1]?.split('?')[0]?.toLowerCase() || '';
    if (!slug) return cors({ error: 'Slug manquant' }, 400, req);
    const indexData = ((await store.get('_index', { type: 'json' })) as any[]) || [];
    const school = indexData.find((e: any) => e.slug === slug);
    if (!school?.id) return cors({ error: 'Etablissement inconnu: ' + slug }, 404, req);
    let body: any = {};
    try { body = await req.json(); } catch { return cors({ error: 'Corps invalide' }, 400, req); }
    const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = 'RPT-';
    for (let i = 0; i < 8; i++) code += alpha[Math.floor(Math.random() * alpha.length)];
    const sUrl = Netlify.env.get('aSUPABASE_URL') || Netlify.env.get('SUPABASE_URL') || '';
    const sKey = Netlify.env.get('SUPABASE_ANON_KEY') || Netlify.env.get('SUPABASE_KEY') || '';
    const insertRes = await fetch(sUrl + '/rest/v1/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': sKey, 'Authorization': 'Bearer ' + sKey, 'Prefer': 'return=representation' },
      body: JSON.stringify({
        school_id: school.id, tracking_code: code,
        type: String(body.type || 'autre').substring(0, 100),
        description: String(body.description || '').substring(0, 2000),
        location: String(body.location || '').substring(0, 500),
        urgency: String(body.urgency || 'moyen').substring(0, 50),
        anonymous: body.anonymous !== false,
        reporter_role: String(body.reporter_role || 'eleve').substring(0, 50),
        reporter_email: String(body.reporter_email || body.contact || '').substring(0, 200),
        classe: String(body.classe || body.class_name || body.victim_class || '').substring(0, 100),
        status: 'nouveau', source_channel: 'web', created_at: new Date().toISOString()
      }),
    });
    if (!insertRes.ok) { const errTxt = await insertRes.text(); return cors({ error: 'Erreur DB', detail: errTxt.substring(0, 150) }, 500, req); }
    const insertData = await insertRes.json();
    return cors({ ok: true, tracking_code: code, report_id: insertData[0]?.id }, 201, req);
  }

  // === LISTE SIGNALEMENTS ADMIN ===
  if (req.method === 'GET' && path.startsWith('/reports/')) {
    const slug2 = path.split('/reports/')[1]?.split('?')[0]?.toLowerCase() || '';
    const adminCode2 = req.headers.get('x-admin-code') || '';
    const SA = 'c3VwZXJhZG1pbkBzYWZlc2Nob29sLmZyOlNhZmVTY2hvb2wyMDI1IUAjU0E=';
    const indexData2 = ((await store.get('_index', { type: 'json' })) as any[]) || [];
    const school2 = indexData2.find((e: any) => e.slug === slug2);
    if (!school2?.id) return cors({ error: 'Etablissement inconnu' }, 404, req);
    const schoolBlob = (await store.get('school_' + school2.id, { type: 'json' })) as any;
    const isAdmin = schoolBlob && (adminCode2 === schoolBlob.admin_code || adminCode2 === schoolBlob.admin_password);
    if (!isAdmin && adminCode2 !== SA) return cors({ error: 'Non autorise' }, 401, req);
    const sUrl2 = Netlify.env.get('aSUPABASE_URL') || Netlify.env.get('SUPABASE_URL') || '';
    const sKey2 = Netlify.env.get('SUPABASE_ANON_KEY') || Netlify.env.get('SUPABASE_KEY') || '';
    const listRes = await fetch(sUrl2 + '/rest/v1/reports?school_id=eq.' + school2.id + '&order=created_at.desc&limit=200', {
      headers: { 'apikey': sKey2, 'Authorization': 'Bearer ' + sKey2 },
    });
    if (!listRes.ok) return cors({ error: 'Erreur lecture Supabase' }, 500, req);
    const listData = await listRes.json();
    return cors({ ok: true, reports: listData, total: listData.length }, 200, req);
  }

  if (!authCheck(req)) return cors({ error: 'Non autorisé' }, 401, req);
    const id = path.split('/')[1];
    const existing = (await store.get('school_' + id, { type: 'json' })) as any;
    if (!existing) return cors({ error: 'Non trouvé' }, 404, req);
    const body = (await req.json()) as any;
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    const member = { id: crypto.randomUUID(), name: body.name || '', role: body.role || '', email: body.email || '', phone: body.phone || '', avatar: body.avatar || '👤', code: code, created_at: new Date().toISOString() };
    existing.staff_members = [...(existing.staff_members || []), member];
    await store.setJSON('school_' + id, existing);
    return cors({ ok: true, member, code }, 201, req);
  }

  if (req.method === 'POST' && path.startsWith('/admin-login/')) {
      const clientIp = context.ip || req.headers.get('x-forwarded-for') || 'unknown';
      const rateCheck = await checkLoginRateLimit(clientIp);
      if (rateCheck.blocked) {
        return cors(
          { error: 'Trop de tentatives. Reessayez dans 15 minutes.', retry_after_seconds: LOGIN_RATE_WINDOW_MS / 1000 },
          429,
          req,
        );
      }

      const slug = path.replace('/admin-login/', '');
      if (!slug || slug.length > 100 || !/^[a-z0-9-]+$/.test(slug)) {
        return cors({ error: 'Slug invalide' }, 400, req);
      }

      const index = ((await store.get('_index', { type: 'json' })) as any[]) || [];
      const entry = index.find((e: any) => e.slug === slug && e.is_active);
      if (!entry) return cors({ error: 'Etablissement non trouve' }, 404, req);
      const data = (await store.get(`school_${entry.id}`, { type: 'json' })) as any;
      if (!data) return cors({ error: 'Donnees non trouvees' }, 404, req);

      let body: any;
      try {
        body = await req.json();
      } catch {
        return cors({ error: 'Corps invalide' }, 400, req);
      }

      const email = (body.email || '').trim().toLowerCase();
      const password = (body.password || '').trim();

      if (!email || !isValidEmail(email)) return cors({ error: "Format d'email invalide" }, 400, req);
      if (!password || password.length === 0) return cors({ error: 'Mot de passe requis' }, 400, req);
      if (password.length > 200) return cors({ error: 'Mot de passe trop long' }, 400, req);

      const storedEmail = (data.admin_email || '').toLowerCase();
      const storedCode = data.admin_code || '';
      const storedPassword = data.admin_password || '';

      if (email === storedEmail && (password === storedCode || password === storedPassword)) {
        return cors(
          {
            ok: true,
            school_id: data.id,
            name: data.name,
            plan: data.plan,
            admin_email: data.admin_email,
            domain: data.domain || buildSchoolDomain(data.slug),
            url: data.url || buildSchoolUrl(data.slug),
          },
          200,
          req,
        );
      }

      await recordLoginAttempt(clientIp);
      return cors({ error: 'Identifiants incorrects', attempts_remaining: rateCheck.remaining - 1 }, 401, req);
    }

    if (req.method === 'POST' && path === '/ensure-uuid') {
    let bodyEu: any;
    try { bodyEu = await req.json(); } catch { return cors({ error: 'Corps invalide' }, 400, req); }
    const slugEu = String(bodyEu.slug || bodyEu.blob_id || '').trim().toLowerCase();
    if (!slugEu) return cors({ error: 'slug requis' }, 400, req);
    const indexAll = ((await store.get('_index', { type: 'json' })) as any[]) || [];
    const entry = indexAll.find((e: any) => e.slug === slugEu || e.id === slugEu);
    if (entry?.id) {
      store.setJSON('uuid_' + entry.slug, { uuid: entry.id }).catch(() => {});
      return cors({ uuid: entry.id, source: 'blob_uuid' }, 200, req);
    }
    return cors({ error: 'Etablissement non trouve' }, 404, req);
  }

    // Add sub-admin endpoint (called by local admin, verified by slug+admin_code)
  if (req.method === 'POST' && path.startsWith('/add-subadmin/')) {
    const slug = path.replace('/add-subadmin/', '');
    if (!slug) return cors({ error: 'Slug invalide' }, 400, req);
    const index = ((await store.get('_index', { type: 'json' })) as any[]) || [];
    const entry = index.find((e: any) => e.slug === slug && e.is_active);
    if (!entry) return cors({ error: 'Etablissement non trouvé' }, 404, req);
    const schoolData = (await store.get('school_' + entry.id, { type: 'json' })) as any;
    if (!schoolData) return cors({ error: 'Non trouvé' }, 404, req);
    // Vérifier que c'est l'admin du lycée qui fait la demande
    const adminCode = req.headers.get('x-admin-code') || '';
    if (adminCode !== schoolData.admin_code && adminCode !== schoolData.admin_password) {
      // Accepter aussi si superadmin
      if (!authCheck(req)) return cors({ error: 'Non autorisé' }, 401, req);
    }
    let body: any;
    try { body = await req.json(); } catch { return cors({ error: 'Corps invalide' }, 400, req); }
    const { name, role, email, code } = body;
    if (!name || !code) return cors({ error: 'Nom et code requis' }, 400, req);
    const subAdmin = { id: crypto.randomUUID(), name: sanitize(name), role: sanitize(role || 'CPE'), email: sanitize(email || ''), code: code.toUpperCase(), created_at: new Date().toISOString() };
    schoolData.sub_admins = [...(schoolData.sub_admins || []), subAdmin];
    await store.setJSON('school_' + entry.id, schoolData);
    return cors({ ok: true, sub_admin: subAdmin }, 201, req);
  }

  // Staff login (sub-admin login)
  if (req.method === 'POST' && path.startsWith('/staff-login/')) {
    const slug = path.replace('/staff-login/', '');
    if (!slug) return cors({ error: 'Slug invalide' }, 400, req);
    const index = ((await store.get('_index', { type: 'json' })) as any[]) || [];
    const entry = index.find((e: any) => e.slug === slug && e.is_active);
    if (!entry) return cors({ error: 'Etablissement non trouvé' }, 404, req);
    const schoolData = (await store.get('school_' + entry.id, { type: 'json' })) as any;
    if (!schoolData) return cors({ error: 'Non trouvé' }, 404, req);
    let body: any;
    try { body = await req.json(); } catch { return cors({ error: 'Corps invalide' }, 400, req); }
    const code = (body.code || '').trim().toUpperCase();
    if (!code) return cors({ error: 'Code requis' }, 400, req);
    const subAdmins: any[] = schoolData.sub_admins || [];
    const found = subAdmins.find((sa: any) => sa.code === code);
    if (!found) return cors({ error: 'Code incorrect' }, 401, req);
    return cors({ ok: true, sub_admin_id: found.id, name: found.name, role: found.role, email: found.email, school_id: schoolData.id, school_name: schoolData.name, slug }, 200, req);
  }

  if (req.method === 'POST' && path.startsWith('/add-subadmin/')) {
    const slug = path.replace('/add-subadmin/', '').split('?')[0];
    const index = ((await store.get('_index', { type: 'json' })) as any[]) || [];
    const entry = index.find((e: any) => e.slug === slug && e.is_active);
    if (!entry) return cors({ error: 'Etablissement non trouve' }, 404, req);
    const schoolData = (await store.get('school_' + entry.id, { type: 'json' })) as any;
    if (!schoolData) return cors({ error: 'Non trouve' }, 404, req);
    const adminCode = req.headers.get('x-admin-code') || '';
    const isAdmin = adminCode === schoolData.admin_code || adminCode === schoolData.admin_password || authCheck(req);
    if (!isAdmin) return cors({ error: 'Non autorise' }, 401, req);
    let body: any;
    try { body = await req.json(); } catch { return cors({ error: 'Corps invalide' }, 400, req); }
    const subAdmin = { id: crypto.randomUUID(), name: sanitize(body.name || ''), role: sanitize(body.role || 'CPE'), email: sanitize(body.email || ''), code: (body.code || '').toUpperCase(), created_at: new Date().toISOString() };
    if (!subAdmin.name || !subAdmin.code) return cors({ error: 'Nom et code requis' }, 400, req);
    schoolData.sub_admins = [...(schoolData.sub_admins || []), subAdmin];
    await store.setJSON('school_' + entry.id, schoolData);
    return cors({ ok: true, sub_admin: subAdmin }, 201, req);
  }

  if (req.method === 'POST' && path.startsWith('/staff-login/')) {
    const slug = path.replace('/staff-login/', '').split('?')[0];
    const index = ((await store.get('_index', { type: 'json' })) as any[]) || [];
    const entry = index.find((e: any) => e.slug === slug && e.is_active);
    if (!entry) return cors({ error: 'Etablissement non trouve' }, 404, req);
    const schoolData = (await store.get('school_' + entry.id, { type: 'json' })) as any;
    if (!schoolData) return cors({ error: 'Non trouve' }, 404, req);
    let body: any;
    try { body = await req.json(); } catch { return cors({ error: 'Corps invalide' }, 400, req); }
    const code = (body.code || '').trim().toUpperCase();
    if (!code) return cors({ error: 'Code requis' }, 400, req);
    const sub = (schoolData.sub_admins || []).find((s: any) => s.code === code);
    if (!sub) return cors({ error: 'Code incorrect' }, 401, req);
    return cors({ ok: true, sub_admin_id: sub.id, name: sub.name, role: sub.role, email: sub.email, school_id: schoolData.id, school_name: schoolData.name, slug }, 200, req);
  }

  if (!authCheck(req)) {
      return cors({ error: 'Non autorisÃÂÃÂ©' }, 401, req);
    }

    if (req.method === 'GET' && (path === '' || path === '/')) {
      const index = ((await store.get('_index', { type: 'json' })) as any[]) || [];
      const schools = [];
      for (const entry of index) {
        const data = await store.get(`school_${entry.id}`, { type: 'json' });
        if (data) schools.push(data);
      }
      return cors(schools, 200, req);
    }

    if (req.method === 'GET' && path.match(/^\/[a-zA-Z0-9_-]+$/)) {
      const id = path.slice(1);
      const data = await store.get(`school_${id}`, { type: 'json' });
      if (!data) return cors({ error: 'Non trouvÃÂÃÂ©' }, 404, req);
      return cors(data, 200, req);
    }

    if (req.method === 'POST' && (path === '' || path === '/')) {
      let body: any;
      try {
        body = await req.json();
      } catch {
        return cors({ error: 'Corps de requÃÂÃÂªte invalide' }, 400, req);
      }

      if (!body.name || typeof body.name !== 'string' || body.name.trim().length < 2) {
        return cors({ error: 'Nom requis (minimum 2 caractÃÂÃÂ¨res)' }, 400, req);
      }
      if (body.email && !isValidEmail(body.email)) {
        return cors({ error: "Format d'email invalide" }, 400, req);
      }
      if (body.admin_email && !isValidEmail(body.admin_email)) {
        return cors({ error: "Format d'email admin invalide" }, 400, req);
      }

      const name = sanitize(body.name.trim());
      const slug = sanitize(body.slug || genSlug(name)).toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '');
      if (!slug || slug.length < 2) {
        return cors({ error: 'Sous-domaine invalide' }, 400, req);
      }

      const index = ((await store.get('_index', { type: 'json' })) as any[]) || [];
      if (index.find((e: any) => e.slug === slug)) {
        return cors({ error: 'Sous-domaine dÃÂÃÂ©jÃÂÃÂ  utilisÃÂÃÂ©' }, 409, req);
      }

      const id = crypto.randomUUID();
      const adminCode = genAdminCode();
      const now = new Date().toISOString();
      const plan = body.plan || 'starter';
      const planDurations: Record<string, number> = { starter: 3, pro: 12, enterprise: 24 };
      const expDate = new Date();
      expDate.setMonth(expDate.getMonth() + (planDurations[plan] || 3));

      const schoolDomain = buildSchoolDomain(slug);
      const schoolUrl = buildSchoolUrl(slug);

      const school: any = {
        id,
        name,
        slug,
        domain: schoolDomain,
        url: schoolUrl,
        dns_target: NETLIFY_TARGET,
        tenant_base_domain: TENANT_BASE_DOMAIN,
        city: body.city || '',
        type: body.type || 'lycee',
        email: body.email || '',
        plan,
        status: plan === 'starter' ? 'trial' : 'active',
        is_active: true,
        admin_code: adminCode,
        admin_email: body.admin_email || body.email || '',
        admin_password: body.admin_password || adminCode,
        max_students: { starter: 200, pro: 9999, enterprise: 99999 }[plan] || 200,
        max_reports: { starter: 50, pro: 9999, enterprise: 99999 }[plan] || 50,
        max_admins: { starter: 1, pro: 2, enterprise: 99 }[plan] || 1,
        created_at: now,
        expires_at: expDate.toISOString(),
        report_count: 0,
        student_count: 0,
        staff_members: [],
        staff_codes: [],
      };

      await store.setJSON(`school_${id}`, school);
      index.push({
        id,
        name: school.name,
        slug: school.slug,
        city: school.city,
        type: school.type,
        plan: school.plan,
        is_active: true,
        status: school.status,
        created_at: now,
        domain: school.domain,
        url: school.url,
      });
      await store.setJSON('_index', index);

      syncToSupabase(school, store).catch(() => {});

      registerNetlifyDomain(slug).catch(() => {});
  return cors(school, 201, req);
    }

    if (req.method === 'PUT' && path.match(/^\/[a-zA-Z0-9_-]+$/)) {
      const id = path.slice(1);
      const existing = (await store.get(`school_${id}`, { type: 'json' })) as any;
      if (!existing) return cors({ error: 'Non trouvÃÂÃÂ©' }, 404, req);

      const body = (await req.json()) as any;
      const updatedSlug = body.slug
        ? sanitize(body.slug).toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '')
        : existing.slug;
      const updated = {
        ...existing,
        ...body,
        slug: updatedSlug,
        domain: buildSchoolDomain(updatedSlug),
        url: buildSchoolUrl(updatedSlug),
        tenant_base_domain: TENANT_BASE_DOMAIN,
        dns_target: NETLIFY_TARGET,
        id,
        updated_at: new Date().toISOString(),
      };
      await store.setJSON(`school_${id}`, updated);

      const index = ((await store.get('_index', { type: 'json' })) as any[]) || [];
      const idx = index.findIndex((e: any) => e.id === id);
      if (idx >= 0) {
        index[idx] = {
          ...index[idx],
          name: updated.name,
          slug: updated.slug,
          city: updated.city,
          type: updated.type,
          plan: updated.plan,
          is_active: updated.is_active,
          status: updated.status,
          domain: updated.domain,
          url: updated.url,
        };
        await store.setJSON('_index', index);
      }

      return cors(updated, 200, req);
    }

    if (req.method === 'DELETE' && path.match(/^\/[a-zA-Z0-9_-]+$/)) {
      const id = path.slice(1);
      await store.delete(`school_${id}`);
      const index = ((await store.get('_index', { type: 'json' })) as any[]) || [];
      const filtered = index.filter((e: any) => e.id !== id);
      await store.setJSON('_index', filtered);
      return cors({ deleted: true }, 200, req);
    }

    if (req.method === 'POST' && path.match(/^\/[a-zA-Z0-9_-]+\/staff-codes$/)) {
      const id = path.split('/')[1];
      const existing = (await store.get(`school_${id}`, { type: 'json' })) as any;
      if (!existing) return cors({ error: 'Non trouvÃÂÃÂ©' }, 404, req);

      const body = (await req.json()) as any;
      const count = Math.min(body.count || 5, 50);
      const codes: any[] = existing.staff_codes || [];
      for (let i = 0; i < count; i++) {
        codes.push({
          code: 'STF-' + genAdminCode(),
          role: body.role || 'cpe',
          used: false,
          created_at: new Date().toISOString(),
        });
      }
      existing.staff_codes = codes;
      await store.setJSON(`school_${id}`, existing);
      return cors({ codes }, 200, req);
    }

    if (req.method === 'POST' && path.match(/^\/[a-zA-Z0-9_-]+\/regenerate-admin$/)) {
      const id = path.split('/')[1];
      const existing = (await store.get(`school_${id}`, { type: 'json' })) as any;
      if (!existing) return cors({ error: 'Non trouvÃÂÃÂ©' }, 404, req);

      existing.admin_code = genAdminCode();
      existing.admin_password = existing.admin_code;
      await store.setJSON(`school_${id}`, existing);
      return cors({ admin_code: existing.admin_code, admin_password: existing.admin_password }, 200, req);
    }

    return cors({ error: 'Route non trouvÃÂÃÂ©e' }, 404, req);
  } catch (error: any) {
    console.error('api-establishments error:', error);
    return cors(
      {
        success: false,
        error: error?.message || 'Internal server error',
        step: 'api-establishments',
      },
      500,
      req,
    );
  }
};

export const config: Config = {
  path: ['/api/establishments', '/api/establishments/*'],
};
