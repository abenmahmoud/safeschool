import type { Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

function cors(data: any, status = 200, req?: Request) {
  const origin = req?.headers.get("origin") || "*";
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, x-admin-code" } });
}

function genCode(): string {
  const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let r = "RPT-";
  for (let i = 0; i < 8; i++) r += c[Math.floor(Math.random() * c.length)];
  return r;
}

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") return cors({}, 200, req);
  const SUPABASE_URL = Netlify.env.get("SUPABASE_URL") || "";
  const SUPABASE_KEY = Netlify.env.get("SUPABASE_ANON_KEY") || Netlify.env.get("SUPABASE_KEY") || "";
  const url = new URL(req.url);
  const path = url.pathname.replace("/api/reports", "");
  const store = getStore("safeschool-data");

  if (req.method === "POST" && path.startsWith("/submit/")) {
    const slug = path.replace("/submit/", "").split("?")[0];
    if (!slug) return cors({ error: "Slug requis" }, 400, req);
    const indexAll = ((await store.get("_index", { type: "json" })) as any[]) || [];
    const entry = indexAll.find((e: any) => e.slug === slug);
    if (!entry?.id) return cors({ error: "Etablissement non trouve" }, 404, req);
    let body: any;
    try { body = await req.json(); } catch { return cors({ error: "Corps invalide" }, 400, req); }
    const code = genCode();
    const report = { school_id: entry.id, tracking_code: code, type: String(body.type || "autre").substring(0, 100), description: String(body.description || "").substring(0, 2000), location: String(body.location || "").substring(0, 500), urgency: String(body.urgency || "moyen").substring(0, 50), anonymous: body.anonymous !== false, reporter_role: String(body.reporter_role || "eleve").substring(0, 50), reporter_email: String(body.reporter_email || "").substring(0, 200), classe: String(body.classe || body.class_name || "").substring(0, 100), status: "nouveau", source_channel: "web", created_at: new Date().toISOString() };
    const res = await fetch(SUPABASE_URL + "/rest/v1/reports", { method: "POST", headers: { "Content-Type": "application/json", "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY, "Prefer": "return=representation" }, body: JSON.stringify(report) });
    if (!res.ok) { const err = await res.text(); return cors({ error: "DB error: " + err }, 500, req); }
    const data = await res.json();
    return cors({ ok: true, tracking_code: code, report_id: data[0]?.id }, 201, req);
  }

  if (req.method === "GET" && path.startsWith("/list/")) {
    const slug = path.replace("/list/", "").split("?")[0];
    const adminCode = req.headers.get("x-admin-code") || "";
    const indexAll = ((await store.get("_index", { type: "json" })) as any[]) || [];
    const entry = indexAll.find((e: any) => e.slug === slug);
    if (!entry?.id) return cors({ error: "Etablissement non trouve" }, 404, req);
    const schoolData = (await store.get("school_" + entry.id, { type: "json" })) as any;
    const isAdmin = schoolData && (adminCode === schoolData.admin_code || adminCode === schoolData.admin_password);
    const isSA = adminCode === "c3VwZXJhZG1pbkBzYWZlc2Nob29sLmZyOlNhZmVTY2hvb2wyMDI1IUAjU0E=";
    if (!isAdmin && !isSA) return cors({ error: "Non autorise" }, 401, req);
    const res = await fetch(SUPABASE_URL + "/rest/v1/reports?school_id=eq." + entry.id + "&order=created_at.desc&limit=200", { headers: { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY } });
    if (!res.ok) return cors({ error: "Erreur lecture" }, 500, req);
    const data = await res.json();
    return cors({ ok: true, reports: data, total: data.length }, 200, req);
  }

  if (req.method === "GET" && path.startsWith("/track/")) {
    const code = path.replace("/track/", "").split("?")[0].toUpperCase();
    const res = await fetch(SUPABASE_URL + "/rest/v1/reports?tracking_code=eq." + code + "&select=tracking_code,status,admin_reply,created_at,type", { headers: { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY } });
    const data = await res.json();
    if (!data?.length) return cors({ error: "Non trouve" }, 404, req);
    return cors({ ok: true, report: data[0] }, 200, req);
  }

  return cors({ error: "Route non trouvee" }, 404, req);
};

export const config = { path: "/api/reports/*" };
