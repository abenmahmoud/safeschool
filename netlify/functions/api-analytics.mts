import { getStore } from '@netlify/blobs';
import type { Context, Config } from '@netlify/functions';

// --- Types ---

interface SchoolData {
  id: string;
  name: string;
  slug: string;
  city: string;
  type: string;
  plan: string;
  status: string;
  is_active: boolean;
  report_count: number;
  student_count: number;
  created_at: string;
  expires_at: string;
  updated_at?: string;
}

interface SchoolStats {
  schoolId: string;
  totalConversations?: number;
  totalMessages?: number;
  categories?: Record<string, number>;
  severityHits?: Record<string, number>;
  lastUpdated?: string;
}

interface AlertEntry {
  cat: string;
  severity: number;
  schoolName: string;
  ts: string;
}

interface SchoolAlerts {
  schoolId: string;
  alerts: AlertEntry[];
}

interface Recommendation {
  priority: 'critical' | 'high' | 'medium' | 'low';
  category: string;
  message: string;
  target_schools: string[];
  action_items: string[];
}

interface HealthCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
  value?: number;
}

// --- Auth & CORS ---

// ── V8 Extra Pro — Environment-driven auth ──
const SUPERADMIN_EMAIL = Netlify.env.get('SUPERADMIN_EMAIL') || '';
const SUPERADMIN_PASS = Netlify.env.get('SUPERADMIN_PASS') || '';

function cors(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, x-sa-token',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    },
  });
}

function authCheck(req: Request): boolean {
  const auth = req.headers.get('x-sa-token');
  if (!auth) return false;
  try {
    return atob(auth) === `${SUPERADMIN_EMAIL}:${SUPERADMIN_PASS}`;
  } catch {
    return false;
  }
}

// --- Data loading helpers ---

async function loadAllStats(): Promise<SchoolStats[]> {
  const store = getStore({ name: 'lea-stats', consistency: 'strong' });
  const { blobs } = await store.list({ prefix: 'stats/' });
  const results: SchoolStats[] = [];
  for (const blob of blobs) {
    const data = (await store.get(blob.key, { type: 'json' })) as any;
    if (data) {
      results.push({ schoolId: blob.key.replace('stats/', ''), ...data });
    }
  }
  return results;
}

async function loadAllAlerts(): Promise<SchoolAlerts[]> {
  const store = getStore({ name: 'lea-stats', consistency: 'strong' });
  const { blobs } = await store.list({ prefix: 'alerts/' });
  const results: SchoolAlerts[] = [];
  for (const blob of blobs) {
    const data = (await store.get(blob.key, { type: 'json' })) as AlertEntry[];
    if (data) {
      results.push({ schoolId: blob.key.replace('alerts/', ''), alerts: data });
    }
  }
  return results;
}

async function loadAllSchools(): Promise<SchoolData[]> {
  const store = getStore({ name: 'establishments', consistency: 'strong' });
  const index = ((await store.get('_index', { type: 'json' })) as any[]) || [];
  const schools: SchoolData[] = [];
  for (const entry of index) {
    const data = (await store.get(`school_${entry.id}`, { type: 'json' })) as SchoolData | null;
    if (data) schools.push(data);
  }
  return schools;
}

// --- Utility helpers ---

function dayOfWeek(ts: string): number {
  return new Date(ts).getDay();
}

function hourOfDay(ts: string): number {
  return new Date(ts).getHours();
}

function isWithinDays(ts: string, days: number): boolean {
  const diff = Date.now() - new Date(ts).getTime();
  return diff <= days * 24 * 60 * 60 * 1000;
}

function weekNumber(ts: string): number {
  const d = new Date(ts);
  const start = new Date(d.getFullYear(), 0, 1);
  return Math.ceil(((d.getTime() - start.getTime()) / 86400000 + start.getDay() + 1) / 7);
}

function monthKey(ts: string): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// --- Endpoint handlers ---

