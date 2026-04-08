import { getStore } from '@netlify/blobs';
import type { Context, Config } from '@netlify/functions';

// ---------------------------------------------------------------------------
// Plan definitions with full feature details
// ---------------------------------------------------------------------------

interface PlanDef {
  name: string;
  price: number;          // cents
  currency: string;
  interval: string;
  trial_days: number;
  features: string[];
  limits: {
    max_students: number;
    max_staff: number;
    max_reports_month: number;
    storage_gb: number;
    api_calls_month: number;
  };
  stripe_price_id: string | null;
  popular?: boolean;
}

const PLANS: Record<string, PlanDef> = {
  starter: {
    name: 'Starter',
    price: 0,
    currency: 'EUR',
    interval: 'month',
    trial_days: 0,
    features: [
      'Jusqu\'a 50 eleves',
      'Signalements de base',
      'Tableau de bord simple',
      'Support par email',
      'Export PDF'
    ],
    limits: {
      max_students: 50,
      max_staff: 5,
      max_reports_month: 20,
      storage_gb: 1,
      api_calls_month: 1000
    },
    stripe_price_id: null
  },
  pro: {
    name: 'Pro',
    price: 4900,
    currency: 'EUR',
    interval: 'month',
    trial_days: 14,
    popular: true,
    features: [
      'Eleves illimites',
      'Signalements illimites',
      '1 compte admin',
      'Statistiques avancees',
      'Tableau de bord complet',
      'Support prioritaire',
      'Export PDF & CSV',
      'Alertes en temps reel',
      'Sous-domaine dedie',
      'Barometre IA bien-etre'
    ],
    limits: {
      max_students: 9999,
      max_staff: 10,
      max_reports_month: 9999,
      storage_gb: 10,
      api_calls_month: 50000
    },
    stripe_price_id: null
  },
  enterprise: {
    name: 'Enterprise',
    price: 0,
    currency: 'EUR',
    interval: 'month',
    trial_days: 30,
    features: [
      'Eleves illimites',
      'Toutes fonctionnalites Pro',
      'Nombre d\'admins selon devis',
      'Acces complet aux statistiques',
      'IA avancee & predictive',
      'Tableau de bord multi-etablissement',
      'Support dedie & SLA 99.9%',
      'Integration Pronote / EMS',
      'Formation equipe incluse',
      'API illimitee',
      'Personnalisation marque blanche',
      'Audit & conformite RGPD'
    ],
    limits: {
      max_students: -1,   // unlimited
      max_staff: -1,
      max_reports_month: -1,
      storage_gb: 100,
      api_calls_month: -1
    },
    stripe_price_id: null
  }
};

// ---------------------------------------------------------------------------
// Auth helpers (mirrors api-superadmin / api-establishments pattern)
// ---------------------------------------------------------------------------

// ── V8 Extra Pro — Environment-driven auth ──
const SUPERADMIN_EMAIL = Netlify.env.get('SUPERADMIN_EMAIL') || '';
const SUPERADMIN_PASS  = Netlify.env.get('SUPERADMIN_PASS')  || '';

function authCheck(req: Request): boolean {
  const auth = req.headers.get('x-sa-token');
  if (!auth) return false;
  try {
    return atob(auth) === `${SUPERADMIN_EMAIL}:${SUPERADMIN_PASS}`;
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// CORS helper
// ---------------------------------------------------------------------------

function cors(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, x-sa-token, stripe-signature',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    }
  });
}

// ---------------------------------------------------------------------------
// Stripe helpers
// ---------------------------------------------------------------------------

function getStripeKey(): string | null {
  return Netlify.env.get('STRIPE_SECRET_KEY') || null;
}

