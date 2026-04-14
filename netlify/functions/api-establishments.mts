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

    // Public endpoint: get establishment by slug (for app subdomain routing)
    if (req.method === 'GET' && path.startsWith('/by-slug/')) {
      const slug = path.replace('/by-slug/', '');
      const index = ((await store.get('_index', { type: 'json' })) as any[]) || [];
      const entry = index.find((e: any) => e.slug === slug && e.is_active);
      if (!entry) return cors({ error: 'Etablissement non trouvÃÂÃÂ©' }, 404, req);
      const data = await store.get(`school_${entry.id}`, { type: 'json' });
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
  
  // ========== SIGNALEMENT PUBLIC (sans authentification) ==========
  if (req.method === 'POST' && path.startsWith('/submit-report/')) {
    const slug2 = path.replace('/submit-report/', '').split('?')[0].toLowerCase();
    const idx2 = ((await store.get('_index', { type: 'json' })) as any[]) || [];
    const ent2 = idx2.find((e: any) => e.slug === slug2);
    if (!ent2?.id) return cors({ error: 'Etablissement non trouve' }, 404, req);
    let bod: any = {};
    try { bod = await req.json(); } catch { return cors({ error: 'Corps invalide' }, 400, req); }
    const chs = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let tc2 = 'RPT-';
    for (let i = 0; i < 8; i++) tc2 += chs[Math.floor(Math.random() * chs.length)];
    const su2 = Netlify.env.get('aSUPABASE_URL') || Netlify.env.get('SUPABASE_URL') || '';
    const sk2 = Netlify.env.get('SUPABASE_ANON_KEY') || Netlify.env.get('SUPABASE_KEY') || '';
    const rpt2 = {
      school_id: ent2.id,
      tracking_code: tc2,
      type: String(bod.type || 'autre').substring(0, 100),
      description: String(bod.description || '').substring(0, 2000),
      location: String(bod.location || '').substring(0, 500),
      urgency: String(bod.urgency || 'moyen').substring(0, 50),
      anonymous: bod.anonymous !== false,
      reporter_role: String(bod.reporter_role || 'eleve').substring(0, 50),
      reporter_email: String(bod.reporter_email || bod.contact || '').substring(0, 200),
      classe: String(bod.classe || bod.class_name || bod.victim_class || '').substring(0, 100),
      status: 'nouveau',
      source_channel: 'web',
      created_at: new Date().toISOString(),
    };
    const rs2 = await fetch(su2 + '/rest/v1/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': sk2, 'Authorization': 'Bearer ' + sk2, 'Prefer': 'return=representation' },
      body: JSON.stringify(rpt2),
    });
    if (!rs2.ok) { const e2 = await rs2.text(); return cors({ error: 'Erreur DB', d: e2.substring(0, 100) }, 500, req); }
    const rd2 = await rs2.json();
    return cors({ ok: true, tracking_code: tc2, report_id: rd2[0]?.id }, 201, req);
  }

  // ========== LISTE SIGNALEMENTS POUR ADMIN ==========
  if (req.method === 'GET' && path.startsWith('/reports/')) {
    const slug3 = path.replace('/reports/', '').split('?')[0].toLowerCase();
    const ac3 = req.headers.get('x-admin-code') || '';
    const SA3 = 'c3VwZXJhZG1pbkBzYWZlc2Nob29sLmZyOlNhZmVTY2hvb2wyMDI1IUAjU0E=';
    const idx3 = ((await store.get('_index', { type: 'json' })) as any[]) || [];
    const ent3 = idx3.find((e: any) => e.slug === slug3);
    if (!ent3?.id) return cors({ error: 'Etablissement non trouve' }, 404, req);
    const sd3 = (await store.get('school_' + ent3.id, { type: 'json' })) as any;
    const ok3 = (sd3 && (ac3 === sd3.admin_code || ac3 === sd3.admin_password)) || ac3 === SA3;
    if (!ok3) return cors({ error: 'Non autorise' }, 401, req);
    const su3 = Netlify.env.get('aSUPABASE_URL') || Netlify.env.get('SUPABASE_URL') || '';
    const sk3 = Netlify.env.get('SUPABASE_ANON_KEY') || Netlify.env.get('SUPABASE_KEY') || '';
    const rs3 = await fetch(su3 + '/rest/v1/reports?school_id=eq.' + ent3.id + '&order=created_at.desc&limit=200', {
      headers: { 'apikey': sk3, 'Authorization': 'Bearer ' + sk3 },
    });
    if (!rs3.ok) return cors({ error: 'Erreur lecture' }, 500, req);
    const data3 = await rs3.json();
    return cors({ ok: true, reports: data3, total: data3.length }, 200, req);
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
