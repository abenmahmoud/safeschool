import type { Context } from '@netlify/edge-functions';

const TENANT_BASE_DOMAIN = Netlify.env.get('TENANT_BASE_DOMAIN') || 'app.safeschool.fr';

function extractHost(req: Request): string {
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || new URL(req.url).hostname;
  return host.split(':')[0].toLowerCase();
}

function isTenantHost(host: string): boolean {
  return host !== TENANT_BASE_DOMAIN && host.endsWith(`.${TENANT_BASE_DOMAIN}`);
}

function getTenantSlug(host: string): string | null {
  if (!isTenantHost(host)) return null;
  const suffix = `.${TENANT_BASE_DOMAIN}`;
  const slug = host.slice(0, -suffix.length).trim();
  return /^[a-z0-9-]+$/.test(slug) ? slug : null;
}

export default async (request: Request, context: Context) => {
  const host = extractHost(request);
  const tenantSlug = getTenantSlug(host);

  if (!tenantSlug) {
    return context.next();
  }

  const url = new URL(request.url);
  url.hostname = TENANT_BASE_DOMAIN;

  if (!url.searchParams.has('__tenant')) {
    url.searchParams.set('__tenant', tenantSlug);
  }

  const headers = new Headers(request.headers);
  headers.set('x-tenant-slug', tenantSlug);
  headers.set('x-original-host', host);

  const rewrittenRequest = new Request(url.toString(), {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    redirect: 'manual',
  });

  return context.rewrite(url.toString(), { request: rewrittenRequest });
};

export const config = {
  path: '/*',
};
