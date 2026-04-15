export default async (req) => {
  try {
    const SU = Netlify.env.get('aSUPABASE_URL') || '';
    const SK = Netlify.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    let body = {}; try { body = await req.json(); } catch {}
    const slug = String(body.slug || 'lycee-test-2').toLowerCase().trim();
    const resp = await fetch(SU + '/rest/v1/schools?slug=eq.' + slug + '&select=id,name,admin_code,is_active', {
      headers: { 'apikey': SK, 'Authorization': 'Bearer ' + SK }
    });
    const data = await resp.json();
    return new Response(JSON.stringify({ ok: true, count: data.length, school: data[0]?.name, has_code: !!(data[0]?.admin_code) }), {
      status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  } catch(e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
export const config = { path: '/api/admin/login' };