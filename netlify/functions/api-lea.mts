import type { Context, Config } from '@netlify/functions';

const SUPA = () => Netlify.env.get('aSUPABASE_URL') || 'https://bsytkpgdxvlddzuwaabp.supabase.co';
const SK = () => Netlify.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const CLAUDE_KEY = () => Netlify.env.get('ANTHROPIC_API_KEY') || '';
const JWT_SECRET = () => Netlify.env.get('ADMIN_JWT_SECRET') || 'safeschool_change_me';

function cors(body: any, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  }});
}

async function verifyJWT(token: string): Promise<any | null> {
  try {
    const [h, p, s] = token.split('.');
    if (!h || !p || !s) return null;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(JWT_SECRET()), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const sig = Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0));
    const ok = await crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(h + '.' + p));
    if (!ok) return null;
    const payload = JSON.parse(atob(p.replace(/-/g,'+').replace(/_/g,'/')));
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

async function getReports(schoolId: string) {
  const r = await fetch(SUPA() + '/rest/v1/reports?school_id=eq.' + schoolId + '&order=created_at.desc&limit=100&select=id,type,urgency,status,description,created_at,anonymous,reporter_role,classe,location', {
    headers: { apikey: SK(), Authorization: 'Bearer ' + SK() }
  });
  return r.json();
}

async function callClaude(prompt: string): Promise<string> {
  const key = CLAUDE_KEY();
  if (!key) return JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' });
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'anthropic-version': '2023-06-01', 'x-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-opus-4-6',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  const d = await r.json() as any;
  return d?.content?.[0]?.text || JSON.stringify(d);
}

export default async (req: Request, _ctx: Context) => {
  if (req.method === 'OPTIONS') return cors({ ok: true });
  if (req.method !== 'POST' && req.method !== 'GET') return cors({ error: 'Method not allowed' }, 405);

  // Vérifier JWT
  const auth = req.headers.get('Authorization') || '';
  const token = auth.replace('Bearer ', '');
  const payload = await verifyJWT(token);
  if (!payload) return cors({ error: 'Non autorisé' }, 401);
  const schoolId = payload.school_id;
  if (!schoolId) return cors({ error: 'school_id manquant dans le token' }, 400);

  const url = new URL(req.url);
  const action = url.pathname.split('/').pop() || 'analyze';

  // Récupérer les signalements
  const reports = await getReports(schoolId) as any[];
  if (!Array.isArray(reports)) return cors({ error: 'Impossible de récupérer les signalements' }, 500);

  const total = reports.length;
  const nouveau = reports.filter(r => r.status === 'nouveau').length;
  const en_cours = reports.filter(r => r.status === 'en_cours').length;
  const resolu = reports.filter(r => r.status === 'resolu').length;
  const critique = reports.filter(r => r.urgency === 'critique').length;
  const eleve = reports.filter(r => r.urgency === 'eleve').length;
  const typeCount: Record<string, number> = {};
  reports.forEach(r => { typeCount[r.type || 'autre'] = (typeCount[r.type || 'autre'] || 0) + 1; });
  const last30 = reports.filter(r => new Date(r.created_at) > new Date(Date.now() - 30 * 86400000)).length;

  // Calcul baromètre (score 0-100, 100 = très risqué)
  let score = 0;
  if (total > 0) {
    score += Math.min(40, total * 2);
    score += critique * 15;
    score += eleve * 8;
    score += nouveau * 3;
    score += last30 * 2;
    score = Math.min(100, score);
  }
  const niveau = score < 20 ? 'faible' : score < 45 ? 'modere' : score < 70 ? 'eleve' : 'critique';
  const couleur = score < 20 ? '#10b981' : score < 45 ? '#f59e0b' : score < 70 ? '#f97316' : '#ef4444';

  if (action === 'barometer') {
    return cors({ score, niveau, couleur, total, nouveau, en_cours, resolu, critique_urgent: critique + eleve, last30, types: typeCount });
  }

  // Construire le contexte pour Léa
  const summaryForAI = 'Établissement: ' + schoolId.substring(0, 8) + '\n'
    + 'Total signalements: ' + total + '\n'
    + 'Nouveaux: ' + nouveau + ', En cours: ' + en_cours + ', Résolus: ' + resolu + '\n'
    + 'Urgences critiques: ' + critique + ', élevées: ' + eleve + '\n'
    + 'Types: ' + Object.entries(typeCount).map(([k, v]) => k + ':' + v).join(', ') + '\n'
    + '30 derniers jours: ' + last30 + ' signalements\n'
    + 'Score baromètre: ' + score + '/100 (niveau: ' + niveau + ')\n'
    + 'Détails récents: ' + reports.slice(0, 10).map(r => '[' + r.type + '/' + r.urgency + '/' + r.status + ': ' + (r.description || '').substring(0, 60) + ']').join(' | ');

  if (action === 'analyze') {
    const prompt = 'Tu es Léa, l\'intelligence artificielle de SafeSchool spécialisée en prévention du harcèlement scolaire. '
      + 'Analyse ces données d\'un établissement scolaire et donne une analyse professionnelle en français. '
      + 'Réponds UNIQUEMENT en JSON valide avec cette structure exacte: '
      + '{"synthese": "2-3 phrases de synthèse", "points_attention": ["point1", "point2", "point3"], "conseils": ["conseil1", "conseil2", "conseil3"], "tendance": "hausse|stable|baisse", "message_equipe": "message encourageant pour l\'équipe"}\n\n'
      + 'Données: ' + summaryForAI;

    const raw = await callClaude(prompt);
    let analysis: any = {};
    try { analysis = JSON.parse(raw.replace(/```json|```/g, '').trim()); } catch { analysis = { synthese: raw.substring(0, 200), points_attention: [], conseils: [], tendance: 'stable', message_equipe: '' }; }
    return cors({ ok: true, score, niveau, couleur, total, nouveau, last30, types: typeCount, analysis });
  }

  if (action === 'report') {
    const prompt = 'Tu es Léa, l\'intelligence artificielle de SafeSchool. '
      + 'Génère un rapport mensuel professionnel complet en HTML pour cet établissement scolaire. '
      + 'Le rapport doit inclure: titre, date, résumé exécutif, analyse détaillée par type de harcèlement, tendances, recommandations prioritaires, et conclusion. '
      + 'Utilise un style sobre et professionnel adapté au milieu éducatif français. '
      + 'Génère UNIQUEMENT le contenu HTML du corps du rapport (pas de <html> ou <body>). '
      + 'Commence par <h1>Rapport SafeSchool</h1>\n\n'
      + 'Données: ' + summaryForAI;

    const reportHtml = await callClaude(prompt);
    return cors({ ok: true, html: reportHtml, score, niveau, generated_at: new Date().toISOString() });
  }

  return cors({ error: 'Action inconnue. Utilisez: barometer, analyze, report' }, 404);
};

export const config: Config = { path: ['/api/lea/barometer', '/api/lea/analyze', '/api/lea/report'] };