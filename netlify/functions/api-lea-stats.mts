import type { Context } from "@netlify/functions";

const SU = process.env.aSUPABASE_URL || "";
const SK = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

function computeRiskScore(s: any): number {
  if (!s.total) return 0;
  let score = 0;
  score += Math.min((s.last30d || 0) * 6, 30);
  score += (s.total > 0 ? (s.urgents / s.total) : 0) * 20;
  score += (s.total > 0 ? ((s.nouveau + s.enCours) / s.total) : 0) * 20;
  score += (s.total > 0 ? (s.physique / s.total) : 0) * 15;
  const wr = s.last7d || 0;
  const mr = (s.last30d || 0) / 4;
  if (mr > 0 && wr > mr) score += Math.min(((wr / mr) - 1) * 15, 15);
  return Math.round(Math.min(score, 100));
}

export default async function handler(req: Request, context: Context) {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization"
    }});
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), { status: 405 });
  }
  try {
    const body = await req.json();
    const sid = body.school_id;
    if (!sid) return new Response(JSON.stringify({ error: "school_id required" }), { status: 400 });

    const rr = await fetch(`${SU}/rest/v1/reports?school_id=eq.${sid}&select=*&order=created_at.desc`, {
      headers: { apikey: SK, Authorization: `Bearer ${SK}` }
    });
    const reports: any[] = await rr.json();
    if (!Array.isArray(reports)) return new Response(JSON.stringify({ error: "fetch failed" }), { status: 500 });

    const sr = await fetch(`${SU}/rest/v1/schools?id=eq.${sid}&select=*`, {
      headers: { apikey: SK, Authorization: `Bearer ${SK}` }
    });
    const schools: any[] = await sr.json();
    const school = Array.isArray(schools) ? schools[0] : null;

    const now = Date.now();
    const d30 = 30 * 86400000;
    const d7 = 7 * 86400000;

    const s = {
      total: reports.length,
      nouveau: reports.filter((r: any) => r.status === "nouveau").length,
      enCours: reports.filter((r: any) => r.status === "en_cours").length,
      traites: reports.filter((r: any) => ["traite","archive","closed"].includes(r.status)).length,
      urgents: reports.filter((r: any) => r.urgency === "haute").length,
      physique: reports.filter((r: any) => r.type === "physique").length,
      verbal: reports.filter((r: any) => r.type === "verbal").length,
      cyber: reports.filter((r: any) => r.type === "cyber").length,
      exclusion: reports.filter((r: any) => r.type === "exclusion").length,
      autre: reports.filter((r: any) => r.type === "autre").length,
      last30d: reports.filter((r: any) => (now - new Date(r.created_at).getTime()) < d30).length,
      last7d: reports.filter((r: any) => (now - new Date(r.created_at).getTime()) < d7).length,
      withReply: reports.filter((r: any) => r.admin_reply).length,
      anonymous: reports.filter((r: any) => r.is_anonymous || r.anonymous).length
    };

    const tb = [
      { type: "Physique", count: s.physique },
      { type: "Verbal", count: s.verbal },
      { type: "Cyber", count: s.cyber },
      { type: "Exclusion", count: s.exclusion },
      { type: "Autre", count: s.autre }
    ].filter(t => t.count > 0);

    const mt: any[] = [];
    for (let m = 5; m >= 0; m--) {
      const st = new Date();
      st.setMonth(st.getMonth() - m);
      st.setDate(1);
      st.setHours(0, 0, 0, 0);
      const en = new Date(st);
      en.setMonth(en.getMonth() + 1);
      mt.push({
        month: st.toLocaleDateString("fr-FR", { month: "short", year: "2-digit" }),
        count: reports.filter((r: any) => {
          const d = new Date(r.created_at);
          return d >= st && d < en;
        }).length
      });
    }

    const rs = computeRiskScore(s);
    const rl = rs >= 75 ? "critique" : rs >= 50 ? "eleve" : rs >= 25 ? "modere" : "faible";

    const rt = reports.filter((r: any) => r.reply_sent_at).map((r: any) => (new Date(r.reply_sent_at).getTime() - new Date(r.created_at).getTime()) / 3600000);
    const arh = rt.length ? Math.round(rt.reduce((a: number, b: number) => a + b, 0) / rt.length) : null;

    const types = [
      { n: "physique", c: s.physique },
      { n: "verbal", c: s.verbal },
      { n: "cyber", c: s.cyber },
      { n: "exclusion", c: s.exclusion }
    ].sort((a, b) => b.c - a.c);
    const dom = types[0] && types[0].c > 0 ? types[0].n : "aucun";
    const resR = s.total > 0 ? Math.round(s.traites / s.total * 100) : 0;
    const repR = s.total > 0 ? Math.round(s.withReply / s.total * 100) : 0;

    let sum = "";
    if (!s.total) sum = "Aucun signalement enregistre.";
    else if (rs < 25) sum = `Situation sereine: ${s.total} signalement(s), risque faible (${rs}/100).`;
    else if (rs < 50) sum = `Vigilance: ${s.total} signalement(s), type dominant: ${dom}. Score ${rs}/100.`;
    else if (rs < 75) sum = `Attention: ${s.total} signalement(s), risque eleve (${rs}/100). Type: ${dom}.`;
    else sum = `ALERTE CRITIQUE: ${s.total} signalement(s), score ${rs}/100. Action immediate requise.`;

    const alerts: string[] = [];
    if (s.nouveau > 0) alerts.push(`${s.nouveau} signalement(s) non traite(s)`);
    if (s.urgents > 0) alerts.push(`${s.urgents} cas urgent(s)`);
    if (repR < 50 && s.total > 0) alerts.push(`Taux de reponse faible: ${repR}%`);
    if (s.last7d > s.last30d / 2 && s.last30d > 2) alerts.push("Acceleration des signalements cette semaine");

    const conseils: string[] = [];
    if (s.nouveau > 0) conseils.push("Traiter en priorite les signalements en attente");
    if (dom === "cyber") conseils.push("Mettre en place une sensibilisation au cyberharcelement");
    if (dom === "physique") conseils.push("Renforcer la surveillance dans les espaces communs");
    if (dom === "exclusion") conseils.push("Organiser des ateliers de cohesion de groupe");
    if (dom === "verbal") conseils.push("Former le personnel a la detection du harcelement verbal");
    if (repR < 80 && s.total > 2) conseils.push("Ameliorer le temps de reponse aux signalements");
    if (s.anonymous > s.total * 0.8 && s.total > 1) conseils.push("Beaucoup de signalements anonymes: renforcer la confiance des eleves");
    if (!conseils.length) conseils.push("Continuer la politique de prevention active");

    const sn = school ? school.name : "Etablissement";
    return new Response(JSON.stringify({
      school: sn,
      stats: s,
      typeBreakdown: tb,
      monthlyTrend: mt,
      riskScore: rs,
      riskLevel: rl,
      avgResponseHours: arh,
      analysis: {
        summary: sum,
        dominant: dom,
        resolutionRate: resR,
        replyRate: repR,
        alerts: alerts,
        conseils: conseils,
        reportTitle: `Rapport Lea IA - ${sn} - ${new Date().toLocaleDateString("fr-FR", { month: "long", year: "numeric" })}`
      },
      generatedAt: new Date().toISOString()
    }), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
}

export const config = { path: "/api/lea-stats" };