async function handleTrends(): Promise<Response> {
  const [allStats, allAlertData, schools] = await Promise.all([
    loadAllStats(),
    loadAllAlerts(),
    loadAllSchools(),
  ]);

  const allAlerts = allAlertData.flatMap((s) => s.alerts);

  // Bucket alerts by week and month
  const now = new Date();
  const currentWeek = weekNumber(now.toISOString());
  const currentMonth = monthKey(now.toISOString());
  const prevMonth = monthKey(new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString());

  const alertsByWeek: Record<number, number> = {};
  const alertsByMonth: Record<string, number> = {};
  const hourCounts: Record<number, number> = {};
  const dayCounts: Record<number, number> = {};

  for (const alert of allAlerts) {
    const w = weekNumber(alert.ts);
    const m = monthKey(alert.ts);
    const h = hourOfDay(alert.ts);
    const d = dayOfWeek(alert.ts);

    alertsByWeek[w] = (alertsByWeek[w] || 0) + 1;
    alertsByMonth[m] = (alertsByMonth[m] || 0) + 1;
    hourCounts[h] = (hourCounts[h] || 0) + 1;
    dayCounts[d] = (dayCounts[d] || 0) + 1;
  }

  const currentWeekCount = alertsByWeek[currentWeek] || 0;
  const prevWeekCount = alertsByWeek[currentWeek - 1] || 0;
  const weeklyChangePct = prevWeekCount > 0
    ? Math.round(((currentWeekCount - prevWeekCount) / prevWeekCount) * 100)
    : 0;

  const currentMonthCount = alertsByMonth[currentMonth] || 0;
  const prevMonthCount = alertsByMonth[prevMonth] || 0;
  const monthlyChangePct = prevMonthCount > 0
    ? Math.round(((currentMonthCount - prevMonthCount) / prevMonthCount) * 100)
    : 0;

  // Peak hours: top 3 (return just hour numbers)
  const peakHours = Object.entries(hourCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([h]) => Number(h));

  // Peak days: top 3 (return just day indices)
  const peakDays = Object.entries(dayCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([d]) => Number(d));

  // Predictions: estimate next month based on trend
  const monthValues = Object.values(alertsByMonth);
  const avgMonth = monthValues.length > 0
    ? monthValues.reduce((a, b) => a + b, 0) / monthValues.length
    : 0;
  const growthRate = prevMonthCount > 0 ? currentMonthCount / prevMonthCount : 1;
  const nextMonthEstimate = Math.round(currentMonthCount * growthRate) || Math.round(avgMonth);

  // Risk schools: schools with high severity or rapidly increasing alerts
  const schoolAlertCounts: Record<string, { total: number; highSev: number; name: string }> = {};
  for (const sa of allAlertData) {
    const school = schools.find((s) => s.id === sa.schoolId);
    const recentAlerts = sa.alerts.filter((a) => isWithinDays(a.ts, 30));
    const highSev = recentAlerts.filter((a) => a.severity >= 2).length;
    schoolAlertCounts[sa.schoolId] = {
      total: recentAlerts.length,
      highSev,
      name: school?.name || sa.schoolId,
    };
  }

  const riskSchools = Object.entries(schoolAlertCounts)
    .filter(([, v]) => v.highSev >= 3 || v.total >= 10)
    .sort((a, b) => b[1].highSev - a[1].highSev)
    .slice(0, 10)
    .map(([id, v]) => ({
      schoolId: id,
      name: v.name,
      total_alerts: v.total,
      high_severity: v.highSev,
      reason: v.highSev >= 3 ? 'Severite elevee recurrente' : 'Volume eleve d\'alertes',
    }));

  return cors({
    trends: {
      weekly_change_pct: weeklyChangePct,
      monthly_change_pct: monthlyChangePct,
      peak_hours: peakHours,
      peak_days: peakDays,
      hourly_distribution: hourCounts,
    },
    predictions: {
      next_month_estimate: nextMonthEstimate,
      risk_schools: riskSchools,
    },
  });
}

