import type { Context } from "@netlify/functions";
export default async (req: Request, _ctx: Context) => {
  const ok = (d: object, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, x-sa-token' } });
  if (req.method === 'OPTIONS') return ok({});
  if (req.method !== 'POST') return ok({ error: 'Method not allowed' }, 405);
  const SA = btoa((Netlify.env.get('SUPERADMIN_EMAIL') || '') + ':' + (Netlify.env.get('SUPERADMIN_PASS') || ''));
  const auth = req.headers.get('x-sa-token') || '';
  if (auth !== SA) return ok({ error: 'Non autorise' }, 401);
  let body: any = {};
  try { body = await req.json(); } catch { return ok({ error: 'Invalide' }, 400); }
  const { name, slug, city, postal_code, admin_code, admin_email, admin_name, type, plan, sector } = body;
  if (!name || !slug || !admin_code) return ok({ error: 'Champs requis' }, 400);
  const SU = Netlify.env.get('aSUPABASE_URL') || Netlify.env.get('SUPABASE_URL') || '';
  const SK = Netlify.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const NT = Netlify.env.get('NETLIFY_API_TOKEN') || '';
  const NS = Netlify.env.get('NETLIFY_SITE_ID') || '';
  const results: Record<string, string> = {};
  if (SU && SK) {
    const r = await fetch(SU + '/rest/v1/schools', { method: 'POST', headers: { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify({ name, slug, city: city || '', postal_code: postal_code || '', admin_code, admin_email: admin_email || '', admin_name: admin_name || '', is_active: true, type: type || 'lycee', plan_code: plan || 'standard', sector: sector || 'public', country_code: 'FR' }) });
    const d = await r.json();
    results.supabase = r.ok ? 'ok' : ('error: ' + JSON.stringify(d).substring(0, 80));
  }
  if (NT && NS) {
    const sub = slug + '.safeschool.fr';
    const si = await fetch('https://api.netlify.com/api/v1/sites/' + NS, { headers: { Authorization: 'Bearer ' + NT } }).then(r => r.json()).catch(() => ({}));
    const al: string[] = si.domain_aliases || [];
    if (!al.includes(sub)) {
      const pr2 = await fetch('https://api.netlify.com/api/v1/sites/' + NS, { method: 'PATCH', headers: { Authorization: 'Bearer ' + NT, 'Content-Type': 'application/json' }, body: JSON.stringify({ domain_aliases: [...al, sub] }) });
      results.netlify = pr2.ok ? 'ok' : 'error';
    } else { results.netlify = 'exists'; }
  }
  return ok({ ok: true, slug, results });
};
export const config = { path: '/api/school-sync' };