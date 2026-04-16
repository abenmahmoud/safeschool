import type { Context } from "@netlify/functions";

/**
 * SafeSchool - School Sync v2
 * 
 * Creates/syncs a school across:
 * 1. Supabase `schools` table (source of truth)
 * 2. Netlify domain_aliases (for subdomain routing)
 * 
 * Returns complete access info: public URL, admin URL, admin code, admin email
 */
export default async (req: Request, _ctx: Context) => {
  const cors = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-sa-token'
  };
  const ok = (d: object, s = 200) => new Response(JSON.stringify(d), { status: s, headers: cors });

  if (req.method === 'OPTIONS') return ok({});
  if (req.method !== 'POST') return ok({ error: 'Method not allowed' }, 405);

  // Superadmin auth
  const SA = btoa((Netlify.env.get('SUPERADMIN_EMAIL') || '') + ':' + (Netlify.env.get('SUPERADMIN_PASS') || ''));
  const auth = req.headers.get('x-sa-token') || '';
  if (auth !== SA) return ok({ error: 'Non autorise' }, 401);

  // Parse body
  let body: any = {};
  try { body = await req.json(); } catch { return ok({ error: 'Invalide' }, 400); }

  const name = (body.name || '').trim();
  const city = (body.city || '').trim();
  const postal_code = (body.postal_code || '').trim();
  const type = body.type || 'lycee';
  const plan = body.plan || 'standard';
  const sector = body.sector || 'public';
  const admin_email = (body.admin_email || '').trim();
  const admin_name = (body.admin_name || '').trim();

  if (!name || !city || !postal_code || !admin_email) {
    return ok({ error: 'Champs requis: name, city, postal_code, admin_email' }, 400);
  }

  // Generate slug: {type}-{nom}-{ville}-{cp}
  function clean(s: string): string {
    return s.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');
  }
  const cleanName = clean(name);
  const namePrefix = cleanName.split('-')[0];
  const parts: string[] = [];
  if (type && namePrefix !== type) parts.push(type);
  if (cleanName) parts.push(cleanName);
  if (city) parts.push(clean(city));
  if (postal_code) parts.push(clean(postal_code));
  const slug = (body.slug || parts.join('-')).replace(/-+/g, '-').slice(0, 63);

  // Generate admin_code if not provided (8 alphanumeric chars, uppercase, SS prefix)
  function genAdminCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = 'SS';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
  }
  const admin_code = body.admin_code || genAdminCode();

  const SU = Netlify.env.get('aSUPABASE_URL') || Netlify.env.get('SUPABASE_URL') || '';
  const SK = Netlify.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const NT = Netlify.env.get('NETLIFY_API_TOKEN') || '';
  const NS = Netlify.env.get('NETLIFY_SITE_ID') || '';

  const results: Record<string, any> = {};
  let school_id: string | null = null;

  // --- Step 1: Supabase INSERT (with UPSERT on slug to be idempotent) ---
  if (SU && SK) {
    // First check if slug already exists
    const checkR = await fetch(SU + '/rest/v1/schools?slug=eq.' + encodeURIComponent(slug) + '&select=id', {
      headers: { apikey: SK, Authorization: 'Bearer ' + SK }
    });
    const existing = await checkR.json();
    
    if (Array.isArray(existing) && existing.length > 0) {
      // Update existing
      school_id = existing[0].id;
      const upR = await fetch(SU + '/rest/v1/schools?id=eq.' + school_id, {
        method: 'PATCH',
        headers: { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify({
          name, city, postal_code, admin_code, admin_email, admin_name,
          type, plan_code: plan, sector, country_code: 'FR', is_active: true,
          updated_at: new Date().toISOString()
        })
      });
      results.supabase = upR.ok ? 'updated' : 'update_error: ' + (await upR.text()).substring(0, 100);
    } else {
      // Create new
      const r = await fetch(SU + '/rest/v1/schools', {
        method: 'POST',
        headers: { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify({
          name, slug, city, postal_code, admin_code, admin_email, admin_name,
          type, plan_code: plan, sector, country_code: 'FR', is_active: true
        })
      });
      const d = await r.json();
      if (r.ok && Array.isArray(d) && d[0]) {
        school_id = d[0].id;
        results.supabase = 'created';
      } else {
        results.supabase = 'create_error: ' + JSON.stringify(d).substring(0, 150);
      }
    }
  } else {
    results.supabase = 'missing_env';
  }

  // --- Step 2: Netlify domain_aliases (add subdomain) ---
  if (NT && NS) {
    const sub = slug + '.safeschool.fr';
    try {
      const si = await fetch('https://api.netlify.com/api/v1/sites/' + NS, {
        headers: { Authorization: 'Bearer ' + NT }
      }).then(r => r.json());
      const al: string[] = si.domain_aliases || [];
      if (!al.includes(sub)) {
        const pr2 = await fetch('https://api.netlify.com/api/v1/sites/' + NS, {
          method: 'PATCH',
          headers: { Authorization: 'Bearer ' + NT, 'Content-Type': 'application/json' },
          body: JSON.stringify({ domain_aliases: [...al, sub] })
        });
        results.netlify = pr2.ok ? 'added' : 'error: ' + (await pr2.text()).substring(0, 100);
      } else {
        results.netlify = 'exists';
      }
    } catch (e: any) {
      results.netlify = 'exception: ' + (e.message || 'unknown').substring(0, 80);
    }
  } else {
    results.netlify = 'missing_env';
  }

  // --- Final response with all access info ---
  return ok({
    ok: true,
    school_id,
    slug,
    name,
    city,
    postal_code,
    type,
    plan,
    admin_email,
    admin_code,
    access: {
      public_url: 'https://' + slug + '.safeschool.fr/',
      admin_login_url: 'https://app.safeschool.fr/admin/login.html?etab=' + slug,
      admin_dashboard_url: 'https://app.safeschool.fr/admin/dashboard.html?etab=' + slug,
      superadmin_impersonate: 'https://app.safeschool.fr/?school=' + slug + '&admin=1'
    },
    results
  });
};

export const config = { path: '/api/school-sync' };
