import { getStore } from '@netlify/blobs';
import type { Config } from '@netlify/functions';

const MAX_REPORTS = 90;

export default async (req: Request) => {
  try {
    const body = await req.json().catch(() => ({}));
    console.log('Generating daily report. Next run:', body.next_run || 'unknown');

    const statsStore = getStore({ name: 'lea-stats', consistency: 'strong' });
    const reportsStore = getStore({ name: 'reports-generated', consistency: 'strong' });

  // --- Gather all school stats ---
  const { blobs: statBlobs } = await statsStore.list({ prefix: 'stats/' });
  const { blobs: alertBlobs } = await statsStore.list({ prefix: 'alerts/' });

  let totalConversations = 0;
  let totalMessages = 0;
  const globalCategories: Record<string, number> = {};
  const globalSeverity: Record<string, number> = { '0': 0, '1': 0, '2': 0, '3': 0 };
  const schoolSummaries: Array<{
    schoolId: string;
    totalConversations: number;
    totalMessages: number;
    alertCount: number;
    severityHits: Record<string, number>;
    categories: Record<string, number>;
    lastUpdated: string;
  }> = [];

  // Process stats per school
  for (const blob of statBlobs) {
    const data = await statsStore.get(blob.key, { type: 'json' }) as any;
    if (!data) continue;
    const schoolId = blob.key.replace('stats/', '');

    const convos = data.totalConversations || 0;
    const msgs = data.totalMessages || 0;
    totalConversations += convos;
    totalMessages += msgs;

    if (data.categories) {
      Object.entries(data.categories).forEach(([cat, count]) => {
        globalCategories[cat] = (globalCategories[cat] || 0) + (count as number);
      });
    }
    if (data.severityHits) {
      Object.entries(data.severityHits).forEach(([sev, count]) => {
        globalSeverity[sev] = (globalSeverity[sev] || 0) + (count as number);
      });
    }

    schoolSummaries.push({
      schoolId,
      totalConversations: convos,
      totalMessages: msgs,
      alertCount: 0,
      severityHits: data.severityHits || {},
      categories: data.categories || {},
      lastUpdated: data.lastUpdated || ''
    });
  }

  // Process alerts per school
  let totalAlerts = 0;
  const allAlertsBySchool: Record<string, any[]> = {};

  for (const blob of alertBlobs) {
    const data = await statsStore.get(blob.key, { type: 'json' }) as any[];
    if (!data) continue;
    const schoolId = blob.key.replace('alerts/', '');
    allAlertsBySchool[schoolId] = data;
    totalAlerts += data.length;

    // Merge alert count into matching school summary
    const summary = schoolSummaries.find(s => s.schoolId === schoolId);
    if (summary) {
      summary.alertCount = data.length;
    }
  }

  // --- Top categories (sorted descending) ---
  const topCategories = Object.entries(globalCategories)
    .sort((a, b) => b[1] - a[1])
    .map(([category, count]) => ({ category, count }));

  // --- Severity breakdown ---
  const severityBreakdown = Object.entries(globalSeverity)
    .map(([level, count]) => ({ level, count }));

  // --- Risk schools: those with severity-3 hits or high alert counts ---
  const riskSchools = schoolSummaries
    .filter(s => {
      const sev3 = s.severityHits['3'] || 0;
      return sev3 > 0 || s.alertCount > 10;
    })
    .sort((a, b) => {
      const aSev3 = a.severityHits['3'] || 0;
      const bSev3 = b.severityHits['3'] || 0;
      return bSev3 - aSev3 || b.alertCount - a.alertCount;
    })
    .map(s => ({
      schoolId: s.schoolId,
      severity3Count: s.severityHits['3'] || 0,
      alertCount: s.alertCount,
      totalConversations: s.totalConversations
    }));

  // --- Recommendations ---
  const recommendations: string[] = [];

  if (globalSeverity['3'] > 0) {
    recommendations.push(
      `URGENT: ${globalSeverity['3']} severity-3 incidents detected. Immediate review required.`
    );
  }
  if (riskSchools.length > 0) {
    recommendations.push(
      `${riskSchools.length} school(s) flagged as high-risk. Prioritize outreach and support.`
    );
  }
  if (totalAlerts > 50) {
    recommendations.push(
      `High alert volume (${totalAlerts} total). Consider reviewing alert thresholds or escalation policies.`
    );
  }
  if (globalSeverity['2'] > globalSeverity['1']) {
    recommendations.push(
      'Severity-2 incidents exceed severity-1. Review whether early intervention measures are effective.'
    );
  }
  if (topCategories.length > 0) {
    recommendations.push(
      `Top concern category: "${topCategories[0].category}" with ${topCategories[0].count} occurrences. Consider targeted resources.`
    );
  }
  if (recommendations.length === 0) {
    recommendations.push('No critical issues detected. Continue monitoring.');
  }

  // --- Build the report ---
  const reportDate = new Date().toISOString().split('T')[0];
  const report = {
    date: reportDate,
    generatedAt: new Date().toISOString(),
    summary: {
      totalSchools: statBlobs.length,
      totalConversations,
      totalMessages,
      totalAlerts
    },
    topCategories,
    severityBreakdown,
    schoolSummaries,
    riskSchools,
    recommendations
  };

  // --- Store the report and set as latest ---
  const reportKey = `report-${reportDate}`;
  await reportsStore.setJSON(reportKey, report);
  await reportsStore.setJSON('_latest', report);
  console.log(`Report stored: ${reportKey}`);

  // --- Prune old reports (keep last 90) ---
  const { blobs: existingReports } = await reportsStore.list();
  const sortedKeys = existingReports
    .map(b => b.key)
    .sort()
    .reverse();

  if (sortedKeys.length > MAX_REPORTS) {
    const toDelete = sortedKeys.slice(MAX_REPORTS);
    for (const key of toDelete) {
      await reportsStore.delete(key);
      console.log(`Deleted old report: ${key}`);
    }
  }

  console.log(`Daily report complete. ${sortedKeys.length} reports in store.`);
  } catch (error: any) {
    console.error('[SCHEDULED-REPORT] Error:', error?.message || error);
  }
};

export const config: Config = {
  schedule: '@daily'
};
