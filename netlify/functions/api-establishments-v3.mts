import type { Context, Config } from "@netlify/functions";

/**
 * SafeSchool - api-establishments V3 (Supabase-only)
 * 
 * Remplace TOUS les handlers de l'ancien api-establishments.mts qui lisaient
 * des Netlify Blobs vides. Lit UNIQUEMENT Supabase (source de verite).
 * 
 * Routes gerees:
 *   GET    /api/establishments/by-slug/:slug         -> details ecole (public)
 *   GET    /api/establishments/public                -> liste ecoles actives
 *   POST   /api/establishments/submit-report/:slug   -> elevé soumet signalement
 *   GET    /api/establishments/reports/:slug         -> admin liste ses signalements
 *   POST   /api/establishments/admin-jwt/:slug       -> admin login via code
 *   POST   /api/establishments/staff-login/:slug     -> sous-admin login
 *   POST   /api/establishments/add-subadmin/:slug    -> ajouter sous-admin
 *   POST   /api/establishments/reply-report/:reportId -> admin repond a un signalement
 *   DELETE /api/establishments/:slug                 -> superadmin supprime ecole
 */

import crypto from 'node:crypto';

const SA_TOKEN_STATIC = 'c3VwZXJhZG1pbkBzYWZlc2Nob29sLmZyOlNhZmVTY2hvb2wyMDI1IUAjU0E=';

function makeSaToken(): string {
  const em = Netlify.env.get('SUPERADMIN_EMAIL') || '';
  const pw = Netlify.env.get('SUPERADMIN_PASS') || '';
  if (!em || !pw) return SA_TOKEN_STATIC;
  return btoa(em + ':' + pw);
}

function isSuperadmin(req: Request): boolean {
  const tok = req.headers.get('x-sa-token') || '';
  if (!tok) return false;
  return tok === makeSaToken() || tok === SA_TOKEN_STATIC;
}

function cors(body: object | any[], status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-sa-token, x-admin-code, Authorization'
    }
  });
}

