export default async (req) => {
  return new Response(JSON.stringify({ ok: true, debug: true, method: req.method }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
};
export const config = { path: '/api/admin/login' };