# Khaos Theory — Cloudflare Workers

Le frontend historique reste dans `public/`. Next.js sert de couche serveur minimale pour les routes Stripe, et `@opennextjs/cloudflare` produit le Worker déployé par Wrangler.

## Prérequis

- Node.js 20.9 ou supérieur
- pnpm 11
- un compte Cloudflare et un compte Stripe

## Développement et aperçu Cloudflare

```bash
pnpm install
cp .dev.vars.example .dev.vars
pnpm preview
```

Renseigner dans `.dev.vars` une clé Stripe de test et le secret d'un webhook de test. Ce fichier est ignoré par Git. L'aperçu est disponible par défaut sur `http://localhost:8787` et utilise le runtime local de Wrangler.

## Variables de production

Configurer les trois valeurs comme secrets Worker avant le premier déploiement :

```bash
pnpm wrangler secret put STRIPE_SECRET_KEY
pnpm wrangler secret put STRIPE_WEBHOOK_SECRET
pnpm wrangler secret put SITE_URL
```

`SITE_URL` doit être l'origine publique sans slash final, par exemple `https://khaos-theory.com`. Les secrets ne doivent jamais être ajoutés à `wrangler.jsonc` ou au dépôt.

## Webhook Stripe

Dans Stripe, créer un endpoint pointant vers :

```text
https://<domaine>/api/stripe/webhook
```

Sélectionner au minimum l'événement `checkout.session.completed`, puis enregistrer son secret de signature dans `STRIPE_WEBHOOK_SECRET`. La route vérifie la signature sur le corps brut avant de lire l'événement.

## Déploiement

Se connecter une première fois avec `pnpm wrangler login`, puis lancer :

```bash
pnpm deploy
```

Le script reconstruit le projet avec OpenNext puis le déploie avec Wrangler. L'option `--keep-vars` conserve les variables déjà définies dans le tableau de bord Cloudflare.

## Routes serveur

- `POST /api/create-checkout-session` valide les références, tailles et quantités côté serveur, recalcule les prix depuis le catalogue, puis crée la session Stripe Checkout.
- `POST /api/stripe/webhook` vérifie la signature Stripe sur le corps brut et traite les événements de paiement et de remboursement configurés.

Le webhook journalise actuellement la confirmation du paiement. Pour déclencher une préparation de commande, un e-mail ou une gestion de stock, ajouter cette logique dans cette route et, si nécessaire, un stockage Cloudflare D1 ou une API externe.
