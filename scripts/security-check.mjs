#!/usr/bin/env node
// ==========================================================================
// SafeSchool — Pre-Deploy Security Checklist
// Run: node scripts/security-check.mjs
// ==========================================================================

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const FUNCTIONS_DIR = join(ROOT, 'netlify', 'functions');
let errors = 0;
let warnings = 0;

function ok(msg) { console.log(`  ✓ ${msg}`); }
function warn(msg) { warnings++; console.log(`  ⚠ ${msg}`); }
function fail(msg) { errors++; console.log(`  ✗ ${msg}`); }

// ---------------------------------------------------------------------------
// 1. Check for CORS wildcard in function files
// ---------------------------------------------------------------------------
console.log('\n[1] CORS — No wildcard Access-Control-Allow-Origin');
const functionFiles = readdirSync(FUNCTIONS_DIR)
  .filter(f => f.endsWith('.mts') || f.endsWith('.ts') || f.endsWith('.js'))
  .filter(f => !f.startsWith('_'));

for (const file of functionFiles) {
  const content = readFileSync(join(FUNCTIONS_DIR, file), 'utf-8');
  if (content.includes("'Access-Control-Allow-Origin': '*'") || content.includes('"Access-Control-Allow-Origin": "*"')) {
    fail(`${file} — CORS wildcard (*) detected`);
  } else {
    ok(`${file} — No CORS wildcard`);
  }
}

// ---------------------------------------------------------------------------
// 2. Check for hardcoded credentials
// ---------------------------------------------------------------------------
console.log('\n[2] No hardcoded credentials or secrets');
const CREDENTIAL_PATTERNS = [
  /password\s*[:=]\s*['"][^'"]{3,}['"]/gi,
  /secret\s*[:=]\s*['"][^'"]{8,}['"]/gi,
  /api[_-]?key\s*[:=]\s*['"][^'"]{8,}['"]/gi,
  /sk_live_/gi,
  /pk_live_/gi,
  /supabase_service_role_key\s*[:=]\s*['"]eyJ/gi,
];

for (const file of functionFiles) {
  const content = readFileSync(join(FUNCTIONS_DIR, file), 'utf-8');
  let clean = true;
  for (const pattern of CREDENTIAL_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(content)) {
      fail(`${file} — Possible hardcoded credential (pattern: ${pattern.source.slice(0, 30)}...)`);
      clean = false;
    }
  }
  if (clean) ok(`${file} — No hardcoded credentials`);
}

// ---------------------------------------------------------------------------
// 3. Check for rate limiting on all API endpoints
// ---------------------------------------------------------------------------
console.log('\n[3] Rate limiting present in API functions');
const apiFunctions = functionFiles.filter(f => f.startsWith('api-'));
for (const file of apiFunctions) {
  const content = readFileSync(join(FUNCTIONS_DIR, file), 'utf-8');
  if (content.includes('rateLimit') || content.includes('rate_limit') || content.includes('RATE_LIMIT') || content.includes('RateLimit')) {
    ok(`${file} — Rate limiting detected`);
  } else {
    warn(`${file} — No rate limiting detected`);
  }
}

// ---------------------------------------------------------------------------
// 4. Check for auth checks on admin endpoints
// ---------------------------------------------------------------------------
console.log('\n[4] Auth checks present in admin/superadmin functions');
const adminFunctions = apiFunctions.filter(f =>
  ['api-superadmin.mts', 'api-analytics.mts', 'api-export.mts', 'api-billing.mts'].includes(f)
);
for (const file of adminFunctions) {
  const content = readFileSync(join(FUNCTIONS_DIR, file), 'utf-8');
  if (content.includes('authCheck') || content.includes('authCheckSuperadmin')) {
    ok(`${file} — Auth check present`);
  } else {
    fail(`${file} — No auth check found`);
  }
}

// ---------------------------------------------------------------------------
// 5. Check netlify.toml security headers
// ---------------------------------------------------------------------------
console.log('\n[5] Security headers in netlify.toml');
const tomlPath = join(ROOT, 'netlify.toml');
if (existsSync(tomlPath)) {
  const toml = readFileSync(tomlPath, 'utf-8');
  const requiredHeaders = [
    'X-Frame-Options',
    'X-Content-Type-Options',
    'Strict-Transport-Security',
    'Content-Security-Policy',
    'Referrer-Policy',
    'Permissions-Policy',
  ];
  for (const header of requiredHeaders) {
    if (toml.includes(header)) {
      ok(`${header} — Present`);
    } else {
      fail(`${header} — Missing`);
    }
  }
} else {
  fail('netlify.toml not found');
}

// ---------------------------------------------------------------------------
// 6. Check environment variables referenced
// ---------------------------------------------------------------------------
console.log('\n[6] Required environment variables');
const REQUIRED_ENV_VARS = [
  'SUPERADMIN_EMAIL',
  'SUPERADMIN_PASS',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
];
const OPTIONAL_ENV_VARS = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'REPORTS_ENCRYPTION_KEY',
  'VAPID_PUBLIC_KEY',
  'VAPID_PRIVATE_KEY',
];

for (const v of REQUIRED_ENV_VARS) {
  if (process.env[v]) {
    ok(`${v} — Set`);
  } else {
    warn(`${v} — Not set (required for production)`);
  }
}
for (const v of OPTIONAL_ENV_VARS) {
  if (process.env[v]) {
    ok(`${v} — Set`);
  } else {
    warn(`${v} — Not set (optional but recommended)`);
  }
}

// ---------------------------------------------------------------------------
// 7. Check for input validation
// ---------------------------------------------------------------------------
console.log('\n[7] Input validation patterns');
for (const file of apiFunctions) {
  const content = readFileSync(join(FUNCTIONS_DIR, file), 'utf-8');
  const hasJsonParse = content.includes('req.json()') || content.includes('parseJsonBody');
  const hasValidation = content.includes('typeof') || content.includes('.test(') || content.includes('isValid');
  if (hasJsonParse && !hasValidation) {
    warn(`${file} — Parses JSON but no input validation detected`);
  } else if (hasJsonParse) {
    ok(`${file} — JSON parsing with validation`);
  } else {
    ok(`${file} — No JSON body parsed (GET only or no input)`);
  }
}

// ---------------------------------------------------------------------------
// 8. Check for .env files that should not be committed
// ---------------------------------------------------------------------------
console.log('\n[8] Sensitive files not committed');
const sensitiveFiles = ['.env', '.env.local', '.env.production', 'credentials.json'];
for (const file of sensitiveFiles) {
  if (existsSync(join(ROOT, file))) {
    fail(`${file} — Exists in repo (should be in .gitignore)`);
  } else {
    ok(`${file} — Not present`);
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(50));
console.log(`SECURITY CHECK COMPLETE`);
console.log(`  Passed: all other checks`);
console.log(`  Warnings: ${warnings}`);
console.log(`  Errors: ${errors}`);
console.log('='.repeat(50));

if (errors > 0) {
  console.log('\n❌ Security check FAILED — fix errors before deploying.');
  process.exit(1);
} else if (warnings > 0) {
  console.log('\n⚠ Security check passed with warnings.');
  process.exit(0);
} else {
  console.log('\n✅ All security checks passed.');
  process.exit(0);
}
