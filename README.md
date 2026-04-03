# SafeSchool V3 Foundation

Base corrigée à partir de l'état actuel du repo public `abenmahmoud/safeschool`.

## Ce qui change
- séparation claire HTML / CSS / JS
- sélection d'établissement et signalement plus stables
- dashboard admin plus lisible
- fallback localStorage conservé uniquement pour la démo
- structure prête pour Supabase
- schéma SQL renforcé
- `netlify.toml` plus propre

## Important
Cette version est une **fondation V3 sérieuse**, mais le passage en **vraie production sensible** demande :
- variables Supabase réelles
- auth admin
- tests des policies RLS
- stockage sécurisé des pièces jointes
- monitoring et journal d'audit

## Déploiement
1. Remplacer les fichiers du repo par ceux de ce dossier
2. Déployer sur Netlify à la racine
3. Ajouter `SUPABASE_URL` et `SUPABASE_ANON_KEY` si vous branchez Supabase
4. Exécuter `supabase/schema.sql` dans Supabase SQL Editor

## Fichiers
- `index.html`
- `app.css`
- `app.js`
- `dashboard-v3.js`
- `superadmin.html`
- `netlify.toml`
- `.env.example`
- `supabase/schema.sql`
