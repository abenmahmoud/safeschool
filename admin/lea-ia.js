// lea-ia.js - Sprint 3: Lea IA dashboard page
(function(){
if(typeof SU==='undefined'||typeof SK==='undefined')return;
var LEA_API='https://bsytkpgdxvlddzuwaabp.supabase.co/functions/v1/lea-stats';

function addNav(){
  var nav=document.querySelector('.sb-nav');if(!nav||document.getElementById('nav-lea'))return;
  var btn=document.createElement('button');btn.className='sb-item';btn.id='nav-lea';
  btn.innerHTML="<span class='ico'>&#129302;</span>Lea IA";
  btn.onclick=function(){window.showPage('lea')};
  var settings=document.getElementById('nav-settings');
  if(settings)nav.insertBefore(btn,settings);else nav.appendChild(btn);
  var content=document.querySelector('.content');
  if(content&&!document.getElementById('page-lea')){
    var div=document.createElement('div');div.id='page-lea';div.style.display='none';
    content.appendChild(div);
  }
}

function hookShowPage(){
  var orig=window.showPage;if(!orig||orig._leaHooked)return;
  window.showPage=function(p){
    if(p==='lea'){
      var pages=['dashboard','reports','team','settings','lea'];
      pages.forEach(function(x){
        var el=document.getElementById('page-'+x);if(el)el.style.display=(x===p?'block':'none');
        var nb=document.getElementById('nav-'+x);if(nb)nb.classList.toggle('active',x===p);
      });
      var t=document.getElementById('page-title');if(t)t.textContent='Lea IA';
      loadLea();return;
    }
    orig(p);
    var nb=document.getElementById('nav-lea');if(nb)nb.classList.remove('active');
  };
  window.showPage._leaHooked=true;
}

function loadLea(){
  var pg=document.getElementById('page-lea');if(!pg)return;
  pg.innerHTML="<div style='padding:2rem;text-align:center;color:#6b7280'><div style='font-size:2rem'>&#129302;</div><p style='margin-top:.5rem'>Analyse IA en cours...</p></div>";
  fetch(LEA_API,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({school_id:_sid})})
  .then(function(r){return r.json()}).then(function(d){
    if(d.error){pg.innerHTML="<div style='padding:2rem;color:#dc2626'>Erreur: "+d.error+"</div>";return;}
    window._leaData=d;renderLea(pg,d);
  }).catch(function(e){pg.innerHTML="<div style='padding:2rem;color:#dc2626'>Erreur: "+e.message+"</div>"});
}

function gauge(score,color){
  var a=score/100*180,rad=(a-90)*Math.PI/180;
  var x=(80+60*Math.cos(rad)).toFixed(1),y=(85+60*Math.sin(rad)).toFixed(1);
  var la=a>90?1:0;
  var s='<svg viewBox="0 0 160 100" style="width:180px;height:110px">';
  s+='<path d="M20,85 A60,60 0 0,1 140,85" fill="none" stroke="#e5e7eb" stroke-width="14" stroke-linecap="round"/>';
  if(score>0)s+='<path d="M20,85 A60,60 0 '+la+',1 '+x+','+y+'" fill="none" stroke="'+color+'" stroke-width="14" stroke-linecap="round"/>';
  s+='<text x="80" y="75" text-anchor="middle" font-size="32" font-weight="700" fill="'+color+'">'+score+'</text>';
  s+='<text x="80" y="92" text-anchor="middle" font-size="11" fill="#6b7280">/100</text></svg>';
  return s;
}

function renderLea(pg,d){
  var s=d.stats,a=d.analysis,sc=d.riskScore,lvl=d.riskLevel;
  var cols={faible:'#059669',modere:'#d97706',eleve:'#ea580c',critique:'#dc2626'};
  var lbs={faible:'Faible',modere:'Modere',eleve:'Eleve',critique:'Critique'};
  var col=cols[lvl]||'#6b7280';
  var h='';
  h+="<div style='display:flex;align-items:center;gap:.75rem;margin-bottom:1.5rem'><span style='font-size:2.25rem'>&#129302;</span><div><h3 style='font-weight:700;font-size:1.15rem;margin:0'>Lea IA - Analyse intelligente</h3><p style='color:#6b7280;font-size:.8rem;margin:.1rem 0 0'>Analyse du "+new Date(d.generatedAt).toLocaleString('fr-FR')+"</p></div></div>";
  h+="<div style='display:grid;grid-template-columns:300px 1fr;gap:1.25rem;margin-bottom:1.25rem'>";
  h+="<div style='background:#fff;border-radius:14px;padding:1.5rem;border:1px solid #e5e7eb;text-align:center'>";
  h+="<p style='font-size:.7rem;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.08em;margin-bottom:1rem'>Barometre de risque</p>";
  h+=gauge(sc,col);
  h+="<div style='margin-top:.75rem'><span style='display:inline-block;padding:.35rem 1rem;border-radius:20px;font-size:.85rem;font-weight:700;background:"+col+"15;color:"+col+";text-transform:uppercase;letter-spacing:.05em'>"+(lbs[lvl]||lvl)+"</span></div></div>";
  h+="<div style='background:#fff;border-radius:14px;padding:1.5rem;border:1px solid #e5e7eb'>";
  h+="<p style='font-size:.7rem;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.08em;margin-bottom:.75rem'>Synthese</p>";
  h+="<p style='font-size:.95rem;line-height:1.6;color:#111'>"+a.summary+"</p>";
  if(a.alerts&&a.alerts.length>0){
    h+="<div style='margin-top:1rem;padding:.875rem;background:#fef2f2;border-radius:10px;border-left:3px solid #dc2626'>";
    h+="<p style='font-size:.7rem;font-weight:700;color:#991b1b;margin-bottom:.5rem;text-transform:uppercase;letter-spacing:.05em'>Alertes</p>";
    for(var i=0;i<a.alerts.length;i++)h+="<p style='font-size:.85rem;color:#991b1b;margin:.25rem 0;display:flex;gap:.4rem'><span>&#9888;&#65039;</span><span>"+a.alerts[i]+"</span></p>";
    h+="</div>";
  }
  h+="</div></div>";
  h+="<div style='display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:.75rem;margin-bottom:1.25rem'>";
  var items=[{v:s.total,l:'Total',c:'#111'},{v:s.nouveau,l:'Non traites',c:'#2563eb'},{v:s.enCours,l:'En cours',c:'#d97706'},{v:s.traites,l:'Resolus',c:'#059669'},{v:a.replyRate+'%',l:'Taux reponse',c:'#7c3aed'},{v:(d.avgResponseHours!=null?d.avgResponseHours+'h':'--'),l:'Delai moyen',c:'#6b7280'}];
  for(var j=0;j<items.length;j++){var si=items[j];h+="<div style='background:#fff;border-radius:12px;padding:1rem;border:1px solid #e5e7eb;text-align:center'><div style='font-size:1.6rem;font-weight:700;color:"+si.c+"'>"+si.v+"</div><div style='font-size:.7rem;color:#6b7280;margin-top:.25rem;text-transform:uppercase;letter-spacing:.05em'>"+si.l+"</div></div>";}
  h+="</div>";
  h+="<div style='display:grid;grid-template-columns:1fr 1fr;gap:1.25rem;margin-bottom:1.25rem'>";
  h+="<div style='background:#fff;border-radius:14px;padding:1.25rem;border:1px solid #e5e7eb'>";
  h+="<p style='font-size:.7rem;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.08em;margin-bottom:1rem'>Types de harcelement</p>";
  if(d.typeBreakdown&&d.typeBreakdown.length>0){
    var tcols={Physique:'#dc2626',Verbal:'#d97706',Cyber:'#2563eb',Exclusion:'#7c3aed',Autre:'#6b7280'};
    var mx=Math.max.apply(null,d.typeBreakdown.map(function(t){return t.count}));
    for(var k=0;k<d.typeBreakdown.length;k++){var tb=d.typeBreakdown[k];var pct=mx>0?Math.round(tb.count/mx*100):0;var tc=tcols[tb.type]||'#6b7280';h+="<div style='margin-bottom:.7rem'><div style='display:flex;justify-content:space-between;font-size:.85rem;margin-bottom:.3rem'><span style='font-weight:500'>"+tb.type+"</span><span style='font-weight:700'>"+tb.count+"</span></div><div style='height:10px;background:#f3f4f6;border-radius:5px;overflow:hidden'><div style='height:100%;width:"+pct+"%;background:"+tc+";border-radius:5px;transition:width .6s'></div></div></div>";}
  }else h+="<p style='color:#6b7280;font-size:.85rem'>Pas de donnees</p>";
  h+="</div>";
  h+="<div style='background:#fff;border-radius:14px;padding:1.25rem;border:1px solid #e5e7eb'>";
  h+="<p style='font-size:.7rem;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.08em;margin-bottom:1rem'>Evolution 6 derniers mois</p>";
  if(d.monthlyTrend&&d.monthlyTrend.length>0){
    var mx2=Math.max.apply(null,d.monthlyTrend.map(function(m){return m.count}));if(mx2===0)mx2=1;
    h+="<div style='display:flex;align-items:flex-end;gap:.5rem;height:130px;padding:0 .25rem'>";
    for(var m=0;m<d.monthlyTrend.length;m++){var mt=d.monthlyTrend[m];var bh=Math.max(mt.count/mx2*100,4);h+="<div style='flex:1;display:flex;flex-direction:column;align-items:center'><div style='font-size:.7rem;font-weight:700;color:#4f46e5;margin-bottom:.3rem;height:1rem'>"+(mt.count>0?mt.count:'')+"</div><div style='height:"+bh+"px;width:70%;background:linear-gradient(180deg,#4f46e5,#818cf8);border-radius:6px 6px 0 0'></div><div style='font-size:.65rem;color:#6b7280;margin-top:.5rem;font-weight:500'>"+mt.month+"</div></div>";}
    h+="</div>";
  }else h+="<p style='color:#6b7280;font-size:.85rem'>Pas de donnees</p>";
  h+="</div></div>";
  h+="<div style='background:#fff;border-radius:14px;padding:1.5rem;border:1px solid #e5e7eb;margin-bottom:1.25rem'>";
  h+="<p style='font-size:.7rem;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.08em;margin-bottom:1rem'>&#128161; Conseils personnalises</p>";
  for(var c=0;c<a.conseils.length;c++){h+="<div style='display:flex;gap:.75rem;align-items:flex-start;padding:.5rem 0;border-bottom:1px solid #f3f4f6'><span style='min-width:1.5rem;height:1.5rem;background:#4f46e515;color:#4f46e5;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:.75rem;flex-shrink:0'>"+(c+1)+"</span><p style='font-size:.9rem;color:#111;margin:0;line-height:1.5'>"+a.conseils[c]+"</p></div>";}
  h+="</div>";
  h+="<div style='text-align:center;margin:1.5rem 0 2rem'><button onclick='generateLeaPDF()' style='display:inline-flex;align-items:center;gap:.5rem;padding:.85rem 1.75rem;background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;border:none;border-radius:12px;font-size:.9rem;font-weight:600;cursor:pointer;box-shadow:0 4px 12px rgba(79,70,229,.25)'><span>&#128196;</span>Generer rapport PDF</button></div>";
  pg.innerHTML=h;
}

window.generateLeaPDF=function(){
  var d=window._leaData;if(!d){alert('Rechargez la page Lea IA');return;}
  var s=d.stats,a=d.analysis;
  var cols={faible:'#059669',modere:'#d97706',eleve:'#ea580c',critique:'#dc2626'};
  var rc=cols[d.riskLevel]||'#6b7280';
  var w=window.open('','_blank');
  var html='<!DOCTYPE html><html><head><meta charset="UTF-8"><title>'+a.reportTitle+'</title>';
  html+='<style>body{font-family:Arial,sans-serif;max-width:780px;margin:0 auto;padding:40px;color:#111;font-size:13px;line-height:1.5}h1{font-size:22px;color:#4f46e5;border-bottom:3px solid #4f46e5;padding-bottom:8px;margin-bottom:16px}h2{font-size:15px;color:#1a1a2e;margin-top:22px;border-bottom:1px solid #e5e7eb;padding-bottom:4px}.header{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}.logo{font-size:22px;font-weight:700;color:#4f46e5}.score-box{text-align:center;padding:16px 28px;border:3px solid;border-radius:12px;display:inline-block}.score-num{font-size:38px;font-weight:700;line-height:1}.stat-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:14px 0}.stat-item{background:#f8fafc;padding:10px;border-radius:8px;text-align:center;border:1px solid #e5e7eb}.stat-item .n{font-size:20px;font-weight:700}.stat-item .l{font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em}.alert{background:#fef2f2;border:1px solid #fecaca;padding:8px 12px;border-radius:6px;margin:4px 0;color:#991b1b;font-size:12px}.conseil{padding:8px 0;border-bottom:1px solid #f3f4f6;font-size:13px;display:flex;gap:10px}.conseil .num{min-width:20px;color:#4f46e5;font-weight:700}.footer{margin-top:28px;padding-top:12px;border-top:2px solid #e5e7eb;font-size:10px;color:#6b7280;text-align:center;line-height:1.5}@media print{body{padding:20px}}</style></head><body>';
  html+='<div class="header"><div class="logo">&#128737;&#65039; SafeSchool</div><div style="text-align:right;font-size:11px;color:#6b7280">'+new Date().toLocaleDateString('fr-FR',{day:'numeric',month:'long',year:'numeric'})+'</div></div>';
  html+='<h1>'+a.reportTitle+'</h1>';
  html+='<h2>Barometre de risque</h2><div style="text-align:center;margin:14px 0"><div class="score-box" style="border-color:'+rc+'"><div class="score-num" style="color:'+rc+'">'+d.riskScore+'/100</div><div style="font-size:11px;color:'+rc+';font-weight:700;text-transform:uppercase;margin-top:4px">Risque '+d.riskLevel+'</div></div></div>';
  html+='<h2>Synthese</h2><p>'+a.summary+'</p>';
  html+='<h2>Statistiques</h2><div class="stat-grid">';
  html+='<div class="stat-item"><div class="n">'+s.total+'</div><div class="l">Total</div></div>';
  html+='<div class="stat-item"><div class="n">'+s.nouveau+'</div><div class="l">Non traites</div></div>';
  html+='<div class="stat-item"><div class="n">'+s.enCours+'</div><div class="l">En cours</div></div>';
  html+='<div class="stat-item"><div class="n">'+s.traites+'</div><div class="l">Resolus</div></div>';
  html+='<div class="stat-item"><div class="n">'+a.replyRate+'%</div><div class="l">Taux reponse</div></div>';
  html+='<div class="stat-item"><div class="n">'+(d.avgResponseHours!=null?d.avgResponseHours+'h':'--')+'</div><div class="l">Delai moyen</div></div>';
  html+='</div>';
  if(d.typeBreakdown&&d.typeBreakdown.length){html+='<h2>Repartition par type</h2>';for(var i=0;i<d.typeBreakdown.length;i++)html+='<p style="margin:4px 0"><strong>'+d.typeBreakdown[i].type+':</strong> '+d.typeBreakdown[i].count+' signalement(s)</p>';}
  if(a.alerts&&a.alerts.length){html+='<h2>Alertes</h2>';for(var j=0;j<a.alerts.length;j++)html+='<div class="alert">&#9888;&#65039; '+a.alerts[j]+'</div>';}
  html+='<h2>Recommandations</h2>';for(var k=0;k<a.conseils.length;k++)html+='<div class="conseil"><span class="num">'+(k+1)+'.</span><span>'+a.conseils[k]+'</span></div>';
  html+='<div class="footer"><strong>Rapport genere automatiquement par SafeSchool Lea IA</strong><br>'+new Date().toLocaleString('fr-FR')+'<br><br>Ce document est confidentiel et destine uniquement au personnel autorise de l\'etablissement.<br>SafeSchool - Plateforme anti-harcelement scolaire</div>';
  html+='<scr'+'ipt>setTimeout(function(){window.print()},500)</scr'+'ipt>';
  html+='</body></html>';
  w.document.write(html);w.document.close();
};
function init(){addNav();hookShowPage();}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);
else init();
setTimeout(init,500);setTimeout(init,2000);
})();
