import type { Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
async function verifyJWT(token:string,sec:string):Promise<any|null>{
  try{const[h,p,s]=token.split('.');if(!h||!p||!s)return null;
  const k=await crypto.subtle.importKey('raw',new TextEncoder().encode(sec),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  const sb=Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
  const ok=await crypto.subtle.verify('HMAC',k,sb,new TextEncoder().encode(h+'.'+p));
  if(!ok)return null;const d=JSON.parse(atob(p.replace(/-/g,'+').replace(/_/g,'/')));
  if(d.exp<Math.floor(Date.now()/1000))return null;return d;}catch{return null;}}
function cors(d:any,s=200){return new Response(JSON.stringify(d),{status:s,headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization'}});}
export default async(req:Request,context:Context)=>{
  if(req.method==='OPTIONS')return cors({});
  const SECRET=Netlify.env.get('ADMIN_JWT_SECRET')||'safeschool_change_me';
  const SU=Netlify.env.get('aSUPABASE_URL')||Netlify.env.get('SUPABASE_URL')||'';
  const SK=Netlify.env.get('SUPABASE_SERVICE_ROLE_KEY')||'';
  const SA='c3VwZXJhZG1pbkBzYWZlc2Nob29sLmZyOlNhZmVTY2hvb2wyMDI1IUAjU0E=';
  
  // Vérifier JWT dans header Authorization
  const auth=req.headers.get('Authorization')||'';
  const token=auth.replace('Bearer ','');
  const payload=await verifyJWT(token,SECRET);
  const isSA=token===SA;
  if(!payload&&!isSA)return cors({error:'Non autorisé'},401);
  
  const url=new URL(req.url);
  const path=url.pathname.replace('/api/establishments/reports','');
  
  if(req.method==='GET'&&path.startsWith('/')){
    const slug=path.replace('/','').split('?')[0];
    if(!slug)return cors({error:'Slug requis'},400);
    // Vérifier que le JWT correspond à ce slug
    if(payload&&payload.slug!==slug&&!isSA)return cors({error:'Accès refusé'},403);
    const store=getStore('safeschool-data');
    const idx=((await store.get('_index',{type:'json'}))||[]) as any[];
    const ent=idx.find((e:any)=>e.slug===slug);
    if(!ent?.id)return cors({error:'Etablissement non trouvé'},404);
    const status=url.searchParams.get('status')||'';
    const type=url.searchParams.get('type')||'';
    let q=`${SU}/rest/v1/reports?school_id=eq.${ent.id}&order=created_at.desc&limit=200`;
    if(status)q+=`&status=eq.${status}`;
    if(type)q+=`&type=eq.${type}`;
    const r=await fetch(q,{headers:{'apikey':SK,'Authorization':'Bearer '+SK}});
    if(!r.ok)return cors({error:'Erreur lecture'},500);
    const data=await r.json();
    return cors({ok:true,reports:data,total:data.length});
  }
  
  if(req.method==='POST'&&path.startsWith('/update/')){
    const slug=path.replace('/update/','').split('?')[0];
    if(payload&&payload.slug!==slug&&!isSA)return cors({error:'Accès refusé'},403);
    let body:any={};try{body=await req.json();}catch{return cors({error:'Invalide'},400);}
    const{report_id,status,admin_reply,admin_note}=body;
    if(!report_id)return cors({error:'report_id requis'},400);
    const updates:any={updated_at:new Date().toISOString()};
    if(status)updates.status=status;
    if(admin_reply!==undefined)updates.admin_reply=admin_reply;
    if(admin_note!==undefined)updates.admin_note=admin_note;
    const r=await fetch(`${SU}/rest/v1/reports?id=eq.${report_id}`,{method:'PATCH',headers:{'apikey':SK,'Authorization':'Bearer '+SK,'Content-Type':'application/json','Prefer':'return=minimal'},body:JSON.stringify(updates)});
    if(!r.ok)return cors({error:'Erreur mise à jour'},500);
    return cors({ok:true});
  }
  
  return cors({error:'Route non trouvée'},404);
};
export const config={path:['/api/establishments/reports/*','/api/establishments/reports']};