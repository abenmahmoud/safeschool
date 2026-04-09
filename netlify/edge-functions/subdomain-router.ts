import type { Config } from '@netlify/edge-functions'

// SafeSchool path-mode tenant routing
//
// Tenants are now resolved through /t/:slug and /t/:slug/admin
// on the primary application host (for example app.safeschool.fr).
//
// This avoids Netlify wildcard-host limitations when the DNS remains
// managed outside Netlify, while keeping tenant access easy to migrate later.
export default async () => {
  return
}

export const config: Config = {
  path: '/*',
  excludedPath: ['/api/*', '/.netlify/*']
}
