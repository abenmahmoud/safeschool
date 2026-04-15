export default async (req) => {
  const hdrs = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (req.method === 'OPTIONS') return new Response('{}', { status: 200, headers: hdrs });
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: hdrs });
  
  const SU = Netlify.env.get('aSUPABASE_URL') || Netlify.env.get('SUPABASE_URL') || '';
  const SK = Netlify.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const SECRET = Netlify.env.get('ADMIN_JWT_SECRET') || 'safeschool_jwt_secret_change_me';

  let body = {}; try { body = await req.json(); } catch { return new Response(JSON.stringify({ error: 'Corps invalide' }), { status: 400, headers: hdrs }); }
  const slug = String(body.slug || '').toLowerCase().trim();
  const admin_code = String(body.admin_code || '').trim();
  if (!slug || !admin_code) return new Response(JSON.stringify({ error: 'Slug et code requis' }), { status: 400, headers: hdrs });

  const resp = await fetch(SU + '/rest/v1/schools?slug=eq.' + encodeURIComponent(slug) + '&select=id,name,slug,is_active,admin_code,plan_code', {
    headers: { 'apikey': SK, 'Authorization': 'Bearer ' + SK }
  });
  const schools = await resp.json();
  if (!schools || !schools.length || !schools[0].is_active) return new Response(JSON.stringify({ error: 'Etablissement non trouve' }), { status: 404, headers: hdrs });
  const school = schools[0];
  if (!school.admin_code || admin_code !== school.admin_code) return new Response(JSON.stringify({ error: 'Code incorrect' }), { status: 401, headers: hdrs });

  // Générer JWT HS256
  const enc = (s) => btoa(s).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const jh = enc(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const jp = enc(JSON.stringify({ slug, school_id: school.id, school_name: school.name, plan: school.plan_code || 'standard', role: 'admin', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 86400 }));
  const jm = jh + '.' + jp;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(jm));
  const sigArr = Array.from(new Uint8Array(sig));
  const sigStr = sigArr.reduce((a, b) => a + String.fromCharCode(b), '');
  const token = jm + '.' + enc(sigStr);

  const cookieHdr = { ...hdrs, 'Set-Cookie': 'ss_admin_token=' + token + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400' };
  return new Response(JSON.stringify({ ok: true, token, school_name: school.name, role: 'admin' }), { status: 200, headers: cookieHdr });
};
export const config = { path: '/api/admin/login' };