async function handleSectors(): Promise<Response> {
  const [schools, allAlertData, allStats] = await Promise.all([
    loadAllSchools(),
    loadAllAlerts(),
    loadAllStats(),
  ]);

  // Build lookup maps
  const alertsBySchool: Record<string, AlertEntry[]> = {};
  for (const sa of allAlertData) {
    alertsBySchool[sa.schoolId] = sa.alerts;
  }
  const statsBySchool: Record<string, SchoolStats> = {};
  for (const s of allStats) {
    statsBySchool[s.schoolId] = s;
  }

  // Group by city
  const byCity: Record<string, SchoolData[]> = {};
  for (const school of schools) {
    const city = school.city || 'Non renseigne';
    if (!byCity[city]) byCity[city] = [];
    byCity[city].push(school);
  }

  const sectorsByCity = Object.entries(byCity).map(([city, citySchools]) => {
    const totalReports = citySchools.reduce((sum, s) => sum + (s.report_count || 0), 0);
    const catCounts: Record<string, number> = {};
    let totalSeverity = 0;
    let severityCount = 0;

    for (const s of citySchools) {
      const alerts = alertsBySchool[s.id] || [];
      for (const a of alerts) {
        catCounts[a.cat] = (catCounts[a.cat] || 0) + 1;
        totalSeverity += a.severity;
        severityCount++;
      }
      const stats = statsBySchool[s.id];
      if (stats?.categories) {
        Object.entries(stats.categories).forEach(([cat, count]) => {
          catCounts[cat] = (catCounts[cat] || 0) + count;
        });
      }
    }

    const topCategories = Object.entries(catCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([cat, count]) => ({ category: cat, count }));

    return {
      city,
      school_count: citySchools.length,
      total_reports: totalReports,
      top_categories: topCategories.map(t => t.category),
      avg_severity: severityCount > 0 ? Math.round((totalSeverity / severityCount) * 100) / 100 : 0,
    };
  });

  // Group by type
  const byType: Record<string, SchoolData[]> = {};
  for (const school of schools) {
    const type = school.type || 'autre';
    if (!byType[type]) byType[type] = [];
    byType[type].push(school);
  }

  const sectorsByType = Object.entries(byType).map(([type, typeSchools]) => {
    const totalReports = typeSchools.reduce((sum, s) => sum + (s.report_count || 0), 0);
    const catCounts: Record<string, number> = {};
    let totalSeverity = 0;
    let severityCount = 0;

    for (const s of typeSchools) {
      const alerts = alertsBySchool[s.id] || [];
      for (const a of alerts) {
        catCounts[a.cat] = (catCounts[a.cat] || 0) + 1;
        totalSeverity += a.severity;
        severityCount++;
      }
    }

    const topCategories = Object.entries(catCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([cat]) => cat);

    return {
      type,
      school_count: typeSchools.length,
      total_reports: totalReports,
      top_categories: topCategories,
      avg_severity: severityCount > 0 ? Math.round((totalSeverity / severityCount) * 100) / 100 : 0,
    };
  });

  // Hotspots: cities with highest severity and report density
  const hotspots = sectorsByCity
    .filter((s) => s.avg_severity >= 1.5 || s.total_reports >= 5)
    .sort((a, b) => b.avg_severity - a.avg_severity)
    .slice(0, 10)
    .map((s) => ({
      city: s.city,
      school_count: s.school_count,
      total_reports: s.total_reports,
      avg_severity: s.avg_severity,
      top_category: s.top_categories[0] || 'N/A',
      reason: s.avg_severity >= 2 ? 'Severite elevee' : 'Volume important de signalements',
    }));

  return cors({
    sectors_by_city: sectorsByCity,
    sectors_by_type: sectorsByType,
    hotspots,
  });
}

