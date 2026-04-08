import type { Context } from '@netlify/functions';

const SESSION_TTL_SECONDS = Number(Netlify.env.get('SUPERADMIN_SESSION_TTL_SECONDS') || '28800');
const TOKEN_SECRET = Netlify.env.get('SUPERADMIN_SESSION_SECRET') || '';
const SUPERADMIN_EMAIL = Netlify.env.get('SUPERADMIN_EMAIL') || '';
const SUPERADMIN_PASS = Netlify.env.get('SUPERADMIN_PASS') || '';

type SessionRole = 'superadmin' | 'establishment_admin' | 'staff' | 'user';

interface SessionPayload {
  role: SessionRole;
  email: string;
  exp: number;
  iat: number;
}

function b64UrlEncode(input: string): string {
  return btoa(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64UrlDecode(input: string): string {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return atob(normalized + pad);
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hashPassword(plain: string): Promise<string> {
  const pepper = Netlify.env.get('PASSWORD_PEPPER') || '';
  return sha256Hex(`v1:${plain}:${pepper}`);
}

export function sanitizeText(value: unknown, maxLen = 200): string {
  const safe = String(value ?? '')
    .replace(/[<>]/g, '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim();
  return safe.slice(0, maxLen);
}

export async function createSuperadminSessionToken(email: string): Promise<string> {
  if (!TOKEN_SECRET) {
    throw new Error('SUPERADMIN_SESSION_SECRET is not configured');
  }
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    role: 'superadmin',
    email: sanitizeText(email.toLowerCase(), 120),
    iat: now,
    exp: now + Math.max(900, SESSION_TTL_SECONDS)
  };
  const payloadJson = JSON.stringify(payload);
  const encodedPayload = b64UrlEncode(payloadJson);
  const signature = await sha256Hex(`${encodedPayload}.${TOKEN_SECRET}`);
  return `v1.${encodedPayload}.${signature}`;
}

export async function verifySuperadminSessionToken(token: string): Promise<SessionPayload | null> {
  if (!token || !TOKEN_SECRET) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const encodedPayload = parts[1];
  const signature = parts[2];
  const expected = await sha256Hex(`${encodedPayload}.${TOKEN_SECRET}`);
  if (signature !== expected) return null;

  try {
    const payload = JSON.parse(b64UrlDecode(encodedPayload)) as SessionPayload;
    if (!payload || payload.role !== 'superadmin') return null;
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function isSuperadminRequest(req: Request): Promise<boolean> {
  const authHeader = req.headers.get('authorization') || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const legacyToken = req.headers.get('x-sa-token') || '';
  const token = bearerToken || legacyToken;

  if (!token) return false;

  const session = await verifySuperadminSessionToken(token);
  if (session) return true;

  // Legacy compatibility path for existing clients (to be removed after migration)
  if (SUPERADMIN_EMAIL && SUPERADMIN_PASS) {
    try {
      return atob(token) === `${SUPERADMIN_EMAIL}:${SUPERADMIN_PASS}`;
    } catch {
      return false;
    }
  }
  return false;
}

export function extractClientIp(req: Request, context?: Context): string {
  const ip = context?.ip || req.headers.get('x-forwarded-for') || 'unknown';
  return String(ip).split(',')[0].trim().slice(0, 80);
}

export function getAllowedOrigin(req: Request): string {
  const origin = req.headers.get('origin') || '';
  const siteUrl = Netlify.env.get('SITE_URL') || '';
  const deployPrimeUrl = Netlify.env.get('DEPLOY_PRIME_URL') || '';
  const url = Netlify.env.get('URL') || '';
  const allowed = [
    siteUrl,
    deployPrimeUrl,
    url,
    'http://localhost:8888',
    'http://127.0.0.1:8888'
  ].filter(Boolean);

  if (origin && allowed.includes(origin)) return origin;
  if (/^https:\/\/[a-z0-9-]+--[a-z0-9-]+\.netlify\.app$/.test(origin)) return origin;
  if (/^https:\/\/[a-z0-9-]+\.safeschool\.(fr|com|eu)$/.test(origin)) return origin;
  return allowed[0] || 'https://safeschool.fr';
}

export function jsonCors(body: unknown, status = 200, req?: Request): Response {
  const allowedOrigin = req ? getAllowedOrigin(req) : '*';
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Headers': 'Content-Type, x-sa-token, Authorization, x-csrf-token',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Vary': 'Origin',
      'Cache-Control': 'no-store'
    }
  });
}

export async function safeJson(req: Request): Promise<Record<string, any>> {
  const contentType = req.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new Error('content_type_invalid');
  }
  const body = await req.json();
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('body_invalid');
  }
  return body as Record<string, any>;
}
