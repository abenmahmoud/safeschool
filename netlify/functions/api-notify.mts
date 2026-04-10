import { getStore } from '@netlify/blobs';
import type { Context, Config } from '@netlify/functions';
const SA_EMAIL = () => Netlify.env.get('SUPERADMIN_EMAIL') || '';
const SA_PASS  = () => Netlify.env.get('SUPERADMIN_PASS')  || '';
const RESEND_API_KEY = () => Netlify.env.get('RESEND_API_KEY') || '';
const FROM_EMAIL = () => Netlify.env.get('NOTIFY_FROM_EMAIL') || 'notifications@safeschool.fr';
const SITE_URL   = () => Netlify.env.get('URL') || 'https://darling-muffin-21eb90.netlify.app';
function cors(body: any, status = 200) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, x-sa-token', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' } });
}
function authCheck(req: Request): boolean {
  const token = req.headers.get('x-sa-token');
  if (!token) return false;
  try { return atob(token) === SA_EMAIL() + ':' + SA_PASS(); } catch { return false; }
}
function genId() { return 'ntf_' + Date.now() + '_' + Math.random().toString(36).slice(2,10); }
function todayKey() { return new Date().toISOString().slice(0,10); }
async function sendEmail(to: string, subject: string, html: string): Promise<{sent:boolean;id?:string;error?:string}> {
  const key = RESEND_API_KEY();
  if (!key) return { sent: false, error: 'RESEND_API_KEY not configured' };
  try {
    const res = await fetch('https://api.resend.com/emails', { method:'POST', headers:{'Authorization':'Bearer '+key,'Content-Type':'application/json'}, body: JSON.stringify({ from: 'SafeSchool <'+FROM_EMAIL()+'>', to:[to], subject, html }) });
    const data = await res.json() as any;
    if (!res.ok) return { sent:false, error: data?.message || 'Resend '+res.status };
    return { sent:true, id:data.id };
  } catch(e:any) { return { sent:false, error:e?.message }; }
}
function getNotifStore() { return getStore({ name:'notifications', consistency:'strong' }); }
interface NotifRec { id:string;type:string;schoolId?:string;recipient?:string;subject?:string;status:'sent'|'queued'|'skipped'|'failed';reason?:string;resend_id?:string;payload:any;email_preview?:string;created_at:string; }
async function storeNotif(r: NotifRec) {
  const s = getNotifStore();
  await s.setJSON(r.id, r);
  const dk = 'day_'+todayKey();
  const ids = ((await s.get(dk,{type:'json'}).catch(()=>null)) as string[]|null)??[];
  ids.push(r.id); await s.setJSON(dk,ids);
  if (r.schoolId) { const rk='rl_'+r.schoolId+'_'+todayKey(); const c=((await s.get(rk,{type:'json'}).catch(()=>null)) as number|null)??0; await s.setJSON(rk,c+1); }
}
async function isRL(sid:string) { const s=getNotifStore(); const c=((await s.get('rl_'+sid+'_'+todayKey(),{type:'json'}).catch(()=>null)) as number|null)??0; return c>=100; }
function wrap(title:string, body:string) {
  return '<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"></head><body style="margin:0;font-family:Arial,sans-serif;background:#f4f6f8;"><table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:24px auto;background:#fff;border-radius:8px;border:1px solid #e2e8f0;"><tr><td style="background:#1a56db;padding:20px 24px;color:#fff;font-size:20px;font-weight:bold;">🛡️ SafeSchool — '+title+'</td></tr><tr><td style="padding:24px;">'+body+'</td></tr><tr><td style="padding:16px 24px;font-size:12px;color:#94a3b8;border-top:1px solid #e2e8f0;"><a href="'+SITE_URL()+'" style="color:#1a56db;">Accéder à la plateforme</a></td></tr></table></body></html>';
}
function tplTest() { return { subject:'[SafeSchool] Test email ✅', html:wrap('Test OK','<p>✅ Resend opérationnel. Envoyé le '+new Date().toLocaleString('fr-FR')+'</p>') }; }
function tplWelcome(p:any) { return { subject:'[SafeSchool] Bienvenue — '+p.schoolName, html:wrap('Bienvenue!','<table style="width:100%;border-collapse:collapse;"><tr style="background:#f8fafc;"><td style="padding:10px;font-weight:bold;">Établissement</td><td style="padding:10px;">'+p.schoolName+'</td></tr><tr><td style="padding:10px;font-weight:bold;">Code admin</td><td style="padding:10px;font-family:monospace;font-size:16px;font-weight:bold;">'+p.adminCode+'</td></tr><tr style="background:#f8fafc;"><td style="padding:10px;font-weight:bold;">Plan</td><td style="padding:10px;">'+p.plan+'</td></tr><tr><td style="padding:10px;font-weight:bold;">URL</td><td style="padding:10px;"><a href="'+p.url+'" style="color:#1a56db;">'+p.url+'</a></td></tr></table><br><a href="'+p.url+'" style="display:inline-block;padding:12px 24px;background:#1a56db;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold;">Accéder →</a>') }; }
function tplNewReport(p:any) { const cols:any={haute:'#ef4444',moyenne:'#f59e0b',faible:'#22c55e'}; const c=cols[p.urgency]||'#64748b'; return { subject:'[SafeSchool] Nouveau signalement — Urgence '+p.urgency, html:wrap('Nouveau signalement','<table style="width:100%;border-collapse:collapse;"><tr style="background:#f8fafc;"><td style="padding:10px;font-weight:bold;">Référence</td><td style="padding:10px;">'+(p.reportId||'-')+'</td></tr><tr><td style="padding:10px;font-weight:bold;">Type</td><td style="padding:10px;">'+(p.type||'-')+'</td></tr><tr style="background:#f8fafc;"><td style="padding:10px;font-weight:bold;">Urgence</td><td style="padding:10px;"><span style="background:'+c+';color:#fff;padding:3px 10px;border-radius:12px;">'+(p.urgency||'-')+'</span></td></tr><tr><td style="padding:10px;font-weight:bold;">École</td><td style="padding:10px;">'+(p.schoolId||'-')+'</td></tr></table><br><a href="'+SITE_URL()+'/superadmin" style="display:inline-block;padding:12px 24px;background:#1a56db;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold;">Voir le dashboard →</a>') }; }
function tplStatusUpdate(p:any) { const l:any={nouveau:'Nouveau',en_cours:'En cours',traite:'Traité',archive:'Archivé'}; return { subject:'[SafeSchool] Signalement '+p.trackingCode+' — Mise à jour', html:wrap('Mise à jour','<p>Statut de <strong>'+p.trackingCode+'</strong>:</p><p style="font-size:20px;font-weight:bold;color:#1a56db;padding:16px;background:#eff6ff;border-radius:8px;">'+(l[p.newStatus]||p.newStatus)+'</p>') }; }
function tplStaffReply(p:any) { return { subject:'[SafeSchool] Réponse à '+p.trackingCode, html:wrap("Réponse de l'équipe",'<p>Réponse à <strong>'+p.trackingCode+'</strong>:</p><div style="background:#f1f5f9;padding:16px;border-radius:8px;border-left:4px solid #1a56db;">'+(p.message||'Consultez la plateforme.')+'</div>') }; }
function tplDigest(p:any) { const s=p.stats||{}; return { subject:'[SafeSchool] Résumé — '+new Date().toLocaleDateString('fr-FR'), html:wrap('Résumé quotidien','<table style="width:100%;border-collapse:collapse;"><tr style="background:#1a56db;color:#fff;"><td style="padding:10px;font-weight:bold;">Indicateur</td><td style="padding:10px;font-weight:bold;">Nb</td></tr><tr><td style="padding:10px;">Nouveaux signalements</td><td style="padding:10px;font-weight:bold;">'+(s.newReports??0)+'</td></tr><tr style="background:#f8fafc;"><td style="padding:10px;">Mises à jour</td><td style="padding:10px;font-weight:bold;">'+(s.statusUpdates??0)+'</td></tr><tr><td style="padding:10px;">Réponses</td><td style="padding:10px;font-weight:bold;">'+(s.replies??0)+'</td></tr></table>') }; }
export default async (req: Request, context: Context) => {
  if (req.method === 'OPTIONS') return cors({ ok:true });
  const url = new URL(req.url);
  const path = url.pathname.replace('/api/notify','');
  const hasResend = !!RESEND_API_KEY();
  try {
    if (req.method === 'GET' && path === '/history') {
      if (!authCheck(req)) return cors({ error:'Non autorisé' },401);
      const store=getNotifStore(); const day=url.searchParams.get('day')||todayKey();
      const ids=((await store.get('day_'+day,{type:'json'}).catch(()=>null)) as string[]|null)??[];
      const limit=Math.min(parseInt(url.searchParams.get('limit')||'50',10),200);
      const records:NotifRec[]=[]; for (const id of ids.slice(-limit).reverse()) { const r=await store.get(id,{type:'json'}).catch(()=>null) as NotifRec|null; if(r) records.push(r); }
      return cors({day,total:ids.length,showing:records.length,notifications:records});
    }
    if (req.method === 'GET' && path === '/stats') {
      if (!authCheck(req)) return cors({ error:'Non autorisé' },401);
      const store=getNotifStore(); const day=url.searchParams.get('day')||todayKey();
      const ids=((await store.get('day_'+day,{type:'json'}).catch(()=>null)) as string[]|null)??[];
      const byType:Record<string,number>={}; let sent=0,skipped=0,failed=0;
      for (const id of ids) { const r=await store.get(id,{type:'json'}).catch(()=>null) as NotifRec|null; if(!r) continue; byType[r.type]=(byType[r.type]||0)+1; if(r.status==='sent')sent++; else if(r.status==='skipped')skipped++; else if(r.status==='failed')failed++; }
      return cors({day,total:ids.length,sent,skipped,failed,by_type:byType,resend_active:hasResend});
    }
    if (req.method !== 'POST') return cors({ error:'Method not allowed' },405);
    const body = await req.json() as Record<string,any>;
    async function doSend(type:string, schoolId:string|undefined, recipient:string|undefined, tpl:{subject:string;html:string}, payload:any) {
      let result={sent:false,error:'no_recipient',id:undefined} as any;
      if (recipient) result = await sendEmail(recipient, tpl.subject, tpl.html);
      const id=genId();
      await storeNotif({ id, type, schoolId, recipient, subject:tpl.subject, status:result.sent?'sent':recipient?'failed':'skipped', reason:result.error, resend_id:result.id, payload, email_preview:tpl.html, created_at:new Date().toISOString() });
      return cors({id,sent:result.sent,resend_id:result.id,error:result.error,resend_active:hasResend});
    }
    if (path==='/test') { if(!authCheck(req)) return cors({error:'Non autorisé'},401); const r=body.email||SA_EMAIL(); if(!r) return cors({error:'Email requis'},400); return doSend('test',undefined,r,tplTest(),body); }
    if (path==='/welcome') { const {schoolName,adminCode,plan,url:su,adminEmail}=body; if(!adminEmail||!schoolName) return cors({error:'adminEmail et schoolName requis'},400); return doSend('welcome',body.schoolId,adminEmail,tplWelcome({schoolName,adminCode,plan,url:su}),body); }
    if (path==='/new-report') { const {schoolId,reportId,urgency,type,adminEmail}=body; if(!schoolId) return cors({error:'schoolId requis'},400); if(await isRL(schoolId)) return cors({error:'Rate limit 100/jour atteint'},429); return doSend('new-report',schoolId,adminEmail,tplNewReport({schoolId,reportId,urgency,type}),body); }
    if (path==='/status-update') { const {trackingCode,newStatus,email,schoolId}=body; if(!email) return cors({id:null,sent:false,reason:'no_email'}); const sid=schoolId||'unknown'; if(await isRL(sid)) return cors({error:'Rate limit'},429); return doSend('status-update',sid,email,tplStatusUpdate({trackingCode,newStatus}),body); }
    if (path==='/staff-reply') { const {trackingCode,email,message,schoolId}=body; if(!email) return cors({id:null,sent:false,reason:'no_email'}); const sid=schoolId||'unknown'; if(await isRL(sid)) return cors({error:'Rate limit'},429); return doSend('staff-reply',sid,email,tplStaffReply({trackingCode,message}),body); }
    if (path==='/digest') {
      if(!authCheck(req)) return cors({error:'Non autorisé'},401);
      const {schoolId,adminEmail}=body; if(!schoolId) return cors({error:'schoolId requis'},400);
      const store=getNotifStore(); const ids=((await store.get('day_'+todayKey(),{type:'json'}).catch(()=>null)) as string[]|null)??[];
      let nr=0,su=0,rp=0; for (const nid of ids) { const r=await store.get(nid,{type:'json'}).catch(()=>null) as NotifRec|null; if(!r||r.schoolId!==schoolId) continue; if(r.type==='new-report')nr++; else if(r.type==='status-update')su++; else if(r.type==='staff-reply')rp++; }
      const stats={total:nr+su+rp,newReports:nr,statusUpdates:su,replies:rp};
      return doSend('digest',schoolId,adminEmail,tplDigest({schoolId,stats}),{schoolId,stats});
    }
    return cors({ error:'Route inconnue' },404);
  } catch(e:any) { console.error('[NOTIFY]',e?.message); return cors({error:'Requête invalide',detail:e?.message},400); }
};
export const config: Config = { path:'/api/notify/*' };
