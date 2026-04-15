export default async (req) => {
  try {
    const SU = Netlify.env.get('aSUPABASE_URL') || '';
    const SK = Netlify.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    return new Response(JSON.stringify({ ok: true, has_su: SU.length > 0, has_sk: SK.length > 0 }), {
      status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  } catch(e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
export const config = { path: '/api/admin/login' };