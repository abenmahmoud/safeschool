import type { Context } from "@netlify/functions";
function b64u(s:string){return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');}
async function signJWT(p:object,sec:string):Promise<string>{
  const h=b64u(JSON.stringify({alg:'HS256',typ:'JWT'}));const b=b64u(JSON.stringify(p));const m=h+'.'+b;
  const k=await crypto.subtle.importKey('raw',new TextEncoder().encode(sec),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const s=await crypto.subtle.sign('HMAC',k,new TextEncoder().encode(m));
  return m+'.'+b64u(String.fromCharCode(...new Uint8Array(s)));
}
function cors(d:any,s=200){return new Response(JSON.stringify(d),{status:s,headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type'}});}
export default async(req:Request,_ctx:Context)=>{
  if(req.method==='OPTIONS')return cors({});
  if(req.method!=='POST')return cors({error:'Method not allowed'},405);
  const SECRET=Netlify.env.get('ADMIN_JWT_SECRET')||'safeschool_change_me';
  const SU=Netlify.env.get('aSUPABASE_URL')||Netlify.env.get('SUPABASE_URL')||'';
  const SK=Netlify.env.get('SUPABASE_SERVICE_ROLE_KEY')||'';
  let body:any={};try{body=await req.json();}catch{return cors({error:'Corps invalide'},400);}
  const slug=String(body.slug||'').toLowerCase().trim();
  const admin_code=String(body.admin_code||'').trim();
  if(!slug||!admin_code)return cors({error:'Slug et code requis'},400);
  const r=await fetch(SU+'/rest/v1/schools?slug=eq.'+encodeURIComponent(slug)+'&select=id,name,slug,is_active,admin_code,plan_code',{headers:{'apikey':SK,'Authorization':'Bearer '+SK}});
  const schools:any[]=await r.json();
  if(!schools?.length||!schools[0].is_active)return cors({error:'Etablissement non trouve'},404);
  const school=schools[0];
  if(!school.admin_code||admin_code!==school.admin_code)return cors({error:'Code incorrect'},401);
  const token=await signJWT({slug,school_id:school.id,school_name:school.name,plan:school.plan_code||'standard',role:'admin',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+86400},SECRET);
  return new Response(JSON.stringify({ok:true,token,school_name:school.name,role:'admin'}),{status:200,headers:{'Content-Type':'application/json','Set-Cookie':'ss_admin_token='+token+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400','Access-Control-Allow-Origin':'*'}});
};
export const config={path:'/api/admin/login'};