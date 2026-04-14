import type { Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = Netlify.env.get("SUPABASE_URL") || "";
const SUPABASE_KEY = Netlify.env.get("SUPABASE_KEY") || "";
const SA_TOKEN = Netlify.env.get("SA_TOKEN") || "c3VwZXJhZG1pbkBzYWZlc2Nob29sLmZyOlNhZmVTY2hvb2wyMDI1IUAjU0E=";

function cors(data: any, status = 200, req?: Request) {
  const origin = req?.headers.get("origin") || "*";
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-sa-token, x-admin-code, x-admin-slug",
    },
  });
}

async function getSchoolId(slug: string, store: any): Promise<string | null> {
  const index = ((await store.get("_index", { type: "json" })) as any[]) || [];
  const entry = index.find((e: any) => e.slug === slug);
  return entry?.id || null;
}

function generateCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "RPT-";
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function sanitize(s: string): string {
  return String(s || "").replace(/<[^>]*>/g, "").substring(0, 2000);
}

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") return cors({}, 200, req);

  const url = new URL(req.url);
  const path = url.pathname.replace("/api/reports", "") || "/";
  const store = getStore("safeschool-data");

  // POST /api/reports/submit/:slug - Soumettre un signalement
  if (req.method === "POST" && path.startsWith("/submit/")) {
    const slug = path.replace("/submit/", "").split("?")[0];
    if (!slug) return cors({ error: "Slug requis" }, 400, req);

    const schoolId = await getSchoolId(slug, store);
    if (!schoolId) return cors({ error: "Etablissement non trouve" }, 404, req);

    let body: any;
    try { body = await req.json(); } catch { return cors({ error: "Corps invalide" }, 400, req); }

    const trackingCode = generateCode();
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    const report = {
      school_id: schoolId,
      tracking_code: trackingCode,
      type: sanitize(body.type || body.report_type || "autre"),
      description: sanitize(body.description || ""),
      location: sanitize(body.location || ""),
      urgency: sanitize(body.urgency || "moyen"),
      anonymous: body.anonymous !== false,
      reporter_role: sanitize(body.reporter_role || "eleve"),
      reporter_email: sanitize(body.reporter_email || body.contact || ""),
      classe: sanitize(body.classe || body.class_name || body.victim_class || ""),
      status: "nouveau",
      source_channel: "web",
      created_at: new Date().toISOString(),
    };

    const { data, error } = await supabase.from("reports").insert(report).select("id, tracking_code").single();
    if (error) return cors({ error: error.message }, 500, req);

    // Mettre a jour le compteur dans le Blob
    try {
      const schoolData = (await store.get("school_" + schoolId, { type: "json" })) as any;
      if (schoolData) {
        schoolData.report_count = (schoolData.report_count || 0) + 1;
        schoolData.updated_at = new Date().toISOString();
        await store.setJSON("school_" + schoolId, schoolData);
      }
    } catch (e) { /* non bloquant */ }

    return cors({ ok: true, tracking_code: trackingCode, report_id: data.id }, 201, req);
  }

  // GET /api/reports/list/:slug - Lister les signalements (admin)
  if (req.method === "GET" && path.startsWith("/list/")) {
    const slug = path.replace("/list/", "").split("?")[0];
    const adminCode = req.headers.get("x-admin-code") || "";
    if (!slug || !adminCode) return cors({ error: "Parametres requis" }, 400, req);

    const schoolId = await getSchoolId(slug, store);
    if (!schoolId) return cors({ error: "Etablissement non trouve" }, 404, req);

    // Verifier le code admin
    const schoolData = (await store.get("school_" + schoolId, { type: "json" })) as any;
    const isAdmin = schoolData && (adminCode === schoolData.admin_code || adminCode === schoolData.admin_password);
    const isSA = adminCode === SA_TOKEN;
    if (!isAdmin && !isSA) return cors({ error: "Non autorise" }, 401, req);

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    const { data, error } = await supabase
      .from("reports")
      .select("id, tracking_code, type, description, location, urgency, anonymous, status, created_at, updated_at, admin_reply, assigned_staff_id, classe, reporter_role")
      .eq("school_id", schoolId)
      .order("created_at", { ascending: false })
      .limit(200);

    if (error) return cors({ error: error.message }, 500, req);
    return cors({ ok: true, reports: data, total: data.length }, 200, req);
  }

  // PATCH /api/reports/update/:id - Mettre a jour un signalement (admin)
  if (req.method === "PATCH" && path.startsWith("/update/")) {
    const reportId = path.replace("/update/", "").split("?")[0];
    const adminCode = req.headers.get("x-admin-code") || "";
    if (!reportId) return cors({ error: "ID requis" }, 400, req);

    let body: any;
    try { body = await req.json(); } catch { return cors({ error: "Corps invalide" }, 400, req); }

    // Verifier que l'admin a acces a ce report
    const schoolId = await getSchoolId(body.slug || "", store);
    if (schoolId) {
      const schoolData = (await store.get("school_" + schoolId, { type: "json" })) as any;
      const isAdmin = schoolData && (adminCode === schoolData.admin_code || adminCode === schoolData.admin_password);
      if (!isAdmin && adminCode !== SA_TOKEN) return cors({ error: "Non autorise" }, 401, req);
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    const update: any = { updated_at: new Date().toISOString() };
    if (body.status) update.status = sanitize(body.status);
    if (body.admin_reply) update.admin_reply = sanitize(body.admin_reply);
    if (body.assigned_staff_id) update.assigned_staff_id = sanitize(body.assigned_staff_id);
    if (body.admin_note) update.admin_note = sanitize(body.admin_note);

    const { data, error } = await supabase.from("reports").update(update).eq("id", reportId).select().single();
    if (error) return cors({ error: error.message }, 500, req);
    return cors({ ok: true, report: data }, 200, req);
  }

  // GET /api/reports/track/:code - Suivre un signalement (eleve)
  if (req.method === "GET" && path.startsWith("/track/")) {
    const code = path.replace("/track/", "").split("?")[0].toUpperCase();
    if (!code) return cors({ error: "Code requis" }, 400, req);

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    const { data, error } = await supabase
      .from("reports")
      .select("tracking_code, status, admin_reply, created_at, updated_at, type")
      .eq("tracking_code", code)
      .single();

    if (error || !data) return cors({ error: "Signalement non trouve" }, 404, req);
    return cors({ ok: true, report: data }, 200, req);
  }

  return cors({ error: "Route non trouvee" }, 404, req);
};

export const config = { path: "/api/reports/*" };