async function handlePrevention(): Promise<Response> {
  const [allStats, allAlertData, schools] = await Promise.all([
    loadAllStats(),
    loadAllAlerts(),
    loadAllSchools(),
  ]);

  const recommendations: Recommendation[] = [];

  // Aggregate global categories and severity
  const globalCategories: Record<string, number> = {};
  const globalSeverity: Record<string, number> = { '0': 0, '1': 0, '2': 0, '3': 0 };

  for (const s of allStats) {
    if (s.categories) {
      Object.entries(s.categories).forEach(([cat, count]) => {
        globalCategories[cat] = (globalCategories[cat] || 0) + count;
      });
    }
    if (s.severityHits) {
      Object.entries(s.severityHits).forEach(([sev, count]) => {
        globalSeverity[sev] = (globalSeverity[sev] || 0) + count;
      });
    }
  }

  // Per-school risk analysis
  const riskBySchool: Array<{
    schoolId: string;
    name: string;
    risk_score: number;
    top_issue: string;
    high_severity_count: number;
    alert_count_30d: number;
  }> = [];

  for (const school of schools) {
    const stats = allStats.find((s) => s.schoolId === school.id);
    const alertData = allAlertData.find((a) => a.schoolId === school.id);
    const recentAlerts = (alertData?.alerts || []).filter((a) => isWithinDays(a.ts, 30));
    const highSevAlerts = recentAlerts.filter((a) => a.severity >= 2);

    // Calculate risk score (0-100)
    let riskScore = 0;
    riskScore += Math.min(recentAlerts.length * 3, 30); // alert volume
    riskScore += Math.min(highSevAlerts.length * 10, 40); // high severity weight
    const totalConv = stats?.totalConversations || 0;
    if (totalConv > 50) riskScore += 10;
    if (totalConv > 100) riskScore += 10;
    // severity distribution penalty
    const sevHits = stats?.severityHits || {};
    const sev3 = (sevHits as any)['3'] || 0;
    riskScore += Math.min(sev3 * 5, 10);

    riskScore = Math.min(riskScore, 100);

    // Top issue
    const catCounts: Record<string, number> = {};
    for (const a of recentAlerts) {
      catCounts[a.cat] = (catCounts[a.cat] || 0) + 1;
    }
    const topIssue = Object.entries(catCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'aucun';

    riskBySchool.push({
      schoolId: school.id,
      name: school.name,
      risk_score: riskScore,
      top_issue: topIssue,
      high_severity_count: highSevAlerts.length,
      alert_count_30d: recentAlerts.length,
    });
  }

  riskBySchool.sort((a, b) => b.risk_score - a.risk_score);

  // Generate recommendations based on thresholds
  const totalHighSev = Number(globalSeverity['2'] || 0) + Number(globalSeverity['3'] || 0);
  const totalAlerts = Object.values(globalSeverity).reduce((a, b) => a + b, 0);

  if (totalHighSev > 0 && totalAlerts > 0 && (totalHighSev / totalAlerts) > 0.3) {
    const affectedSchools = riskBySchool
      .filter((s) => s.high_severity_count >= 2)
      .map((s) => s.name);
    recommendations.push({
      priority: 'critical',
      category: 'severity',
      message: `${Math.round((totalHighSev / totalAlerts) * 100)}% des alertes sont de haute severite (niveau 2-3). Intervention urgente recommandee.`,
      target_schools: affectedSchools.slice(0, 10),
      action_items: [
        'Organiser une cellule de crise avec les CPE concernes',
        'Deployer des mediateurs supplementaires dans les etablissements a risque',
        'Mettre en place un suivi hebdomadaire renforce',
      ],
    });
  }

  // Category-specific recommendations
  const sortedCats = Object.entries(globalCategories).sort((a, b) => b[1] - a[1]);
  const categoryThresholds: Record<string, { message: string; actions: string[] }> = {
    harcelement: {
      message: 'Le harcelement est la categorie la plus signalisee. Programme anti-harcelement recommande.',
      actions: [
        'Mettre en place le programme pHARe dans les etablissements concernes',
        'Former les equipes pedagogiques a la detection du harcelement',
        'Organiser des ateliers de sensibilisation pour les eleves',
      ],
    },
    violence: {
      message: 'Les violences sont frequemment signalees. Renforcement de la mediation necessaire.',
      actions: [
        'Renforcer la presence adulte pendant les recreations et pauses',
        'Mettre en place des espaces de mediation par les pairs',
        'Organiser des formations en gestion de conflits',
      ],
    },
    discrimination: {
      message: 'Des cas de discrimination sont detectes. Actions de prevention recommandees.',
      actions: [
        'Organiser des journees de sensibilisation a la diversite',
        'Former le personnel a la lutte contre les discriminations',
        'Mettre en place un referent egalite dans chaque etablissement',
      ],
    },
    cyberharcèlement: {
      message: 'Le cyberharcelement est en hausse. Programme de prevention numerique necessaire.',
      actions: [
        'Deployer des ateliers sur les usages numeriques responsables',
        'Mettre en place une charte numerique dans les etablissements',
        'Former les parents aux risques du cyberharcelement',
      ],
    },
  };

  for (const [cat, count] of sortedCats.slice(0, 3)) {
    if (count >= 3) {
      const catInfo = categoryThresholds[cat.toLowerCase()];
      const affectedSchools = riskBySchool
        .filter((s) => s.top_issue.toLowerCase() === cat.toLowerCase())
        .map((s) => s.name);

      recommendations.push({
        priority: count >= 10 ? 'high' : 'medium',
        category: cat,
        message: catInfo?.message || `La categorie "${cat}" represente ${count} signalements. Surveillance renforcee recommandee.`,
        target_schools: affectedSchools.slice(0, 10),
        action_items: catInfo?.actions || [
          `Analyser les signalements de type "${cat}" en detail`,
          'Identifier les facteurs declencheurs communs',
          'Elaborer un plan de prevention specifique',
        ],
      });
    }
  }

  // Low engagement recommendation
  const lowEngagement = schools.filter((s) => {
    const stats = allStats.find((st) => st.schoolId === s.id);
    return s.is_active && (!stats || (stats.totalConversations || 0) < 3);
  });

  if (lowEngagement.length > 0) {
    recommendations.push({
      priority: 'low',
      category: 'engagement',
      message: `${lowEngagement.length} etablissement(s) actif(s) montrent un faible taux d'utilisation de la plateforme.`,
      target_schools: lowEngagement.map((s) => s.name).slice(0, 10),
      action_items: [
        'Contacter les administrateurs des etablissements concernes',
        'Proposer une session de formation a la plateforme',
        'Verifier que la communication aux eleves a ete faite',
      ],
    });
  }

  // Global risk score (average of all school risk scores)
  const riskScoreGlobal = riskBySchool.length > 0
    ? Math.round(riskBySchool.reduce((sum, s) => sum + s.risk_score, 0) / riskBySchool.length)
    : 0;

  recommendations.sort((a, b) => {
    const order: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    return (order[a.priority] ?? 4) - (order[b.priority] ?? 4);
  });

  return cors({
    recommendations,
    risk_score_global: riskScoreGlobal,
    risk_by_school: riskBySchool,
  });
}

async function handleExport(): Promise<Response> {
  const [allStats, allAlertData, schools] = await Promise.all([
    loadAllStats(),
    loadAllAlerts(),
    loadAllSchools(),
  ]);

  // Reports summary (anonymized)
  const totalReports = schools.reduce((sum, s) => sum + (s.report_count || 0), 0);
  const totalConversations = allStats.reduce((sum, s) => sum + (s.totalConversations || 0), 0);
  const totalMessages = allStats.reduce((sum, s) => sum + (s.totalMessages || 0), 0);

  // Category distribution
  const categoryDistribution: Record<string, number> = {};
  for (const s of allStats) {
    if (s.categories) {
      Object.entries(s.categories).forEach(([cat, count]) => {
        categoryDistribution[cat] = (categoryDistribution[cat] || 0) + count;
      });
    }
  }

  // Severity distribution
  const severityDistribution: Record<string, number> = { '0': 0, '1': 0, '2': 0, '3': 0 };
  for (const s of allStats) {
    if (s.severityHits) {
      Object.entries(s.severityHits).forEach(([sev, count]) => {
        severityDistribution[sev] = (severityDistribution[sev] || 0) + count;
      });
    }
  }

  // Temporal patterns (anonymized)
  const allAlerts = allAlertData.flatMap((s) => s.alerts);
  const hourlyDistribution: Record<number, number> = {};
  const dailyDistribution: Record<number, number> = {};
  const monthlyDistribution: Record<string, number> = {};

  for (const alert of allAlerts) {
    const h = hourOfDay(alert.ts);
    const d = dayOfWeek(alert.ts);
    const m = monthKey(alert.ts);

    hourlyDistribution[h] = (hourlyDistribution[h] || 0) + 1;
    dailyDistribution[d] = (dailyDistribution[d] || 0) + 1;
    monthlyDistribution[m] = (monthlyDistribution[m] || 0) + 1;
  }

  // School type distribution (anonymized)
  const typeDistribution: Record<string, number> = {};
  for (const school of schools) {
    const t = school.type || 'autre';
    typeDistribution[t] = (typeDistribution[t] || 0) + 1;
  }

  // Urgency distribution from alerts
  const urgencyDistribution: Record<string, number> = { low: 0, medium: 0, high: 0, critical: 0 };
  for (const alert of allAlerts) {
    if (alert.severity === 0) urgencyDistribution.low++;
    else if (alert.severity === 1) urgencyDistribution.medium++;
    else if (alert.severity === 2) urgencyDistribution.high++;
    else if (alert.severity >= 3) urgencyDistribution.critical++;
  }

  // Category trends by month
  const categoryTrends: Record<string, Record<string, number>> = {};
  for (const alert of allAlerts) {
    const m = monthKey(alert.ts);
    if (!categoryTrends[alert.cat]) categoryTrends[alert.cat] = {};
    categoryTrends[alert.cat][m] = (categoryTrends[alert.cat][m] || 0) + 1;
  }

  return cors({
    dataset: {
      meta: {
        total_schools: schools.length,
        active_schools: schools.filter((s) => s.is_active).length,
        school_types: typeDistribution,
        data_period_start: allAlerts.length > 0
          ? allAlerts.reduce((min, a) => (a.ts < min ? a.ts : min), allAlerts[0].ts)
          : null,
        data_period_end: allAlerts.length > 0
          ? allAlerts.reduce((max, a) => (a.ts > max ? a.ts : max), allAlerts[0].ts)
          : null,
      },
      reports_summary: {
        total_reports: totalReports,
        total_conversations: totalConversations,
        total_messages: totalMessages,
        total_alerts: allAlerts.length,
      },
      temporal_patterns: {
        hourly_distribution: hourlyDistribution,
        daily_distribution: dailyDistribution,
        monthly_distribution: monthlyDistribution,
      },
      category_distribution: categoryDistribution,
      severity_distribution: severityDistribution,
      urgency_distribution: urgencyDistribution,
      category_trends: categoryTrends,
    },
    format: 'json',
    generated_at: new Date().toISOString(),
  });
}

async function handleHealth(): Promise<Response> {
  const checks: HealthCheck[] = [];
  let passCount = 0;

  // Check 1: Establishments store accessible and has data
  try {
    const schools = await loadAllSchools();
    const activeSchools = schools.filter((s) => s.is_active);
    if (schools.length === 0) {
      checks.push({ name: 'establishments_data', status: 'warn', message: 'Aucun etablissement enregistre', value: 0 });
    } else {
      checks.push({
        name: 'establishments_data',
        status: 'pass',
        message: `${schools.length} etablissement(s) dont ${activeSchools.length} actif(s)`,
        value: schools.length,
      });
      passCount++;
    }

    // Check 2: Expired schools
    const expired = schools.filter((s) => {
      if (!s.expires_at) return false;
      return new Date(s.expires_at) < new Date();
    });
    if (expired.length > schools.length * 0.5 && schools.length > 0) {
      checks.push({
        name: 'subscription_health',
        status: 'warn',
        message: `${expired.length}/${schools.length} abonnements expires`,
        value: expired.length,
      });
    } else {
      checks.push({
        name: 'subscription_health',
        status: 'pass',
        message: `${expired.length} abonnement(s) expire(s) sur ${schools.length}`,
        value: expired.length,
      });
      passCount++;
    }
  } catch (e) {
    checks.push({ name: 'establishments_data', status: 'fail', message: 'Impossible de lire le store establishments' });
    checks.push({ name: 'subscription_health', status: 'fail', message: 'Verification impossible' });
  }

  // Check 3: Stats data freshness
  try {
    const allStats = await loadAllStats();
    if (allStats.length === 0) {
      checks.push({ name: 'stats_data', status: 'warn', message: 'Aucune donnee de stats disponible', value: 0 });
    } else {
      const freshStats = allStats.filter((s) => s.lastUpdated && isWithinDays(s.lastUpdated, 7));
      const freshnessRatio = freshStats.length / allStats.length;
      checks.push({
        name: 'stats_data',
        status: freshnessRatio >= 0.5 ? 'pass' : 'warn',
        message: `${freshStats.length}/${allStats.length} stats mises a jour dans les 7 derniers jours`,
        value: freshStats.length,
      });
      if (freshnessRatio >= 0.5) passCount++;
    }
  } catch (e) {
    checks.push({ name: 'stats_data', status: 'fail', message: 'Impossible de lire le store lea-stats' });
  }

  // Check 4: Alerts data
  try {
    const allAlertData = await loadAllAlerts();
    const totalAlerts = allAlertData.reduce((sum, s) => sum + s.alerts.length, 0);
    const recentAlerts = allAlertData.flatMap((s) => s.alerts).filter((a) => isWithinDays(a.ts, 7));
    const criticalRecent = recentAlerts.filter((a) => a.severity >= 3);

    if (criticalRecent.length > 5) {
      checks.push({
        name: 'alert_threshold',
        status: 'warn',
        message: `${criticalRecent.length} alertes critiques (sev>=3) dans les 7 derniers jours`,
        value: criticalRecent.length,
      });
    } else {
      checks.push({
        name: 'alert_threshold',
        status: 'pass',
        message: `${criticalRecent.length} alerte(s) critique(s) recente(s), ${totalAlerts} au total`,
        value: criticalRecent.length,
      });
      passCount++;
    }
  } catch (e) {
    checks.push({ name: 'alert_threshold', status: 'fail', message: 'Impossible de lire les alertes' });
  }

  // Check 5: Data quality - do schools have stats?
  try {
    const schools = await loadAllSchools();
    const allStats = await loadAllStats();
    const activeSchools = schools.filter((s) => s.is_active);
    const schoolsWithStats = activeSchools.filter((s) => allStats.some((st) => st.schoolId === s.id));
    const coverage = activeSchools.length > 0 ? schoolsWithStats.length / activeSchools.length : 0;

    checks.push({
      name: 'data_coverage',
      status: coverage >= 0.5 ? 'pass' : 'warn',
      message: `${schoolsWithStats.length}/${activeSchools.length} etablissements actifs ont des stats`,
      value: Math.round(coverage * 100),
    });
    if (coverage >= 0.5) passCount++;
  } catch (e) {
    checks.push({ name: 'data_coverage', status: 'fail', message: 'Verification impossible' });
  }

  const totalChecks = checks.length;
  const failCount = checks.filter((c) => c.status === 'fail').length;
  const overallStatus = failCount > 0 ? 'degraded' : passCount === totalChecks ? 'healthy' : 'warning';

  const uptimeScore = totalChecks > 0 ? Math.round((passCount / totalChecks) * 100) : 0;

  // Data quality: combination of freshness and coverage
  const freshnessCheck = checks.find((c) => c.name === 'stats_data');
  const coverageCheck = checks.find((c) => c.name === 'data_coverage');
  const dataQualityScore = Math.round(
    ((freshnessCheck?.status === 'pass' ? 50 : freshnessCheck?.status === 'warn' ? 25 : 0) +
      (coverageCheck?.status === 'pass' ? 50 : coverageCheck?.status === 'warn' ? 25 : 0))
  );

  return cors({
    status: overallStatus,
    checks,
    uptime_score: uptimeScore,
    data_quality_score: dataQualityScore,
  });
}

// --- Main handler ---

export default async (req: Request, context: Context): Promise<Response> => {
  if (req.method === 'OPTIONS') return cors({ ok: true });

  if (!authCheck(req)) return cors({ error: 'Non autorise' }, 401);

  const url = new URL(req.url);
  const path = url.pathname.replace('/api/analytics', '');

  try {
    if (req.method === 'GET' && path === '/trends') {
      return await handleTrends();
    }

    if (req.method === 'GET' && path === '/sectors') {
      return await handleSectors();
    }

    if (req.method === 'GET' && path === '/prevention') {
      return await handlePrevention();
    }

    if (req.method === 'GET' && path === '/export') {
      return await handleExport();
    }

    if (req.method === 'GET' && path === '/health') {
      return await handleHealth();
    }

    return cors({ error: 'Route non trouvee' }, 404);
  } catch (err: any) {
    console.error('Analytics error:', err);
    return cors({ error: 'Erreur interne', details: err?.message || 'Unknown error' }, 500);
  }
};

export const config: Config = {
  path: '/api/analytics/*',
};
