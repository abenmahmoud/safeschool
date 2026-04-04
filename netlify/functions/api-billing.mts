import type { Context, Config } from '@netlify/functions';

// Stripe payment stub — will be replaced with real Stripe integration
// For now, returns mock checkout session info for the pricing flow

const PLANS: Record<string, { name: string; price: number; currency: string; interval: string }> = {
  starter: { name: 'Starter', price: 0, currency: 'EUR', interval: 'month' },
  pro: { name: 'Pro', price: 4900, currency: 'EUR', interval: 'month' },
  enterprise: { name: 'Enterprise', price: 19900, currency: 'EUR', interval: 'month' }
};

function cors(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    }
  });
}

export default async (req: Request, context: Context) => {
  if (req.method === 'OPTIONS') return cors({ ok: true });

  const url = new URL(req.url);
  const path = url.pathname.replace('/api/billing', '');

  // GET /api/billing/plans — List available plans
  if (req.method === 'GET' && path === '/plans') {
    return cors({
      plans: Object.entries(PLANS).map(([id, plan]) => ({
        id,
        ...plan,
        price_display: plan.price === 0 ? 'Gratuit' : `${(plan.price / 100).toFixed(0)}€/mois`
      }))
    });
  }

  // POST /api/billing/checkout — Create checkout session (stub)
  if (req.method === 'POST' && path === '/checkout') {
    const body = await req.json() as any;
    const plan = PLANS[body.plan];
    if (!plan) return cors({ error: 'Plan invalide' }, 400);

    if (plan.price === 0) {
      return cors({
        status: 'free',
        message: 'Le plan Starter est gratuit. Aucun paiement requis.',
        plan: body.plan
      });
    }

    // In production, this would create a Stripe checkout session
    // For now, return a mock response
    return cors({
      status: 'pending_integration',
      message: 'L\'intégration Stripe est en cours de configuration. Contactez-nous pour activer votre abonnement.',
      plan: body.plan,
      amount: plan.price,
      currency: plan.currency,
      contact_email: 'contact@safeschool.fr'
    });
  }

  // GET /api/billing/status/:schoolId — Get subscription status (stub)
  if (req.method === 'GET' && path.startsWith('/status/')) {
    const schoolId = path.replace('/status/', '');
    return cors({
      school_id: schoolId,
      plan: 'starter',
      status: 'active',
      message: 'Abonnement actif',
      stripe_integrated: false
    });
  }

  return cors({ error: 'Route non trouvée' }, 404);
};

export const config: Config = {
  path: '/api/billing/*'
};
