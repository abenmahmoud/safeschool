
// SafeSchool Dashboard V4 PRO UI
console.log("[SafeSchool] Dashboard V4 PRO UI loaded");

const db = window.ssSupabase || window.supabase.createClient(window.ENV_SUPABASE_URL, window.ENV_SUPABASE_KEY);

const DASH = {
  currentTab: 'reports',
  filterStatus: 'all',
  search: '',
  planCode: 'standard',
  stats: null
};

function dashRoleLabel(role){
  return { cpe:'CPE', dir:'Direction', inf:'Infirmier·e', ref:'Référent', psy:'Psychologue', autre:'Autre' }[role] || role || 'Autre';
}
function dashRoleEmoji(role){
  return { cpe:'🎓', dir:'💼', inf:'🏥', ref:'🛡️', psy:'🧠', autre:'👤' }[role] || '👤';
}
function dashStatusBadge(status){
  const map = { new:['Nouveau','tag-nouveau'], in_progress:['En cours','tag-en-cours'], resolved:['Traité','tag-traite'], archived:['Archivé','tag-archive'] };
  const v = map[status] || map.new;
  return `<span class="tag ${v[1]}">${v[0]}</span>`;
}
function dashTypeBadge(t){
  const ui = t || 'other';
  const label = { physical:'Physique', verbal:'Verbal', cyber:'Cyber', exclusion:'Exclusion', other:'Autre' }[ui] || 'Autre';
  return `<span class="tag tag-${ui}">${label}</span>`;
}
function dashUrgencyText(v){
  const ui = typeof v === 'number' ? v : ({faible:1,moyenne:2,haute:3}[v] || 1);
  return ui === 3 ? '<span class="urg-haute">Urgent</span>' : ui === 2 ? '<span class="urg-moyenne">Sérieux</span>' : '<span class="urg-faible">Normal</span>';
}
function dashCanAssign(){ return (DASH.planCode || 'standard') === 'max'; }
async function dashLoadPlan(){
  if (!currentEtab || !currentEtab.id) return 'standard';
  try{
    const { data } = await db.from('schools').select('plan_code').eq('id', currentEtab.id).maybeSingle();
    DASH.planCode = (data && data.plan_code) || currentEtab.planCode || 'standard';
    currentEtab.planCode = DASH.planCode;
  }catch(e){
    DASH.planCode = (currentEtab && currentEtab.planCode) || 'standard';
  }
  return DASH.planCode;
}
async function dashRefreshAll(){
  await Promise.all([S.reloadReports(), S.reloadStaff(), S.reloadLogs(), dashLoadPlan()]);
  renderDashboardV3();
}
function dashBuildStats(reports){
  const total = reports.length;
  const urgent = reports.filter(r => r.urgency === 3).length;
  const newer = reports.filter(r => r.status === 'new').length;
  const progress = reports.filter(r => r.status === 'in_progress').length;
  const resolved = reports.filter(r => r.status === 'resolved').length;
  const archived = reports.filter(r => r.status === 'archived').length;
  const assigned = reports.filter(r => !!r.assignedTo).length;
  const pctResolved = total ? Math.round((resolved / total) * 100) : 0;
  DASH.stats = {total, urgent, newer, progress, resolved, archived, assigned, pctResolved};
}
function renderDashboardV3(){
  const reports = S.reports();
  dashBuildStats(reports);
  const s = DASH.stats;
  document.getElementById('dashboard-body').innerHTML = `
    <div class="dash-top">
      <div>
        <h1>Administration</h1>
        <p>${currentEtab ? currentEtab.name : 'Établissement'} · Plan ${String(DASH.planCode || 'standard').toUpperCase()}</p>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-ghost btn-sm" style="background:rgba(255,255,255,.12);border-color:rgba(255,255,255,.2);color:#fff" onclick="dashRefreshAll()">↻ Actualiser</button>
        <button class="btn btn-ghost btn-sm" style="background:rgba(255,255,255,.12);border-color:rgba(255,255,255,.2);color:#fff" onclick="adminLogout()">Déconnexion</button>
      </div>
    </div>

    <div class="dash-kpi-grid">
      ${dashKpiCard('📌', s.total, 'Signalements', '#4f46e5', 'neu', `${s.newer} nouveaux`)}
      ${dashKpiCard('🚨', s.urgent, 'Urgents', '#dc2626', s.urgent > 0 ? 'up' : 'neu', 'À traiter')}
      ${dashKpiCard('⏳', s.progress, 'En cours', '#d97706', 'neu', `${s.assigned} assignés`)}
      ${dashKpiCard('✅', s.resolved, 'Traités', '#059669', 'up', `${s.pctResolved}% résolus`)}
    </div>

    <div class="dash-tabs">
      <button class="dtb ${DASH.currentTab==='reports'?'active':''}" onclick="dashSwitchTab('reports',this)">📋 Incidents</button>
      <button class="dtb ${DASH.currentTab==='team'?'active':''}" onclick="dashSwitchTab('team',this)">👥 Équipe</button>
      <button class="dtb ${DASH.currentTab==='logs'?'active':''}" onclick="dashSwitchTab('logs',this)">📜 Journal</button>
    </div>

    <div style="background:#fff;border:1px solid var(--border);border-top:none;margin:0 20px;border-radius:0 0 var(--r16) var(--r16);min-height:320px">
      <div id="dt-reports" class="dtab ${DASH.currentTab==='reports'?'active':''}">${dashRenderReportsTab()}</div>
      <div id="dt-team" class="dtab ${DASH.currentTab==='team'?'active':''}">${dashRenderTeamTab()}</div>
      <div id="dt-logs" class="dtab ${DASH.currentTab==='logs'?'active':''}">${dashRenderLogsTab()}</div>
    </div>
    <div style="height:18px"></div>
  `;
}
function dashKpiCard(icon, num, label, color, trendClass, trendLabel){
  return `<div class="kpi-card" style="--kpi-color:${color}"><div class="kpi-icon">${icon}</div><div class="kpi-label">${label}</div><div class="kpi-num">${num}</div><div class="kpi-trend ${trendClass}">${trendLabel}</div></div>`;
}
function dashSwitchTab(tab, btn){
  DASH.currentTab = tab;
  document.querySelectorAll('.dtb').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  document.querySelectorAll('#dashboard-body .dtab').forEach(t => t.classList.remove('active'));
  const target = document.getElementById('dt-' + tab);
  if (target) target.classList.add('active');
}
function dashFilteredReports(){
  let reports = [].concat(S.reports());
  if (DASH.filterStatus !== 'all') reports = reports.filter(r => r.status === DASH.filterStatus);
  const q = (DASH.search || '').trim().toLowerCase();
  if (q.length >= 3){
    reports = reports.filter(r => [r.caseNumber, r.code, r.description, r.location, r.staffReply, r.staffNotes].filter(Boolean).some(v => String(v).toLowerCase().includes(q)));
  }
  return reports;
}
function dashRenderReportsTab(){
  const reports = dashFilteredReports();
  const countText = `${reports.length} dossier${reports.length>1?'s':''}`;
  return `
    <div style="padding:14px 14px 8px">
      <div class="sbar" style="margin:0">
        <input class="search-in" type="text" value="${escapeHtml(DASH.search)}" placeholder="🔎 Rechercher (min. 3 lettres)" oninput="dashOnSearch(this.value)">
        <select class="filter-sel" onchange="dashSetFilter(this.value)">
          <option value="all" ${DASH.filterStatus==='all'?'selected':''}>Tous</option>
          <option value="new" ${DASH.filterStatus==='new'?'selected':''}>Nouveaux</option>
          <option value="in_progress" ${DASH.filterStatus==='in_progress'?'selected':''}>En cours</option>
          <option value="resolved" ${DASH.filterStatus==='resolved'?'selected':''}>Traités</option>
          <option value="archived" ${DASH.filterStatus==='archived'?'selected':''}>Archives</option>
        </select>
      </div>
      <div style="font-size:.78rem;color:var(--ts);padding:8px 6px 0">${countText}${(DASH.search||'').trim().length>0 && (DASH.search||'').trim().length<3 ? ' · saisis 3 lettres minimum pour lancer la recherche' : ''}</div>
    </div>
    <div class="rlist" style="padding-bottom:16px">
      ${reports.length ? reports.map((r, idx) => dashReportCard(r, idx)).join('') : `<div style="text-align:center;padding:38px 20px;color:var(--ts)"><div style="font-size:2.2rem;margin-bottom:8px">📭</div><p>Aucun incident trouvé.</p></div>`}
    </div>
  `;
}
function dashReportCard(r, idx){
  const staff = S.staff();
  const assigned = r.assignedTo ? staff.find(s => s.id === r.assignedTo) : null;
  const uniqueId = `dash-${idx}-${r.id}`;
  const canAssign = dashCanAssign();
  return `
    <div class="ri ${r.urgency===3?'urg':''}" id="card-${uniqueId}">
      <div class="ri-head" onclick="dashToggleCard('${uniqueId}')">
        <div class="ri-meta">
          <div class="ri-tags">
            ${dashStatusBadge(r.status)}
            ${dashTypeBadge(r.harassmentType)}
            ${dashUrgencyText(r.urgency)}
          </div>
          <div class="ri-desc">${escapeHtml((r.description || 'Sans description').slice(0, 110))}</div>
          <div class="ri-sub">
            <span>🗂️ ${escapeHtml(r.caseNumber || 'N/A')}</span>
            <span>·</span>
            <span>📍 ${escapeHtml(r.location || 'Lieu non précisé')}</span>
            ${assigned ? `<span>· 👤 ${escapeHtml(assigned.name)}</span>` : ''}
          </div>
        </div>
        <div class="ri-date">${fmtDate(r.createdAt, true)}<br><span style="color:var(--ts)">${fmtTime(r.createdAt)}</span></div>
      </div>
      <div class="ri-expand" id="expand-${uniqueId}">
        <h5>Description complète</h5>
        <p>${escapeHtml(r.description || 'Sans description')}</p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px">
          <div style="background:var(--bg);border-radius:12px;padding:12px">
            <h5 style="margin:0 0 6px 0">Suivi</h5>
            <p style="font-size:.82rem">Code : <strong>${escapeHtml(r.code || '—')}</strong></p>
            <p style="font-size:.82rem">Dossier : <strong>${escapeHtml(r.caseNumber || '—')}</strong></p>
          </div>
          <div style="background:var(--bg);border-radius:12px;padding:12px">
            <h5 style="margin:0 0 6px 0">Déclarant</h5>
            <p style="font-size:.82rem">${r.isAnonymous ? 'Anonyme' : escapeHtml(r.reporterName || 'Identifié')}</p>
            ${!r.isAnonymous && r.reporterEmail ? `<p style="font-size:.82rem">${escapeHtml(r.reporterEmail)}</p>` : ''}
          </div>
        </div>
        <h5>Réponse visible au déclarant</h5>
        <textarea class="fta" id="reply-${uniqueId}" placeholder="Cette réponse sera visible dans l’espace Mon dossier" style="min-height:82px">${escapeHtml(r.staffReply || '')}</textarea>
        <h5>Remarque interne</h5>
        <textarea class="fta" id="note-${uniqueId}" placeholder="Visible seulement par l'équipe" style="min-height:76px">${escapeHtml(r.staffNotes || '')}</textarea>
        <h5>Statut</h5>
        <div class="st-btns">
          <button class="st-btn" style="background:#dbeafe;color:#1d4ed8" onclick="dashSetStatus('${r.id}','new')">Nouveau</button>
          <button class="st-btn" style="background:#fef9c3;color:#a16207" onclick="dashSetStatus('${r.id}','in_progress')">En cours</button>
          <button class="st-btn" style="background:#dcfce7;color:#166534" onclick="dashSetStatus('${r.id}','resolved')">Traité</button>
          <button class="st-btn" style="background:#f1f5f9;color:#475569" onclick="dashSetStatus('${r.id}','archived')">Archiver</button>
        </div>
        <h5>Attribution ${canAssign ? '' : '<span style="font-weight:400;color:var(--ts)">· réservé au plan MAX</span>'}</h5>
        ${canAssign ? `<select class="fsel" id="assign-${uniqueId}" onchange="dashAssign('${r.id}', this.value)"><option value="">Non assigné</option>${S.staff().filter(s => s.active !== false).map(s => `<option value="${s.id}" ${r.assignedTo===s.id?'selected':''}>${dashRoleEmoji(s.role)} ${escapeHtml(s.name)} · ${escapeHtml(dashRoleLabel(s.role))}</option>`).join('')}</select>` : `<div style="background:var(--abg);color:var(--a);border-radius:12px;padding:12px;font-size:.82rem">Active le plan MAX pour attribuer les incidents à des membres de l’équipe.</div>`}
        <div class="ri-acts">
          <button class="btn btn-sm btn-soft" onclick="dashSaveReport('${r.id}', '${uniqueId}')">💾 Sauvegarder</button>
          <button class="btn btn-sm btn-ghost" onclick="dashToggleCard('${uniqueId}')">Fermer</button>
        </div>
      </div>
    </div>
  `;
}
function dashOnSearch(v){ DASH.search = v; document.getElementById('dt-reports').innerHTML = dashRenderReportsTab(); }
function dashSetFilter(v){ DASH.filterStatus = v; document.getElementById('dt-reports').innerHTML = dashRenderReportsTab(); }
function dashToggleCard(id){ const el = document.getElementById('card-' + id); if (el) el.classList.toggle('open'); }
async function dashSaveReport(reportId, uid){
  const report = S.reports().find(r => r.id === reportId);
  if (!report) return;
  report.staffReply = document.getElementById('reply-' + uid).value || '';
  report.staffNotes = document.getElementById('note-' + uid).value || '';
  await S.updateReport(report);
  await S.addLog(`Dossier ${report.caseNumber || report.id} mis à jour`, report.id);
  toast('Dossier sauvegardé', 'ok');
  await dashRefreshAll();
}
async function dashSetStatus(reportId, status){
  const report = S.reports().find(r => r.id === reportId);
  if (!report) return;
  report.status = status;
  await S.updateReport(report);
  await S.addLog(`Statut ${report.caseNumber || report.id} → ${status}`, report.id);
  toast('Statut mis à jour', 'ok');
  await dashRefreshAll();
}
async function dashAssign(reportId, staffId){
  if (!dashCanAssign()){ toast('Attribution réservée au plan MAX', 'err'); return; }
  const report = S.reports().find(r => r.id === reportId);
  if (!report) return;
  report.assignedTo = staffId || null;
  await S.updateReport(report);
  const assignee = S.staff().find(s => s.id === staffId);
  await S.addLog(`Assignation ${report.caseNumber || report.id} → ${assignee ? assignee.name : 'aucun'}`, report.id);
  toast(assignee ? `Attribué à ${assignee.name}` : 'Assignation retirée', 'ok');
  await dashRefreshAll();
}
function dashRenderTeamTab(){
  const staff = S.staff();
  return `
    <div style="padding:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <div>
          <h3 style="font-size:1rem">Équipe de traitement</h3>
          <p style="font-size:.8rem;color:var(--tm)">Membres qui peuvent gérer les dossiers de l’établissement.</p>
        </div>
        <button class="btn btn-p btn-sm" onclick="dashOpenStaffModal()">+ Ajouter</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:10px">
        ${staff.length ? staff.map(s => `
          <div class="staff-card">
            <div class="staff-av" style="background:${dashAvatarBg(s.role)}">${dashRoleEmoji(s.role)}</div>
            <div class="staff-info">
              <h3>${escapeHtml(s.name || 'Sans nom')}</h3>
              <p>${escapeHtml(s.email || 'Sans email')}</p>
              <span class="staff-badge ${dashRoleColor(s.role)}">${escapeHtml(dashRoleLabel(s.role))}</span>
              ${s.active === false ? `<span class="staff-badge" style="background:#f1f5f9;color:#64748b;margin-left:5px">Inactif</span>` : ''}
            </div>
            <div style="display:flex;flex-direction:column;gap:8px">
              <button class="btn btn-xs btn-soft" onclick="dashOpenStaffModal('${s.id}')">✏️</button>
              <button class="btn btn-xs btn-ghost" onclick="dashToggleStaff('${s.id}')">${s.active === false ? '▶' : '⏸'}</button>
            </div>
          </div>
        `).join('') : `<div style="text-align:center;padding:36px 20px;color:var(--ts)"><div style="font-size:2rem;margin-bottom:8px">👥</div><p>Aucun membre pour le moment.</p></div>`}
      </div>
    </div>
  `;
}
function dashAvatarBg(role){ return {cpe:'#eef2ff',dir:'#fffbeb',inf:'#ecfdf5',ref:'#f0f9ff',psy:'#fdf4ff',autre:'#f8fafc'}[role] || '#eef2ff'; }
function dashRoleColor(role){ return {cpe:'sr-cpe',dir:'sr-dir',inf:'sr-inf',ref:'sr-ref',psy:'sr-psy',autre:'sr-cpe'}[role] || 'sr-cpe'; }
function dashOpenStaffModal(id){
  const s = id ? S.staff().find(x => x.id === id) : null;
  document.body.insertAdjacentHTML('beforeend', `
    <div class="modal-overlay" id="dash-staff-modal" onclick="if(event.target===this)dashCloseStaffModal()">
      <div class="modal">
        <div class="mhandle"></div>
        <h3>${s ? 'Modifier un membre' : 'Ajouter un membre'}</h3>
        <div class="fg"><label class="fl">Nom complet *</label><input class="fi" id="dash-staff-name" value="${escapeHtml(s && s.name || '')}" placeholder="Mme Martin Sophie"></div>
        <div class="fg"><label class="fl">Email</label><input class="fi" id="dash-staff-email" value="${escapeHtml(s && s.email || '')}" placeholder="prenom.nom@lycee.fr"></div>
        <div class="fg">
          <label class="fl">Rôle *</label>
          <select class="fsel" id="dash-staff-role">
            <option value="cpe" ${(s && s.role==='cpe')?'selected':''}>CPE</option>
            <option value="dir" ${(s && s.role==='dir')?'selected':''}>Direction</option>
            <option value="inf" ${(s && s.role==='inf')?'selected':''}>Infirmier·e</option>
            <option value="ref" ${(s && s.role==='ref')?'selected':''}>Référent</option>
            <option value="psy" ${(s && s.role==='psy')?'selected':''}>Psychologue</option>
            <option value="autre" ${(s && s.role==='autre')?'selected':''}>Autre</option>
          </select>
        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost" style="flex:1" onclick="dashCloseStaffModal()">Annuler</button>
          <button class="btn btn-p" style="flex:2" onclick="dashSaveStaff('${(s && s.id) || ''}')">💾 ${(s ? 'Modifier' : 'Ajouter')}</button>
        </div>
      </div>
    </div>
  `);
}
function dashCloseStaffModal(){ const el = document.getElementById('dash-staff-modal'); if (el) el.remove(); }
async function dashSaveStaff(id){
  const name = (document.getElementById('dash-staff-name').value || '').trim();
  const email = (document.getElementById('dash-staff-email').value || '').trim();
  const role = document.getElementById('dash-staff-role').value || 'autre';
  if (!name){ toast('Nom obligatoire', 'err'); return; }
  try{
    if (id){
      const { error } = await db.from('staff').update({ full_name: name, email: email || null, role: role, is_active: true }).eq('id', id).eq('school_id', currentEtab.id);
      if (error) throw error;
      await S.addLog(`Membre modifié : ${name}`);
      toast('Membre mis à jour', 'ok');
    } else {
      const { error } = await db.from('staff').insert([{ school_id: currentEtab.id, full_name: name, email: email || null, role: role, is_active: true }]);
      if (error) throw error;
      await S.addLog(`Membre ajouté : ${name}`);
      toast('Membre ajouté', 'ok');
    }
    dashCloseStaffModal();
    await dashRefreshAll();
  }catch(e){
    console.error(e);
    toast(e.message || 'Impossible de sauvegarder le membre', 'err');
  }
}
async function dashToggleStaff(id){
  const member = S.staff().find(s => s.id === id);
  if (!member) return;
  try{
    const nextState = !(member.active !== false);
    const { error } = await db.from('staff').update({ is_active: nextState }).eq('id', id).eq('school_id', currentEtab.id);
    if (error) throw error;
    await S.addLog(`Membre ${member.name} ${nextState ? 'activé' : 'désactivé'}`);
    toast(nextState ? 'Membre activé' : 'Membre désactivé', 'ok');
    await dashRefreshAll();
  }catch(e){
    console.error(e);
    toast(e.message || 'Impossible de modifier ce membre', 'err');
  }
}
function dashRenderLogsTab(){
  const logs = S.logs();
  return `<div style="padding:14px">${logs.length ? logs.map(l => `<div class="alog-item"><div class="alog-dot"></div><div class="alog-text"><p>${escapeHtml(l.msg || '')}</p><span>${new Date(l.t).toLocaleString('fr-FR', {day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit'})}</span></div></div>`).join('') : `<div style="text-align:center;padding:38px 20px;color:var(--ts)"><div style="font-size:2rem;margin-bottom:8px">📜</div><p>Aucune activité enregistrée.</p></div>`}</div>`;
}
function escapeHtml(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(m){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[m]; });
}
window.renderDashboardV3 = renderDashboardV3;
window.dashSwitchTab = dashSwitchTab;
window.dashOnSearch = dashOnSearch;
window.dashSetFilter = dashSetFilter;
window.dashToggleCard = dashToggleCard;
window.dashSaveReport = dashSaveReport;
window.dashSetStatus = dashSetStatus;
window.dashAssign = dashAssign;
window.dashOpenStaffModal = dashOpenStaffModal;
window.dashCloseStaffModal = dashCloseStaffModal;
window.dashSaveStaff = dashSaveStaff;
window.dashToggleStaff = dashToggleStaff;
