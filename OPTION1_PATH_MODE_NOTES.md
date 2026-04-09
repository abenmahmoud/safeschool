# SafeSchool — mode path-based `/t/:slug`

Cette version bascule l'accès établissement en mode **path-based** pour rester compatible avec **OVH DNS + Netlify** sans wildcard dynamique.

## Accès
- Élèves: `https://app.safeschool.fr/t/<slug>`
- Admin: `https://app.safeschool.fr/t/<slug>/admin`

## Fichiers principaux modifiés
- `index.html`
- `superadmin.html`
- `netlify/functions/api-establishments.mts`
- `netlify/edge-functions/subdomain-router.ts`

## Variables Netlify recommandées
- `TENANT_BASE_DOMAIN=app.safeschool.fr`
- `APP_BASE_URL=https://app.safeschool.fr`

## Remarque
Les anciens sous-domaines `slug.safeschool.fr` ne sont plus le mode d'accès principal dans cette version.
