# SafeSchool — paquet de correction ciblée

Ce paquet corrige les deux blocages déjà confirmés :

1. `crypto is not defined` dans `netlify/functions/api-establishments.mts`
2. génération de tenants en `slug.safeschool.fr` au lieu de `slug.app.safeschool.fr`

## Fichiers à remplacer

- `netlify/functions/api-establishments.mts` → remplacer par `api-establishments-fixed.mts`
- `netlify/edge-functions/subdomain-router.ts` → remplacer par `subdomain-router-fixed.ts`

## Variables Netlify à vérifier

- `TENANT_BASE_DOMAIN=app.safeschool.fr`
- `SITE_URL=https://app.safeschool.fr`
- `SUPABASE_URL=...`
- `SUPABASE_SERVICE_ROLE_KEY=...`
- `SUPERADMIN_EMAIL=...`
- `SUPERADMIN_PASS=...`

## DNS OVH attendus

- `app` → `CNAME` vers `safeschoolproject.netlify.app.`
- `*` → `CNAME` vers `safeschoolproject.netlify.app.`

## Ce qu'il faut aussi vérifier dans le front

Faire une recherche globale sur :

- `.safeschool.fr`
- `window.location.hostname`
- `host.split('.')`
- `admin-login`

Et corriger toute génération de lien établissement pour utiliser :

- `\`${slug}.app.safeschool.fr\``

au lieu de :

- `\`${slug}.safeschool.fr\``

## Limite importante

Le projet complet a été fourni en `.rar`, qui n'a pas pu être entièrement extrait dans cet environnement. Ce paquet corrige donc directement les fichiers déjà identifiés comme critiques, mais ne remplace pas un audit complet du front si d'autres composants génèrent encore l'ancien domaine.
