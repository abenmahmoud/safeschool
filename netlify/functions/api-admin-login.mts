import type { Context, Config } from '@netlify/functions';
export default async (req: Request, _ctx: Context) => {
  const ok = (d: object, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });
  if (req.method === 'OPTIONS') return ok({});
  if (req.method !== 'POST') return ok({ error: 'Method not allowed' }, 405);
  let body: any = {};
  try { body = await req.json(); } catch { return ok({ error: 'Corps invalide' }, 400); }
  const email = (body.email || '').trim().toLowerCase();
  const code = (body.admin_code || body.code || '').trim().toUpperCase();
  if (!email || !code) return ok({ error: 'Email et code requis' }, 400);
  const SU = Netlify.env.get('aSUPABASE_URL') || Netlify.env.get('SUPABASE_URL') || '';
  const SK = Netlify.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!SU || !SK) return ok({ error: 'Config manquante' }, 500);
  const r = await fetch(SU + '/rest/v1/schools?admin_email=eq.' + encodeURIComponent(email) + '&admin_code=eq.' + encodeURIComponent(code) + '&is_active=eq.true&select=id,name,slug,admin_code,plan_code', {
    headers: { apikey: SK, Authorization: 'Bearer ' + SK }
  });
  const schools = await r.json();
  if (!Array.isArray(schools) || schools.length === 0) return ok({ error: 'Email ou code incorrect' }, 401);
  const sc = schools[0];
  const sec = Netlify.env.get('ADMIN_JWT_SECRET') || 'safeschool_change_me';
  const h = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const p = btoa(JSON.stringify({ slug: sc.slug, school_id: sc.id, school_name: sc.name, role: 'admin', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000) + 86400 })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const msg = h + '.' + p;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(sec), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  const tok = msg + '.' + btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return ok({ ok: true, token: tok, school_name: sc.name, slug: sc.slug, role: 'admin' });
};
export const config: Config = { path: ['/api/establishments/admin-jwt-by-email'] };