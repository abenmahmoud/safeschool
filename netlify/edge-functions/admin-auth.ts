import type { Config, Context } from "@netlify/edge-functions";

export default async (request: Request, context: Context) => {
  const url = new URL(request.url);
  
  // Pages publiques — pas de vérification
  if (url.pathname === '/admin/login' || url.pathname === '/admin/login.html') {
    return context.next();
  }
  
  // Vérifier le cookie JWT
  const cookie = request.headers.get('cookie') || '';
  const tokenMatch = cookie.match(/ss_admin_token=([^;\s]+)/);
  if (!tokenMatch) {
    return Response.redirect(new URL('/admin/login', request.url), 302);
  }
  
  const token = tokenMatch[1];
  
  // Vérifier que le token JWT est structurellement valide et non expiré
  try {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('invalid');
    const payload = JSON.parse(atob(parts[1].replace(/-/g,'+').replace(/_/g,'/')));
    if (!payload.slug || !payload.school_id) throw new Error('missing fields');
    if (payload.exp < Math.floor(Date.now() / 1000)) throw new Error('expired');
    return context.next();
  } catch {
    return Response.redirect(new URL('/admin/login', request.url), 302);
  }
};

export const config: Config = {
  path: "/admin/*",
  excludedPath: ["/admin/login", "/admin/login.html"]
};