export default async function handler() {
  const BASE = "https://app.safeschool.fr";
  const endpoints = ["/api/establishments/public", "/api/billing/plans", "/api/reports"];
  const results = await Promise.allSettled(
    endpoints.map(ep => fetch(BASE + ep, { signal: AbortSignal.timeout(4000) })
      .then(r => ({ ep, status: r.status }))
      .catch(e => ({ ep, error: e.message })))
  );
  console.log("[warmup]", new Date().toISOString(), JSON.stringify(results.map(r => r.value || r.reason)));
  return new Response(JSON.stringify({ warmed: results.length, ts: Date.now() }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
}
export const config = { schedule: "*/5 * * * *" };
