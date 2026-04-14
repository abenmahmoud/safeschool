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

    if (req.method === 'POST' && path === '/ensure-uuid') { const _b = await req.json().catch(()=>({})); const _s = ((_b).slug||(_b).blob_id||'').toString().trim().toLowerCase(); if(!_s) return cors({error:'slug requis'},400,req); const _i=((await store.get('_index',{type:'json'})))||[]; const _e=_i.find(e=>e.slug===_s); if(_e?.id){store.setJSON('uuid_'+_s,{uuid:_e.id}).catch(()=>{}); return cors({uuid:_e.id,source:'blob_uuid'},200,req);} return cors({error:'Non trouve'},404,req);} catch (error: any) {
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
