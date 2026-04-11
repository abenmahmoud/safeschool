import type { Context } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = Netlify.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Netlify.env.get("RESEND_API_KEY");
const FROM_EMAIL = Netlify.env.get("NOTIFY_FROM_EMAIL") || "notifications@safeschool.fr";

const _cache = new Map();
const TTL = 60000;
const fromCache = (k) => { const c = _cache.get(k); return c && Date.now() - c.ts < TTL ? c.data : null; };
const toCache = (k, d) => _cache.set(k, { data: d, ts: Date.now() });

function genCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let c = "SS-";
  for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

export default async function handler(req, context) {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });

  const url = new URL(req.url);
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  if (req.method === "GET") {
    const code = url.searchParams.get("code");
    if (!code) return new Response(JSON.stringify({ error: "Code requis" }), { status: 400, headers: cors });
    let report = fromCache("r:" + code);
    if (!report) {
      const { data, error } = await sb.from("reports")
        .select("id,tracking_code,status,type,urgence,created_at,updated_at,school_id,responses(message,created_at,author_role)")
        .eq("tracking_code", code).single();
      if (error || !data) return new Response(JSON.stringify({ error: "Introuvable" }), { status: 404, headers: cors });
      toCache("r:" + code, data);
      report = data;
    }
    return new Response(JSON.stringify({ report }), { status: 200, headers: cors });
  }

  if (req.method === "POST") {
    let body;
    try { body = await req.json(); } catch {
      return new Response(JSON.stringify({ error: "JSON invalide" }), { status: 400, headers: cors });
    }
    const { school_id, slug, type, urgence, description, anonymous, email, phone, documents } = body;

    let sid = school_id;
    if (!sid && slug) {
      let school = fromCache("slug:" + slug);
      if (!school) {
        const { data } = await sb.from("schools").select("id,admin_email,name").eq("slug", slug).single();
        if (data) { toCache("slug:" + slug, data); school = data; }
      }
      sid = school?.id;
    }
    if (!sid) return new Response(JSON.stringify({ error: "Etablissement introuvable" }), { status: 400, headers: cors });
    if (!type || !description) return new Response(JSON.stringify({ error: "type et description requis" }), { status: 400, headers: cors });

    const tracking_code = genCode();
    const { data: report, error } = await sb.from("reports").insert({
      school_id: sid, tracking_code, type,
      urgence: urgence || "moyen", description,
      anonymous: anonymous !== false,
      reporter_email: anonymous !== false ? null : (email || null),
      reporter_phone: anonymous !== false ? null : (phone || null),
      status: "nouveau", documents: documents || [],
    }).select().single();

    if (error) return new Response(JSON.stringify({ error: "Erreur DB", details: error.message }), { status: 500, headers: cors });

    context.waitUntil((async () => {
      try {
        const { data: school } = await sb.from("schools").select("admin_email,name").eq("id", sid).single();
        if (!school?.admin_email || !RESEND_API_KEY) return;
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: "Bearer " + RESEND_API_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: FROM_EMAIL, to: school.admin_email,
            subject: "Nouveau signalement [" + (urgence||"moyen").toUpperCase() + "] - " + school.name,
            html: "<div style='font-family:sans-serif'><div style='background:#dc2626;color:white;padding:20px'><h2>Nouveau signalement</h2><p>Code : <strong>" + tracking_code + "</strong></p></div><div style='padding:20px;background:#f9fafb'><p><b>Type :</b> " + type + "</p><p><b>Urgence :</b> " + (urgence||"moyen") + "</p><p><b>Description :</b> " + description.substring(0,400) + "</p><p style='text-align:center'><a href='https://app.safeschool.fr/admin?code=" + tracking_code + "' style='background:#dc2626;color:white;padding:12px 24px;border-radius:6px;text-decoration:none'>Voir le signalement</a></p></div></div>",
          }),
        });
        if (anonymous === false && email) {
          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: "Bearer " + RESEND_API_KEY, "Content-Type": "application/json" },
            body: JSON.stringify({
              from: FROM_EMAIL, to: email,
              subject: "Signalement recu - Code " + tracking_code,
              html: "<div style='font-family:sans-serif'><div style='background:#2563eb;color:white;padding:20px'><h2>Signalement recu</h2></div><div style='padding:20px;background:#f9fafb'><p>Votre signalement a ete transmis.</p><p><b>Code de suivi : <span style='color:#dc2626;font-size:1.4em;letter-spacing:3px'>" + tracking_code + "</span></b></p><p style='text-align:center'><a href='https://app.safeschool.fr?code=" + tracking_code + "' style='background:#2563eb;color:white;padding:12px 24px;border-radius:6px;text-decoration:none'>Suivre mon dossier</a></p></div></div>",
            }),
          });
        }
      } catch(e) { console.error("notify error", e); }
    })());

    return new Response(JSON.stringify({
      success: true, tracking_code, report_id: report.id,
      message: anonymous !== false ? "Signalement enregistre. Notez votre code." : "Email de confirmation envoye.",
    }), { status: 201, headers: cors });
  }

  return new Response(JSON.stringify({ error: "Methode non supportee" }), { status: 405, headers: cors });
}
