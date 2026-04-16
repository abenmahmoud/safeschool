import type { Context } from "@netlify/functions";

/**
 * SafeSchool - Public Schools API v1
 *
 * Source of truth: Supabase `schools` table (read via service_role for full visibility).
 * Exposes public routes that were previously served by api-establishments.mts
 * (which read from Netlify Blobs and was out of sync with Supabase).
 *
 * Routes:
 *   GET /api/establishments/by-slug/:slug  -> school details (public, no auth)
 *   GET /api/establishments/public         -> list of active schools (public)
 *
 * This function is registered with a more specific path prefix so Netlify
 * matches it BEFORE the legacy api-establishments catch-all.
 */
export default async (req: Request, _ctx: Context) => {
  const cors = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
  const ok = (d: object | any[], s = 200) => new Response(JSON.stringify(d), { status: s, headers: cors });

  if (req.method === 'OPTIONS') return ok({});
  if (req.method !== 'GET') return ok({ error: 'Method not allowed' }, 405);

  const SU = Netlify.env.get('aSUPABASE_URL') || Netlify.env.get('SUPABASE_URL') || '';
  const SK = Netlify.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!SU || !SK) return ok({ error: 'Config manquante' }, 500);

  const url = new URL(req.url);
  const path = url.pathname;

  // Route: /api/establishments/by-slug/:slug
  const bySlugMatch = path.match(/^\/api\/establishments\/by-slug\/([^\/\?]+)$/);
  if (bySlugMatch) {
    const slug = decodeURIComponent(bySlugMatch[1]);
    const r = await fetch(
      SU + '/rest/v1/schools?slug=eq.' + encodeURIComponent(slug) +
      '&is_active=eq.true&select=id,name,slug,city,postal_code,type,plan_code,admin_email,admin_name',
      { headers: { apikey: SK, Authorization: 'Bearer ' + SK } }
    );
    const data = await r.json();
    if (!r.ok) return ok({ error: 'Erreur base' }, 500);
    if (!Array.isArray(data) || data.length === 0) return ok({ error: 'Etablissement non trouve' }, 404);
    // Return public-safe fields (admin_email stays, needed for public "contact" links in page élève)
    const s = data[0];
    return ok({
      id: s.id,
      name: s.name,
      slug: s.slug,
      city: s.city,
      postal_code: s.postal_code,
      type: s.type,
      plan: s.plan_code,
      admin_email: s.admin_email,
      admin_name: s.admin_name || ''
    });
  }

  // Route: /api/establishments/public
  if (path === '/api/establishments/public' || path === '/api/establishments/public/') {
    const r = await fetch(
      SU + '/rest/v1/schools?is_active=eq.true&select=id,name,slug,city,postal_code,type&order=name.asc',
      { headers: { apikey: SK, Authorization: 'Bearer ' + SK } }
    );
    const data = await r.json();
    if (!r.ok) return ok([], 200); // return empty list on error rather than break the UI
    return ok(data);
  }

  return ok({ error: 'Route inconnue' }, 404);
};

// IMPORTANT: register specific paths BEFORE the legacy api-establishments catch-all.
// Netlify matches functions by specificity of path configuration.
export const config = {
  path: ['/api/establishments/by-slug/*', '/api/establishments/public']
};
