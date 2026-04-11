import type { Context } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = Netlify.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Netlify.env.get("RESEND_API_KEY");
const FROM_EMAIL = Netlify.env.get("NOTIFY_FROM_EMAIL") || "notifications@safeschool.fr";

// Cache établissements en mémoire (60s TTL)
const _cache: Map<string, {data: any; ts: number}> = new Map();
const CACHE_TTL = 60_000;
function fromCache(key: string) {
  const c = _cache.get(key);
  if (c && Date.now() - c.ts < CACHE_TTL) return c.data;
  return null;
}
function toCache(key: string, data: any) { _cache.set(key, { data, ts: Date.now() }); }

function genCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "SS-";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

export default async function handler(req: Request, context: Context) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers });

  const url = new URL(req.url);
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // GET /api/reports?code=SS-XXXXXX — suivi d'un signalement
  if (req.method === "GET") {
    const code = url.searchParams.get("code");
    if (!code) return new Response(JSON.stringify({ error: "Code requis" }), { status: 400, headers });
    const cacheKey = `report:${code}`;
    let report = fromCache(cacheKey);
    if (!report) {
      const { data, error } = await supabase
        .from("reports")
        .select("id, tracking_code, status, type, urgence, created_at, updated_at, school_id, responses(message, created_at, author_role)")
        .eq("tracking_code", code)
        .single();
      if (error || !data) return new Response(JSON.stringify({ error: "Signalement non trouvé" }), { status: 404, headers });
      report = data;
      toCache(cacheKey, report);
    }
    return new Response(JSON.stringify({ report }), { status: 200, headers });
  }

  // POST /api/reports — soumettre un nouveau signalement
  if (req.method === "POST") {
    let body: any;
    try { body = await req.json(); } catch { return new Response(JSON.stringify({ error: "JSON invalide" }), { status: 400, headers }); }

    const { school_id, slug, type, urgence, description, anonymous, email, phone, documents } = body;

    // Résoudre school_id depuis slug si nécessaire
    let resolvedSchoolId = school_id;
    if (!resolvedSchoolId && slug) {
      const cacheKey = `school_slug:${slug}`;
      let school = fromCache(cacheKey);
      if (!school) {
        const { data } = await supabase.from("schools").select("id, admin_email, name").eq("slug", slug).single();
        if (data) { toCache(cacheKey, data); school = data; }
      }
      if (school) resolvedSchoolId = school.id;
    }
    if (!resolvedSchoolId) return new Response(JSON.stringify({ error: "Établissement introuvable" }), { status: 400, headers });

    if (!type || !description) return new Response(JSON.stringify({ error: "type et description requis" }), { status: 400, headers });

    const tracking_code = genCode();
    const reportData = {
      school_id: resolvedSchoolId,
      tracking_code,
      type: type || "harcelement",
      urgence: urgence || "moyen",
      description,
      anonymous: anonymous !== false,
      reporter_email: anonymous ? null : (email || null),
      reporter_phone: anonymous ? null : (phone || null),
      status: "nouveau",
      documents: documents || [],
    };

    const { data: report, error } = await supabase.from("reports").insert(reportData).select().single();
    if (error) {
      console.error("Insert error:", error);
      return new Response(JSON.stringify({ error: "Erreur création signalement", details: error.message }), { status: 500, headers });
    }

    // Notifier en background (ne pas bloquer la réponse)
    const notifyAsync = async () => {
      try {
        // Récupérer l'email admin
        const { data: school } = await supabase.from("schools").select("admin_email, name").eq("id", resolvedSchoolId).single();
        if (!school?.admin_email || !RESEND_API_KEY) return;

        // Email à l'admin
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: FROM_EMAIL,
            to: school.admin_email,
            subject: `🚨 Nouveau signalement [${urgence?.toUpperCase() || "MOYEN"}] — ${school.name}`,
            html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto">
              <div style="background:#dc2626;color:white;padding:20px;border-radius:8px 8px 0 0">
                <h2 style="margin:0">Nouveau signalement</h2>
                <p style="margin:4px 0 0;opacity:.9">Code: <strong>${tracking_code}</strong></p>
              </div>
              <div style="background:#f9f9f9;padding:20px;border-radius:0 0 8px 8px;border:1px solid #e5e5e5">
                <p><strong>Type:</strong> ${type}</p>
                <p><strong>Urgence:</strong> ${urgence || "moyen"}</p>
                <p><strong>Description:</strong> ${description.substring(0, 300)}${description.length > 300 ? "..." : ""}</p>
                <p><strong>Anonyme:</strong> ${anonymous !== false ? "Oui" : "Non"}</p>
                <div style="text-align:center;margin:20px 0">
                  <a href="https://app.safeschool.fr/admin?code=${tracking_code}" 
                     style="background:#dc2626;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold">
                    Voir le signalement →
                  </a>
                </div>
              </div>
            </div>`,
          }),
        });

        // Email de confirmation au signalant (si non anonyme)
        if (!anonymous && email) {
          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              from: FROM_EMAIL,
              to: email,
              subject: `Votre signalement a été reçu — Code ${tracking_code}`,
              html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto">
                <div style="background:#2563eb;color:white;padding:20px;border-radius:8px 8px 0 0">
                  <h2 style="margin:0">Signalement reçu</h2>
                </div>
                <div style="background:#f9f9f9;padding:20px;border-radius:0 0 8px 8px;border:1px solid #e5e5e5">
                  <p>Votre signalement a bien été transmis à l'équipe de votre établissement.</p>
                  <p><strong>Votre code de suivi : <span style="font-size:1.4em;color:#dc2626;letter-spacing:2px">${tracking_code}</span></strong></p>
                  <p style="font-size:13px;color:#666">Conservez ce code pour suivre l'avancement de votre dossier.</p>
                  <div style="text-align:center;margin:20px 0">
                    <a href="https://app.safeschool.fr?code=${tracking_code}" 
                       style="background:#2563eb;color:white;padding:12px 24px;border-radius:6px;text-decoration:none">
                      Suivre mon dossier →
                    </a>
                  </div>
                </div>
              </div>`,
            }),
          });
        }
      } catch (e) { console.error("Notify error:", e); }
    };
    context.waitUntil(notifyAsync());

    return new Response(JSON.stringify({
      success: true,
      tracking_code,
      report_id: report.id,
      message: "Signalement enregistré. " + (anonymous !== false ? "Conservez votre code de suivi." : "Un email de confirmation vous a été envoyé."),
    }), { status: 201, headers });
  }

  return new Response(JSON.stringify({ error: "Méthode non supportée" }), { status: 405, headers });
}