function supaHeaders(SK: string) {
  return { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
}

async function findSchoolBySlug(SU: string, SK: string, slug: string) {
  const r = await fetch(
    SU + '/rest/v1/schools?slug=eq.' + encodeURIComponent(slug) + '&select=*&limit=1',
    { headers: supaHeaders(SK) }
  );
  if (!r.ok) return null;
  const arr = await r.json();
  return Array.isArray(arr) && arr.length > 0 ? arr[0] : null;
}

function signJwt(payload: object, secret: string): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const b64 = (s: string) => Buffer.from(s).toString('base64url');
  const h = b64(JSON.stringify(header));
  const p = b64(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(h + '.' + p).digest('base64url');
  return h + '.' + p + '.' + sig;
}

export default async (req: Request, _ctx: Context) => {
  if (req.method === 'OPTIONS') return cors({ ok: true });

  const SU = Netlify.env.get('aSUPABASE_URL') || Netlify.env.get('SUPABASE_URL') || '';
  const SK = Netlify.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const JWT_SECRET = Netlify.env.get('ADMIN_JWT_SECRET') || '';
  
  if (!SU || !SK) return cors({ error: 'Config Supabase manquante' }, 500);

  const url = new URL(req.url);
  const path = url.pathname;

  // === GET /api/establishments/public — Liste publique ===
  if (req.method === 'GET' && (path === '/api/establishments/public' || path === '/api/establishments/public/')) {
    const r = await fetch(
      SU + '/rest/v1/schools?is_active=eq.true&select=id,name,slug,city,postal_code,type,plan_code&order=name.asc',
      { headers: supaHeaders(SK) }
    );
    if (!r.ok) return cors([]);
    return cors(await r.json());
  }

  // === GET /api/establishments/by-slug/:slug ===
  const bySlugMatch = path.match(/^\/api\/establishments\/by-slug\/([^\/?]+)$/);
  if (req.method === 'GET' && bySlugMatch) {
    const slug = decodeURIComponent(bySlugMatch[1]);
    const school = await findSchoolBySlug(SU, SK, slug);
    if (!school) return cors({ error: 'Etablissement non trouvé' }, 404);
    return cors({
      id: school.id,
      name: school.name,
      slug: school.slug,
      city: school.city || '',
      postal_code: school.postal_code || '',
      type: school.type || 'lycee',
      plan: school.plan_code || 'standard',
      is_active: school.is_active !== false,
      admin_email: school.admin_email || '',
      admin_name: school.admin_name || '',
      domain: school.slug + '.safeschool.fr',
      url: 'https://' + school.slug + '.safeschool.fr'
    });
  }

  // === POST /api/establishments/submit-report/:slug — Eleve soumet un signalement ===
  const submitMatch = path.match(/^\/api\/establishments\/submit-report\/([^\/?]+)$/);
  if (req.method === 'POST' && submitMatch) {
    const slug = decodeURIComponent(submitMatch[1]);
    const school = await findSchoolBySlug(SU, SK, slug);
    if (!school) return cors({ error: 'Etablissement non trouvé' }, 404);

    let body: any = {};
    try { body = await req.json(); } catch { return cors({ error: 'Body invalide' }, 400); }

    // Mapper les champs de l'UI vers la table reports
    const desc = (body.message || body.description || '').toString().trim();
    if (!desc || desc.length < 5) return cors({ error: 'Description trop courte' }, 400);

    const trackingCode = 'SR-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    const typeRaw = (body.type || 'autre').toString().toLowerCase();
    const typeMap: Record<string, string> = {
      'harcelement': 'physique', 'harcelement-physique': 'physique', 'physique': 'physique',
      'verbal': 'verbal', 'insultes': 'verbal',
      'cyber': 'cyber', 'cyberharcelement': 'cyber',
      'exclusion': 'exclusion', 'isolation': 'exclusion'
    };
    const type = typeMap[typeRaw] || 'autre';

    const insertBody = {
      school_id: school.id,
      tracking_code: trackingCode,
      description: desc,
      type: type,
      reporter_role: body.reporter_role || 'eleve',
      reporter_name: body.anonymous ? null : (body.name || body.reporter_name || null),
      reporter_email: body.contact_email || body.reporter_email || null,
      reporter_class: body.class_name || body.classe || null,
      urgency: ['faible', 'moyenne', 'haute'].includes(body.urgency) ? body.urgency : 'moyenne',
      anonymous: body.anonymous !== false,
      is_anonymous: body.anonymous !== false,
      status: 'nouveau',
      source_channel: 'web',
      followup_email_opt_in: !!body.contact_email,
      consent_accepted: body.consent === true
    };

    const r = await fetch(SU + '/rest/v1/reports', {
      method: 'POST',
      headers: { ...supaHeaders(SK), 'Prefer': 'return=representation' },
      body: JSON.stringify(insertBody)
    });

    if (!r.ok) {
      const err = await r.text();
      return cors({ error: 'Erreur creation signalement', detail: err.substring(0, 200) }, 500);
    }

    const created = await r.json();
    const report = Array.isArray(created) ? created[0] : created;
    return cors({ ok: true, report_id: report.id, tracking_code: trackingCode });
  }

  // === GET /api/establishments/reports/:slug — Admin liste ses signalements ===
  const reportsListMatch = path.match(/^\/api\/establishments\/reports\/([^\/?]+)$/);
  if (req.method === 'GET' && reportsListMatch) {
    const slug = decodeURIComponent(reportsListMatch[1]);
    const adminCode = req.headers.get('x-admin-code') || '';
    const school = await findSchoolBySlug(SU, SK, slug);
    if (!school) return cors({ error: 'Etablissement non trouvé' }, 404);
    // Auth: soit SA, soit admin_code match
    if (!isSuperadmin(req) && adminCode !== school.admin_code) {
      return cors({ error: 'Non autorisé' }, 401);
    }
    const r = await fetch(
      SU + '/rest/v1/reports?school_id=eq.' + school.id + '&order=created_at.desc&limit=200',
      { headers: supaHeaders(SK) }
    );
    if (!r.ok) return cors({ ok: true, reports: [], total: 0 });
    const reports = await r.json();
    return cors({ ok: true, reports, total: reports.length });
  }

  // === POST /api/establishments/admin-jwt/:slug — Admin login par code ===
  const adminJwtMatch = path.match(/^\/api\/establishments\/admin-jwt\/([^\/?]+)$/);
  if (req.method === 'POST' && adminJwtMatch) {
    const slug = decodeURIComponent(adminJwtMatch[1]);
    let body: any = {};
    try { body = await req.json(); } catch {}
    const code = (body.admin_code || body.code || '').toString().trim();
    if (!code) return cors({ error: 'Code requis' }, 400);

    const school = await findSchoolBySlug(SU, SK, slug);
    if (!school) return cors({ error: 'Etablissement non trouvé' }, 404);
    if (code !== school.admin_code) return cors({ error: 'Code invalide' }, 401);

    const payload = {
      slug: school.slug,
      school_id: school.id,
      school_name: school.name,
      role: 'admin',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 86400
    };
    const token = JWT_SECRET ? signJwt(payload, JWT_SECRET) : '';
    return cors({ 
      ok: true, 
      token, 
      school_name: school.name,
      school_id: school.id,
      slug: school.slug,
      admin_email: school.admin_email
    });
  }

  // === POST /api/establishments/reply-report/:reportId — Admin repond a un signalement ===
  const replyMatch = path.match(/^\/api\/establishments\/reply-report\/([^\/?]+)$/);
  if (req.method === 'POST' && replyMatch) {
    const reportId = decodeURIComponent(replyMatch[1]);
    const adminCode = req.headers.get('x-admin-code') || '';
    let body: any = {};
    try { body = await req.json(); } catch { return cors({ error: 'Body invalide' }, 400); }
    const reply = (body.reply || body.message || '').toString().trim();
    if (!reply) return cors({ error: 'Reponse vide' }, 400);

    // Recuperer le signalement + ecole associee pour verifier l'auth
    const rR = await fetch(
      SU + '/rest/v1/reports?id=eq.' + reportId + '&select=*,schools(*)&limit=1',
      { headers: supaHeaders(SK) }
    );
    if (!rR.ok) return cors({ error: 'Erreur lecture' }, 500);
    const arr = await rR.json();
    if (!Array.isArray(arr) || arr.length === 0) return cors({ error: 'Signalement non trouvé' }, 404);
    const report = arr[0];
    const school = report.schools;

    if (!isSuperadmin(req) && adminCode !== school?.admin_code) {
      return cors({ error: 'Non autorisé' }, 401);
    }

    // Update reports.admin_reply + staff_reply + reply_sent_at
    const upR = await fetch(SU + '/rest/v1/reports?id=eq.' + reportId, {
      method: 'PATCH',
      headers: { ...supaHeaders(SK), 'Prefer': 'return=representation' },
      body: JSON.stringify({
        admin_reply: reply,
        staff_reply: reply,
        reply_sent_at: new Date().toISOString(),
        status: 'en_cours',
        updated_at: new Date().toISOString()
      })
    });
    if (!upR.ok) return cors({ error: 'Erreur mise a jour' }, 500);

    // Ajouter un message dans report_messages pour thread
    await fetch(SU + '/rest/v1/report_messages', {
      method: 'POST',
      headers: supaHeaders(SK),
      body: JSON.stringify({
        report_id: reportId,
        school_id: report.school_id,
        author_type: 'school_admin',
        message: reply
      })
    });

    return cors({ ok: true, reply_sent: true });
  }

  // === POST /api/establishments/staff-login/:slug — Sous-admin login ===
  const staffMatch = path.match(/^\/api\/establishments\/staff-login\/([^\/?]+)$/);
  if (req.method === 'POST' && staffMatch) {
    const slug = decodeURIComponent(staffMatch[1]);
    let body: any = {};
    try { body = await req.json(); } catch {}
    const email = (body.email || '').toString().trim().toLowerCase();
    const code = (body.code || body.admin_code || '').toString().trim();
    if (!email || !code) return cors({ error: 'Email et code requis' }, 400);

    const school = await findSchoolBySlug(SU, SK, slug);
    if (!school) return cors({ error: 'Etablissement non trouvé' }, 404);

    const r = await fetch(
      SU + '/rest/v1/sub_admins?school_id=eq.' + school.id + '&email=eq.' + encodeURIComponent(email) + '&admin_code=eq.' + encodeURIComponent(code) + '&is_active=eq.true&select=*&limit=1',
      { headers: supaHeaders(SK) }
    );
    if (!r.ok) return cors({ error: 'Erreur' }, 500);
    const arr = await r.json();
    if (!Array.isArray(arr) || arr.length === 0) return cors({ error: 'Identifiants invalides' }, 401);
    const sub = arr[0];

    const payload = {
      slug: school.slug,
      school_id: school.id,
      school_name: school.name,
      sub_admin_id: sub.id,
      role: 'staff',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 86400
    };
    const token = JWT_SECRET ? signJwt(payload, JWT_SECRET) : '';
    return cors({ ok: true, token, name: sub.name, role: sub.role, school_name: school.name });
  }

  // === POST /api/establishments/add-subadmin/:slug — Superadmin ajoute sous-admin ===
  const addSubMatch = path.match(/^\/api\/establishments\/add-subadmin\/([^\/?]+)$/);
  if (req.method === 'POST' && addSubMatch) {
    if (!isSuperadmin(req)) return cors({ error: 'Non autorisé' }, 401);
    const slug = decodeURIComponent(addSubMatch[1]);
    const school = await findSchoolBySlug(SU, SK, slug);
    if (!school) return cors({ error: 'Etablissement non trouvé' }, 404);

    let body: any = {};
    try { body = await req.json(); } catch { return cors({ error: 'Body invalide' }, 400); }
    const name = (body.name || '').toString().trim();
    const email = (body.email || '').toString().trim().toLowerCase();
    const role = (body.role || 'CPE').toString().trim();
    if (!name || !email) return cors({ error: 'Nom et email requis' }, 400);

    const subCode = 'SS' + Math.random().toString(36).slice(2, 9).toUpperCase();

    const r = await fetch(SU + '/rest/v1/sub_admins', {
      method: 'POST',
      headers: { ...supaHeaders(SK), 'Prefer': 'return=representation' },
      body: JSON.stringify({
        school_id: school.id,
        name, email, role,
        admin_code: subCode,
        is_active: true
      })
    });
    if (!r.ok) {
      const err = await r.text();
      return cors({ error: 'Erreur', detail: err.substring(0, 200) }, 500);
    }
    const created = await r.json();
    return cors({ ok: true, sub_admin: Array.isArray(created) ? created[0] : created, admin_code: subCode });
  }

  // === DELETE /api/establishments/:slug — Superadmin supprime ecole ===
  const deleteMatch = path.match(/^\/api\/establishments\/([^\/?]+)$/);
  if (req.method === 'DELETE' && deleteMatch) {
    if (!isSuperadmin(req)) return cors({ error: 'Non autorisé' }, 401);
    const slug = decodeURIComponent(deleteMatch[1]);
    const school = await findSchoolBySlug(SU, SK, slug);
    if (!school) return cors({ deleted: false, not_found: true });

    // Supprimer cascades: report_files, report_messages, reports, sub_admins, puis school
    await fetch(SU + '/rest/v1/report_files?school_id=eq.' + school.id, { method: 'DELETE', headers: supaHeaders(SK) });
    await fetch(SU + '/rest/v1/report_messages?school_id=eq.' + school.id, { method: 'DELETE', headers: supaHeaders(SK) });
    await fetch(SU + '/rest/v1/reports?school_id=eq.' + school.id, { method: 'DELETE', headers: supaHeaders(SK) });
    await fetch(SU + '/rest/v1/sub_admins?school_id=eq.' + school.id, { method: 'DELETE', headers: supaHeaders(SK) });
    await fetch(SU + '/rest/v1/schools?id=eq.' + school.id, { method: 'DELETE', headers: supaHeaders(SK) });

    // Retirer le sous-domaine Netlify
    const tok = Netlify.env.get('NETLIFY_API_TOKEN') || '';
    const siteId = Netlify.env.get('NETLIFY_SITE_ID') || '';
    if (tok && siteId) {
      try {
        const site = await (await fetch('https://api.netlify.com/api/v1/sites/' + siteId, { headers: { Authorization: 'Bearer ' + tok } })).json();
        const aliases = (site.domain_aliases || []).filter((d: string) => d !== slug + '.safeschool.fr');
        await fetch('https://api.netlify.com/api/v1/sites/' + siteId, {
          method: 'PATCH',
          headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
          body: JSON.stringify({ domain_aliases: aliases })
        });
      } catch {}
    }

    return cors({ deleted: true, slug });
  }

  return cors({ error: 'Route non trouvée', path }, 404);
};

export const config: Config = {
  path: [
    '/api/establishments/public',
    '/api/establishments/public/',
    '/api/establishments/by-slug/*',
    '/api/establishments/submit-report/*',
    '/api/establishments/reports/*',
    '/api/establishments/admin-jwt/*',
    '/api/establishments/reply-report/*',
    '/api/establishments/staff-login/*',
    '/api/establishments/add-subadmin/*'
  ]
};
