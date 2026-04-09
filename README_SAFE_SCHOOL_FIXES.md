# SafeSchool — configuration production (OVH + Netlify)

Ce guide résume les points à valider pour une mise en production propre avec séparation superadmin/établissements, authentification robuste et conformité RGPD.

## 1) Domaine et DNS OVH

- Domaine applicatif recommandé : `app.safeschool.fr`
- CNAME OVH :
  - `app` -> `safeschoolproject.netlify.app.`
  - `*` -> `safeschoolproject.netlify.app.`

## 2) Variables Netlify (runtime)

- `TENANT_BASE_DOMAIN=app.safeschool.fr`
- `NETLIFY_TARGET=safeschoolproject.netlify.app`
- `SITE_URL=https://app.safeschool.fr`
- `SUPERADMIN_EMAIL=...`
- `SUPERADMIN_PASS=...`
- `SUPABASE_URL=...`
- `SUPABASE_SERVICE_ROLE_KEY=...`
- `SUPABASE_ANON_KEY=...`

## 3) Réinitialisation mot de passe (admin établissement)

Le front admin local utilise Supabase Auth avec envoi d'email de reset.

- Dans Supabase Auth > URL Configuration :
  - `Site URL`: `https://app.safeschool.fr`
  - `Redirect URLs`: inclure `https://app.safeschool.fr/?admin_reset=1`
- Dans Supabase Auth > SMTP (OVH) :
  - `Host`: `ssl0.ovh.net` (ou votre serveur SMTP OVH)
  - `Port`: `587` (STARTTLS) ou `465` (SSL)
  - `Username`: adresse email d'envoi
  - `Password`: mot de passe SMTP applicatif
  - `Sender name`: `SafeSchool`
  - `Sender email`: `no-reply@votre-domaine`

## 4) Règles d'authentification recommandées (RGPD)

- Mot de passe fort (12+ caractères)
- Vérification de rattachement compte admin -> établissement avant accès dashboard
- Limitation de débit sur endpoints de login
- Session courte côté admin et déconnexion automatique en cas de session invalide
- Journalisation des actions sensibles (réponses, statut, demandes RGPD)

## 5) Conservation et traçabilité

- Suppression établissement : archivage automatique côté Netlify Blobs (`establishments-archive`)
- Demande RGPD suppression : snapshot archivé (`gdpr-deletions`) avant marquage de retrait
- SAV : tickets persistés dans `support-requests`, visibles côté superadmin avec réponse

## 6) Vérifications avant mise en ligne

- Création établissement par superadmin -> lien établissement fonctionnel
- Recherche d'établissement depuis la page d'accueil
- Admin établissement : traitement incidents + notes internes
- Membre équipe : vue limitée aux incidents attribués
- Notifications (nouveau signalement, changement statut, réponse)
- Export et statistiques superadmin opérationnels