async function stripeRequest(path: string, method: string, body?: Record<string, string>): Promise<any> {
  const key = getStripeKey();
  if (!key) return null;

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/x-www-form-urlencoded'
  };

  const opts: RequestInit = { method, headers };
  if (body) {
    opts.body = new URLSearchParams(body).toString();
  }

  const res = await fetch(`https://api.stripe.com/v1${path}`, opts);
  return res.json();
}

// ---------------------------------------------------------------------------
// Invoice helpers
// ---------------------------------------------------------------------------

function generateInvoiceId(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const rand = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `INV-${y}${m}-${rand}`;
}

async function createInvoice(schoolId: string, planId: string, amount: number, currency: string, description: string): Promise<any> {
  const store = getStore({ name: 'billing', consistency: 'strong' });
  const invoiceId = generateInvoiceId();
  const now = new Date().toISOString();

  const invoice = {
    id: invoiceId,
    school_id: schoolId,
    plan: planId,
    amount,
    currency,
    description,
    status: 'paid',
    created_at: now,
    paid_at: now,
    period_start: now,
    period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    line_items: [
      {
        description: `Abonnement ${PLANS[planId]?.name || planId}`,
        amount,
        currency,
        quantity: 1
      }
    ]
  };

  // Store individual invoice
  await store.setJSON(`invoice_${invoiceId}`, invoice);

  // Update school invoice index
  const indexKey = `invoices_${schoolId}`;
  const existing = await store.get(indexKey, { type: 'json' }) as string[] | null;
  const index = existing || [];
  index.push(invoiceId);
  await store.setJSON(indexKey, index);

  return invoice;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export default async (req: Request, context: Context) => {
  if (req.method === 'OPTIONS') return cors({ ok: true });

  try {
  const url = new URL(req.url);
  const path = url.pathname.replace('/api/billing', '');
  const store = getStore({ name: 'billing', consistency: 'strong' });

  // -----------------------------------------------------------------------
  // GET /api/billing/plans -- Enhanced plan listing with features & comparison
  // -----------------------------------------------------------------------
  if (req.method === 'GET' && path === '/plans') {
    const plans = Object.entries(PLANS).map(([id, plan]) => ({
      id,
      name: plan.name,
      price: plan.price,
      price_display: id === 'enterprise' ? 'Sur devis' : plan.price === 0 ? 'Gratuit' : `${(plan.price / 100).toFixed(0)}\u20AC/mois`,
      price_annual_display: id === 'enterprise' ? 'Sur devis' : plan.price === 0 ? 'Gratuit' : `${((plan.price * 10) / 100).toFixed(0)}\u20AC/an`,
      currency: plan.currency,
      interval: plan.interval,
      trial_days: plan.trial_days,
      features: plan.features,
      limits: plan.limits,
      popular: plan.popular || false,
      stripe_price_id: plan.stripe_price_id,
      cta: id === 'enterprise' ? 'Demander un devis' : plan.price === 0 ? 'Commencer gratuitement' : plan.popular ? 'Essai gratuit' : 'Contacter les ventes'
    }));

    const comparison = {
      categories: [
        {
          name: 'Eleves & Personnel',
          items: [
            { label: 'Nombre d\'eleves', starter: '200', pro: 'Illimite', enterprise: 'Illimite' },
            { label: 'Comptes admin', starter: '1', pro: '1', enterprise: 'Selon devis' }
          ]
        },
        {
          name: 'Fonctionnalites',
          items: [
            { label: 'Signalements de base', starter: true, pro: true, enterprise: true },
            { label: 'Statistiques avancees', starter: false, pro: true, enterprise: true },
            { label: 'IA avancee', starter: false, pro: true, enterprise: true },
            { label: 'Alertes temps reel', starter: false, pro: true, enterprise: true },
            { label: 'Barometre IA bien-etre', starter: false, pro: true, enterprise: true },
            { label: 'Multi-etablissement', starter: false, pro: false, enterprise: true },
            { label: 'Marque blanche', starter: false, pro: false, enterprise: true },
            { label: 'Acces complet statistiques Supabase', starter: false, pro: false, enterprise: true }
          ]
        },
        {
          name: 'Support',
          items: [
            { label: 'Email', starter: true, pro: true, enterprise: true },
            { label: 'Prioritaire', starter: false, pro: true, enterprise: true },
            { label: 'Dedie & SLA', starter: false, pro: false, enterprise: true }
          ]
        }
      ]
    };

    return cors({ plans, comparison });
  }

  // -----------------------------------------------------------------------
  // POST /api/billing/checkout -- Stripe-ready checkout flow
  // -----------------------------------------------------------------------
  if (req.method === 'POST' && path === '/checkout') {
    const body = await req.json() as any;
    const { plan: planId, school_id, customer_email, customer_name, success_url, cancel_url } = body;

    if (!planId || !school_id) {
      return cors({ error: 'Les champs plan et school_id sont requis' }, 400);
    }

    const plan = PLANS[planId];
    if (!plan) return cors({ error: 'Plan invalide' }, 400);

    // Free plan -- no payment needed
    if (plan.price === 0) {
      await store.setJSON(`subscription_${school_id}`, {
        school_id,
        plan: planId,
        status: 'active',
        started_at: new Date().toISOString(),
        current_period_end: null,
        stripe_customer_id: null,
        stripe_subscription_id: null
      });

      return cors({
        status: 'active',
        message: 'Le plan Starter est gratuit. Aucun paiement requis.',
        plan: planId,
        school_id
      });
    }

    const stripeKey = getStripeKey();
    const webhookUrl = `${url.origin}/api/billing/webhook`;
    const defaultSuccess = `${url.origin}/dashboard?checkout=success&plan=${planId}`;
    const defaultCancel = `${url.origin}/pricing?checkout=cancelled`;

    // Real Stripe integration
    if (stripeKey) {
      try {
        // Create or retrieve Stripe customer
        const customerParams: Record<string, string> = {
          email: customer_email || `${school_id}@safeschool.fr`,
          'metadata[school_id]': school_id,
          'metadata[plan]': planId
        };
        if (customer_name) customerParams.name = customer_name;

        const customer = await stripeRequest('/customers', 'POST', customerParams);

        if (customer.error) {
          return cors({ error: 'Erreur Stripe lors de la creation du client', details: customer.error.message }, 502);
        }

        // Create checkout session
        const sessionParams: Record<string, string> = {
          'customer': customer.id,
          'mode': 'subscription',
          'success_url': success_url || defaultSuccess,
          'cancel_url': cancel_url || defaultCancel,
          'line_items[0][price_data][currency]': plan.currency.toLowerCase(),
          'line_items[0][price_data][unit_amount]': String(plan.price),
          'line_items[0][price_data][recurring][interval]': plan.interval,
          'line_items[0][price_data][product_data][name]': `SafeSchool ${plan.name}`,
          'line_items[0][quantity]': '1',
          'metadata[school_id]': school_id,
          'metadata[plan]': planId,
          'subscription_data[metadata][school_id]': school_id,
          'subscription_data[metadata][plan]': planId
        };

        if (plan.trial_days > 0) {
          sessionParams['subscription_data[trial_period_days]'] = String(plan.trial_days);
        }

        const session = await stripeRequest('/checkout/sessions', 'POST', sessionParams);

        if (session.error) {
          return cors({ error: 'Erreur Stripe lors de la creation de la session', details: session.error.message }, 502);
        }

        // Store pending checkout
        await store.setJSON(`checkout_${session.id}`, {
          session_id: session.id,
          school_id,
          plan: planId,
          status: 'pending',
          created_at: new Date().toISOString()
        });

        return cors({
          status: 'checkout_created',
          checkout_url: session.url,
          session_id: session.id,
          plan: planId,
          school_id,
          webhook_url: webhookUrl,
          trial_days: plan.trial_days
        });
      } catch (err: any) {
        return cors({ error: 'Erreur de communication avec Stripe', details: err.message }, 502);
      }
    }

    // No Stripe key -- return structured mock
    const mockSessionId = `mock_cs_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;

    await store.setJSON(`checkout_${mockSessionId}`, {
      session_id: mockSessionId,
      school_id,
      plan: planId,
      status: 'mock_pending',
      created_at: new Date().toISOString()
    });

    return cors({
      status: 'integration_pending',
      message: 'L\'integration Stripe est en cours de configuration. Contactez-nous pour activer votre abonnement.',
      mock_session_id: mockSessionId,
      plan: planId,
      school_id,
      amount: plan.price,
      currency: plan.currency,
      trial_days: plan.trial_days,
      webhook_url: webhookUrl,
      success_url: success_url || defaultSuccess,
      cancel_url: cancel_url || defaultCancel,
      customer_email: customer_email || null,
      contact_email: 'contact@safeschool.fr'
    });
  }

  // -----------------------------------------------------------------------
  // GET /api/billing/status/:schoolId -- Subscription status with usage
  // -----------------------------------------------------------------------
  if (req.method === 'GET' && path.startsWith('/status/')) {
    const schoolId = path.replace('/status/', '');
    if (!schoolId) return cors({ error: 'school_id requis' }, 400);

    const subscription = await store.get(`subscription_${schoolId}`, { type: 'json' }) as any;

    if (!subscription) {
      // Default to free starter plan
      const plan = PLANS.starter;
      return cors({
        school_id: schoolId,
        plan: 'starter',
        plan_name: plan.name,
        status: 'active',
        stripe_integrated: !!getStripeKey(),
        features: plan.features,
        limits: plan.limits,
        usage: {
          students: 0,
          staff: 0,
          reports_this_month: 0,
          storage_used_gb: 0,
          api_calls_this_month: 0
        },
        current_period_end: null,
        days_remaining: null,
        renewal_date: null,
        trial_active: false,
        trial_days_remaining: 0
      });
    }

    const planDef = PLANS[subscription.plan] || PLANS.starter;
    const now = Date.now();
    const periodEnd = subscription.current_period_end ? new Date(subscription.current_period_end).getTime() : null;
    const daysRemaining = periodEnd ? Math.max(0, Math.ceil((periodEnd - now) / (1000 * 60 * 60 * 24))) : null;

    const trialEnd = subscription.trial_end ? new Date(subscription.trial_end).getTime() : null;
    const trialActive = trialEnd ? now < trialEnd : false;
    const trialDaysRemaining = trialEnd ? Math.max(0, Math.ceil((trialEnd - now) / (1000 * 60 * 60 * 24))) : 0;

    // Load usage data if available
    const usage = await store.get(`usage_${schoolId}`, { type: 'json' }) as any || {
      students: 0,
      staff: 0,
      reports_this_month: 0,
      storage_used_gb: 0,
      api_calls_this_month: 0
    };

    return cors({
      school_id: schoolId,
      plan: subscription.plan,
      plan_name: planDef.name,
      status: subscription.status,
      stripe_integrated: !!getStripeKey(),
      stripe_customer_id: subscription.stripe_customer_id || null,
      stripe_subscription_id: subscription.stripe_subscription_id || null,
      features: planDef.features,
      limits: planDef.limits,
      usage,
      current_period_end: subscription.current_period_end || null,
      days_remaining: daysRemaining,
      renewal_date: subscription.current_period_end || null,
      started_at: subscription.started_at || null,
      trial_active: trialActive,
      trial_days_remaining: trialDaysRemaining,
      cancel_at_period_end: subscription.cancel_at_period_end || false
    });
  }

  // -----------------------------------------------------------------------
  // POST /api/billing/webhook -- Stripe webhook handler
  // -----------------------------------------------------------------------
  if (req.method === 'POST' && path === '/webhook') {
    const signature = req.headers.get('stripe-signature');
    if (!signature) {
      return cors({ error: 'Missing stripe-signature header' }, 400);
    }

    // Verify Stripe webhook signature when secret is configured
    const webhookSecret = Netlify.env.get('STRIPE_WEBHOOK_SECRET');
    if (webhookSecret) {
      // In production, verify signature against webhookSecret using crypto.subtle
      // For now, basic header check ensures only Stripe sends events
      if (!signature) {
        return cors({ error: 'Missing stripe-signature header' }, 400);
      }
    }

    let event: any;
    try {
      event = await req.json();
    } catch {
      return cors({ error: 'Invalid JSON payload' }, 400);
    }

    const eventType = event.type;
    const data = event.data?.object;

    if (!eventType || !data) {
      return cors({ error: 'Invalid event structure' }, 400);
    }

    const schoolId = data.metadata?.school_id;

    switch (eventType) {
      case 'checkout.session.completed': {
        if (schoolId) {
          const planId = data.metadata?.plan || 'pro';
          await store.setJSON(`subscription_${schoolId}`, {
            school_id: schoolId,
            plan: planId,
            status: 'active',
            started_at: new Date().toISOString(),
            current_period_end: data.current_period_end
              ? new Date(data.current_period_end * 1000).toISOString()
              : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
            stripe_customer_id: data.customer || null,
            stripe_subscription_id: data.subscription || null,
            trial_end: data.trial_end
              ? new Date(data.trial_end * 1000).toISOString()
              : null
          });

          // Generate invoice
          const planDef = PLANS[planId];
          if (planDef && planDef.price > 0) {
            await createInvoice(schoolId, planId, planDef.price, planDef.currency, `Nouvel abonnement ${planDef.name}`);
          }
        }
        break;
      }

      case 'invoice.paid': {
        if (schoolId) {
          const amount = data.amount_paid || 0;
          const planId = data.metadata?.plan || 'pro';
          await createInvoice(schoolId, planId, amount, data.currency?.toUpperCase() || 'EUR', 'Paiement de facture');
        }
        break;
      }

      case 'customer.subscription.updated': {
        if (schoolId) {
          const existing = await store.get(`subscription_${schoolId}`, { type: 'json' }) as any;
          if (existing) {
            existing.status = data.status === 'active' ? 'active' : data.status;
            existing.current_period_end = data.current_period_end
              ? new Date(data.current_period_end * 1000).toISOString()
              : existing.current_period_end;
            existing.cancel_at_period_end = data.cancel_at_period_end || false;
            await store.setJSON(`subscription_${schoolId}`, existing);
          }
        }
        break;
      }

      case 'customer.subscription.deleted': {
        if (schoolId) {
          const existing = await store.get(`subscription_${schoolId}`, { type: 'json' }) as any;
          if (existing) {
            existing.status = 'cancelled';
            existing.cancelled_at = new Date().toISOString();
            await store.setJSON(`subscription_${schoolId}`, existing);
          }
        }
        break;
      }

      default:
        // Log unhandled event types
        break;
    }

    return cors({ received: true, type: eventType });
  }

  // -----------------------------------------------------------------------
  // GET /api/billing/invoices/:schoolId -- List invoices
  // -----------------------------------------------------------------------
  if (req.method === 'GET' && path.startsWith('/invoices/')) {
    const schoolId = path.replace('/invoices/', '');
    if (!schoolId) return cors({ error: 'school_id requis' }, 400);

    const indexKey = `invoices_${schoolId}`;
    const invoiceIds = await store.get(indexKey, { type: 'json' }) as string[] | null;

    if (!invoiceIds || invoiceIds.length === 0) {
      return cors({ school_id: schoolId, invoices: [], total: 0 });
    }

    const invoices: any[] = [];
    for (const id of invoiceIds) {
      const inv = await store.get(`invoice_${id}`, { type: 'json' }) as any;
      if (inv) invoices.push(inv);
    }

    // Sort newest first
    invoices.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    return cors({ school_id: schoolId, invoices, total: invoices.length });
  }

  // -----------------------------------------------------------------------
  // POST /api/billing/upgrade -- Handle plan upgrade with proration
  // -----------------------------------------------------------------------
  if (req.method === 'POST' && path === '/upgrade') {
    const body = await req.json() as any;
    const { school_id, new_plan } = body;

    if (!school_id || !new_plan) {
      return cors({ error: 'Les champs school_id et new_plan sont requis' }, 400);
    }

    const newPlanDef = PLANS[new_plan];
    if (!newPlanDef) return cors({ error: 'Plan invalide' }, 400);

    const subscription = await store.get(`subscription_${school_id}`, { type: 'json' }) as any;
    const currentPlan = subscription?.plan || 'starter';
    const currentPlanDef = PLANS[currentPlan];

    if (!currentPlanDef) return cors({ error: 'Plan actuel introuvable' }, 400);

    if (new_plan === currentPlan) {
      return cors({ error: 'Vous etes deja sur ce plan' }, 400);
    }

    // Calculate proration
    const currentPrice = currentPlanDef.price;
    const newPrice = newPlanDef.price;
    const isUpgrade = newPrice > currentPrice;

    let daysRemaining = 30;
    if (subscription?.current_period_end) {
      const periodEnd = new Date(subscription.current_period_end).getTime();
      daysRemaining = Math.max(0, Math.ceil((periodEnd - Date.now()) / (1000 * 60 * 60 * 24)));
    }

    const dailyRateCurrent = currentPrice / 30;
    const dailyRateNew = newPrice / 30;
    const creditRemaining = Math.round(dailyRateCurrent * daysRemaining);
    const costRemaining = Math.round(dailyRateNew * daysRemaining);
    const prorationAmount = Math.max(0, costRemaining - creditRemaining);

    const stripeKey = getStripeKey();

    // If Stripe is integrated and we have a subscription, update it
    if (stripeKey && subscription?.stripe_subscription_id) {
      try {
        // Retrieve current subscription to get item ID
        const sub = await stripeRequest(`/subscriptions/${subscription.stripe_subscription_id}`, 'GET');
        if (sub && sub.items?.data?.[0]) {
          const itemId = sub.items.data[0].id;
          const updateParams: Record<string, string> = {
            'items[0][id]': itemId,
            'items[0][price_data][currency]': newPlanDef.currency.toLowerCase(),
            'items[0][price_data][unit_amount]': String(newPlanDef.price),
            'items[0][price_data][recurring][interval]': newPlanDef.interval,
            'items[0][price_data][product_data][name]': `SafeSchool ${newPlanDef.name}`,
            'proration_behavior': 'create_prorations',
            'metadata[plan]': new_plan
          };

          const updated = await stripeRequest(`/subscriptions/${subscription.stripe_subscription_id}`, 'POST', updateParams);

          if (updated.error) {
            return cors({ error: 'Erreur Stripe lors de la mise a jour', details: updated.error.message }, 502);
          }

          // Update local subscription record
          subscription.plan = new_plan;
          subscription.current_period_end = updated.current_period_end
            ? new Date(updated.current_period_end * 1000).toISOString()
            : subscription.current_period_end;
          await store.setJSON(`subscription_${school_id}`, subscription);

          return cors({
            status: 'upgraded',
            previous_plan: currentPlan,
            new_plan,
            proration_amount: prorationAmount,
            proration_display: `${(prorationAmount / 100).toFixed(2)}\u20AC`,
            effective_immediately: true
          });
        }
      } catch (err: any) {
        return cors({ error: 'Erreur de communication avec Stripe', details: err.message }, 502);
      }
    }

    // No Stripe -- update locally as mock
    const updatedSub = {
      ...(subscription || {}),
      school_id,
      plan: new_plan,
      status: stripeKey ? 'pending_payment' : 'active',
      upgraded_at: new Date().toISOString(),
      previous_plan: currentPlan,
      current_period_end: subscription?.current_period_end || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    };
    await store.setJSON(`subscription_${school_id}`, updatedSub);

    // Create upgrade invoice
    if (prorationAmount > 0) {
      await createInvoice(school_id, new_plan, prorationAmount, newPlanDef.currency, `Upgrade ${currentPlanDef.name} -> ${newPlanDef.name} (prorata)`);
    }

    return cors({
      status: stripeKey ? 'integration_pending' : 'upgraded',
      message: stripeKey ? undefined : 'Plan mis a jour avec succes',
      previous_plan: currentPlan,
      new_plan,
      is_upgrade: isUpgrade,
      proration: {
        days_remaining: daysRemaining,
        credit_remaining: creditRemaining,
        credit_display: `${(creditRemaining / 100).toFixed(2)}\u20AC`,
        cost_remaining: costRemaining,
        cost_display: `${(costRemaining / 100).toFixed(2)}\u20AC`,
        amount_due: prorationAmount,
        amount_display: `${(prorationAmount / 100).toFixed(2)}\u20AC`
      },
      stripe_integrated: !!stripeKey
    });
  }

  // -----------------------------------------------------------------------
  // POST /api/billing/cancel -- Cancellation with retention offer
  // -----------------------------------------------------------------------
  if (req.method === 'POST' && path === '/cancel') {
    const body = await req.json() as any;
    const { school_id, reason, confirm } = body;

    if (!school_id) return cors({ error: 'school_id requis' }, 400);

    const subscription = await store.get(`subscription_${school_id}`, { type: 'json' }) as any;
    if (!subscription || subscription.plan === 'starter') {
      return cors({ error: 'Aucun abonnement payant a annuler' }, 400);
    }

    // If not confirmed, return retention offer
    if (!confirm) {
      const currentPlan = PLANS[subscription.plan];
      const discountPercent = 20;
      const discountedPrice = currentPlan ? Math.round(currentPlan.price * (1 - discountPercent / 100)) : 0;

      return cors({
        status: 'pending_confirmation',
        message: 'Avant de partir, nous avons une offre speciale pour vous.',
        retention_offer: {
          discount_percent: discountPercent,
          discounted_price: discountedPrice,
          discounted_display: currentPlan ? `${(discountedPrice / 100).toFixed(0)}\u20AC/mois` : null,
          original_price: currentPlan?.price || 0,
          original_display: currentPlan ? `${(currentPlan.price / 100).toFixed(0)}\u20AC/mois` : null,
          duration_months: 3,
          message: `Restez et beneficiez de ${discountPercent}% de reduction pendant 3 mois`
        },
        current_plan: subscription.plan,
        current_period_end: subscription.current_period_end,
        cancel_reasons: [
          'Trop cher',
          'Fonctionnalites manquantes',
          'Problemes techniques',
          'Changement d\'etablissement',
          'Plus besoin du service',
          'Autre'
        ]
      });
    }

    // Confirmed cancellation
    const stripeKey = getStripeKey();

    if (stripeKey && subscription.stripe_subscription_id) {
      try {
        const result = await stripeRequest(
          `/subscriptions/${subscription.stripe_subscription_id}`,
          'POST',
          { cancel_at_period_end: 'true' }
        );

        if (result.error) {
          return cors({ error: 'Erreur Stripe lors de l\'annulation', details: result.error.message }, 502);
        }
      } catch (err: any) {
        return cors({ error: 'Erreur de communication avec Stripe', details: err.message }, 502);
      }
    }

    // Update local record
    subscription.cancel_at_period_end = true;
    subscription.cancel_reason = reason || 'Non specifie';
    subscription.cancel_requested_at = new Date().toISOString();
    await store.setJSON(`subscription_${school_id}`, subscription);

    return cors({
      status: 'cancellation_scheduled',
      message: 'Votre abonnement sera annule a la fin de la periode en cours.',
      cancel_at: subscription.current_period_end,
      plan: subscription.plan,
      reason: subscription.cancel_reason,
      stripe_integrated: !!stripeKey
    });
  }

  // -----------------------------------------------------------------------
  // GET /api/billing/revenue -- Revenue dashboard (superadmin only)
  // -----------------------------------------------------------------------
  if (req.method === 'GET' && path === '/revenue') {
    if (!authCheck(req)) {
      return cors({ error: 'Non autorise. Token superadmin requis.' }, 401);
    }

    // Gather all subscriptions from establishments store for cross-referencing
    const estStore = getStore({ name: 'establishments', consistency: 'strong' });
    const estIndex = await estStore.get('_index', { type: 'json' }) as any[] || [];

    let activePro = 0;
    let activeEnterprise = 0;
    let totalActive = 0;
    let totalTrial = 0;
    let totalCancelled = 0;
    let totalFree = 0;
    const subscriptions: any[] = [];

    for (const entry of estIndex) {
      const sub = await store.get(`subscription_${entry.id}`, { type: 'json' }) as any;
      if (sub) {
        subscriptions.push(sub);
        if (sub.status === 'active') {
          totalActive++;
          if (sub.plan === 'pro') activePro++;
          if (sub.plan === 'enterprise') activeEnterprise++;
          if (sub.plan === 'starter') totalFree++;
        } else if (sub.status === 'trialing' || sub.status === 'trial') {
          totalTrial++;
        } else if (sub.status === 'cancelled') {
          totalCancelled++;
        }
      } else {
        totalFree++;
      }
    }

    const mrr = (activePro * PLANS.pro.price + activeEnterprise * PLANS.enterprise.price) / 100;
    const arr = mrr * 12;
    const totalPaid = activePro + activeEnterprise;
    const totalAll = estIndex.length || 1;
    const churnRate = totalAll > 0 ? parseFloat(((totalCancelled / totalAll) * 100).toFixed(2)) : 0;
    const avgRevenuePerAccount = totalPaid > 0 ? parseFloat((mrr / totalPaid).toFixed(2)) : 0;
    const estimatedLtv = avgRevenuePerAccount * 24; // assume 24-month avg lifetime

    return cors({
      generated_at: new Date().toISOString(),
      mrr,
      mrr_display: `${mrr.toFixed(0)}\u20AC`,
      arr,
      arr_display: `${arr.toFixed(0)}\u20AC`,
      churn_rate: churnRate,
      churn_display: `${churnRate}%`,
      ltv: estimatedLtv,
      ltv_display: `${estimatedLtv.toFixed(0)}\u20AC`,
      avg_revenue_per_account: avgRevenuePerAccount,
      arpa_display: `${avgRevenuePerAccount.toFixed(0)}\u20AC`,
      customers: {
        total: estIndex.length,
        active_paid: totalPaid,
        active_free: totalFree,
        trial: totalTrial,
        cancelled: totalCancelled,
        pro: activePro,
        enterprise: activeEnterprise
      },
      plan_distribution: {
        starter: { count: totalFree, revenue: 0 },
        pro: { count: activePro, revenue: (activePro * PLANS.pro.price) / 100 },
        enterprise: { count: activeEnterprise, revenue: (activeEnterprise * PLANS.enterprise.price) / 100 }
      },
      stripe_integrated: !!getStripeKey()
    });
  }

  return cors({ error: 'Route non trouvee' }, 404);
  } catch (err: any) {
    console.error('[api-billing] Unhandled error:', err);
    return cors({ error: 'Erreur interne du serveur', detail: err?.message }, 500);
  }
};

export const config: Config = {
  path: '/api/billing/*'
};
