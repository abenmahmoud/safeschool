// ==========================================================================
// SafeSchool — Shared Security Library
// Centralized: CORS, Auth, Rate Limiting, Input Sanitization, Validation
// ==========================================================================

// ---------------------------------------------------------------------------
// Allowed Origins (strict CORS)
// ---------------------------------------------------------------------------
const ALLOWED_ORIGINS: string[] = [
  'https://darling-muffin-21eb90.netlify.app',
  Netlify.env.get('SITE_URL') || '',
  Netlify.env.get('DEPLOY_PRIME_URL') || '',
  Netlify.env.get('URL') || '',
].filter(Boolean);

const SAFESCHOOL_ORIGIN_RE = /^https:\/\/[a-z0-9-]+\.safeschool\.(fr|com|net)$/;
const NETLIFY_PREVIEW_RE = /^https:\/\/[a-z0-9-]+--darling-muffin-21eb90\.netlify\.app$/;

export function getAllowedOrigin(req: Request): string {
  const origin = req.headers.get('origin') || '';
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  if (SAFESCHOOL_ORIGIN_RE.test(origin)) return origin;
  if (NETLIFY_PREVIEW_RE.test(origin)) return origin;
  return ALLOWED_ORIGINS[0] || 'https://darling-muffin-21eb90.netlify.app';
}

// ---------------------------------------------------------------------------
// CORS Response Helper
// ---------------------------------------------------------------------------
export interface CorsOptions {
  methods?: string;
  extraHeaders?: string;
  contentType?: string;
}

export function corsResponse(
  body: any,
  status: number,
  req: Request,
  options: CorsOptions = {}
): Response {
  const allowedOrigin = getAllowedOrigin(req);
  const contentType = options.contentType || 'application/json';
  const methods = options.methods || 'GET, POST, OPTIONS';
  const headers = options.extraHeaders
    ? `Content-Type, x-sa-token, x-csrf-token, Authorization, ${options.extraHeaders}`
    : 'Content-Type, x-sa-token, x-csrf-token, Authorization';

  const responseBody = typeof body === 'string' ? body : JSON.stringify(body);

  return new Response(responseBody, {
    status,
    headers: {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Headers': headers,
      'Access-Control-Allow-Methods': methods,
      'Vary': 'Origin',
    },
  });
}

export function cors(body: any, status = 200, req?: Request, options?: CorsOptions): Response {
  if (req) return corsResponse(body, status, req, options);
  // Fallback when no req available (e.g. scheduled functions)
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS[0] || 'https://darling-muffin-21eb90.netlify.app',
      'Access-Control-Allow-Headers': 'Content-Type, x-sa-token, x-csrf-token, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Vary': 'Origin',
    },
  });
}

// ---------------------------------------------------------------------------
// Auth Check — Superadmin
// ---------------------------------------------------------------------------
export function authCheckSuperadmin(req: Request): boolean {
  const email = Netlify.env.get('SUPERADMIN_EMAIL') || '';
  const pass = Netlify.env.get('SUPERADMIN_PASS') || '';
  if (!email || !pass) return false;
  const auth = req.headers.get('x-sa-token');
  if (!auth) return false;
  try {
    const decoded = atob(auth);
    // Constant-time comparison to prevent timing attacks
    if (decoded.length !== `${email}:${pass}`.length) return false;
    const expected = `${email}:${pass}`;
    let result = 0;
    for (let i = 0; i < decoded.length; i++) {
      result |= decoded.charCodeAt(i) ^ expected.charCodeAt(i);
    }
    return result === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Input Sanitization
// ---------------------------------------------------------------------------
export function sanitizeString(str: unknown, maxLength = 1000): string {
  if (typeof str !== 'string') return '';
  return str
    .replace(/[<>]/g, '')   // Strip potential HTML injection
    .replace(/\0/g, '')      // Strip null bytes
    .trim()
    .slice(0, maxLength);
}

export function sanitizeEmail(email: unknown): string {
  if (typeof email !== 'string') return '';
  return email.trim().toLowerCase().slice(0, 320);
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 320;
}

export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9-]+$/.test(slug) && slug.length <= 100;
}

export function isValidTrackingCode(code: string): boolean {
  return /^SS-[A-Z0-9]{4,8}$/.test(code);
}

// ---------------------------------------------------------------------------
// JSON body parser with validation
// ---------------------------------------------------------------------------
export async function parseJsonBody(req: Request): Promise<{ ok: true; data: any } | { ok: false; error: string }> {
  try {
    const contentType = req.headers.get('content-type') || '';
    if (!contentType.includes('application/json') && req.method !== 'GET') {
      // Be lenient but log warning
      console.warn('[SECURITY] Request without application/json content-type');
    }
    const body = await req.json();
    if (body === null || typeof body !== 'object') {
      return { ok: false, error: 'Le corps de la requete doit etre un objet JSON' };
    }
    return { ok: true, data: body };
  } catch {
    return { ok: false, error: 'Corps de requete JSON invalide' };
  }
}

// ---------------------------------------------------------------------------
// Client IP extraction
// ---------------------------------------------------------------------------
export function getClientIp(req: Request, context?: { ip?: string }): string {
  return context?.ip || req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}

// ---------------------------------------------------------------------------
// Rate Limiting (generic, blob-backed)
// ---------------------------------------------------------------------------
import { getStore } from '@netlify/blobs';

export async function checkRateLimit(
  prefix: string,
  ip: string,
  limit: number,
  windowMs: number
): Promise<{ blocked: boolean; remaining: number }> {
  const store = getStore({ name: 'rate-limits', consistency: 'strong' });
  const key = `${prefix}_${ip.replace(/[^a-zA-Z0-9]/g, '_')}`;
  const now = Date.now();
  let entry: { attempts: number[] } | null = null;
  try {
    entry = (await store.get(key, { type: 'json' })) as { attempts: number[] } | null;
  } catch {
    entry = null;
  }
  const recent = entry?.attempts?.filter((ts: number) => now - ts < windowMs) || [];
  if (recent.length >= limit) {
    return { blocked: true, remaining: 0 };
  }
  recent.push(now);
  await store.setJSON(key, { attempts: recent });
  return { blocked: false, remaining: limit - recent.length };
}

export async function recordAttempt(prefix: string, ip: string, windowMs: number): Promise<void> {
  const store = getStore({ name: 'rate-limits', consistency: 'strong' });
  const key = `${prefix}_${ip.replace(/[^a-zA-Z0-9]/g, '_')}`;
  const now = Date.now();
  let entry: { attempts: number[] } | null = null;
  try {
    entry = (await store.get(key, { type: 'json' })) as { attempts: number[] } | null;
  } catch {
    entry = null;
  }
  const recent = entry?.attempts?.filter((ts: number) => now - ts < windowMs) || [];
  recent.push(now);
  await store.setJSON(key, { attempts: recent });
}

export async function clearRateLimit(prefix: string, ip: string): Promise<void> {
  const store = getStore({ name: 'rate-limits', consistency: 'strong' });
  const key = `${prefix}_${ip.replace(/[^a-zA-Z0-9]/g, '_')}`;
  try {
    await store.delete(key);
  } catch {
    // Ignore
  }
}
