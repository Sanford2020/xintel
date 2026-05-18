import { getLogger } from "../utils/logger.js";

export interface SubscriptionInfo {
  customerId: string;
  status: "active" | "past_due" | "canceled" | "trialing" | "none";
  tier: "free" | "basic" | "pro";
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

export interface StripeConfig {
  secretKey: string;
  webhookSecret?: string;
  priceIds: {
    basic: string;
    pro: string;
  };
}

function getStripeConfig(): StripeConfig | null {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return null;
  return {
    secretKey,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    priceIds: {
      basic: process.env.STRIPE_PRICE_BASIC ?? "",
      pro: process.env.STRIPE_PRICE_PRO ?? "",
    },
  };
}

export async function checkSubscription(
  email: string,
): Promise<SubscriptionInfo> {
  const config = getStripeConfig();
  if (!config) {
    return {
      customerId: "",
      status: "none",
      tier: "free",
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
    };
  }

  const log = getLogger();
  try {
    const searchResp = await fetch(
      `https://api.stripe.com/v1/customers/search?query=email:'${encodeURIComponent(email)}'`,
      {
        headers: { authorization: `Bearer ${config.secretKey}` },
      },
    );
    if (!searchResp.ok) {
      log.warn({ status: searchResp.status }, "Stripe customer search failed");
      return fallbackFree();
    }
    const searchData = (await searchResp.json()) as {
      data: Array<{ id: string }>;
    };
    if (searchData.data.length === 0) return fallbackFree();

    const customerId = searchData.data[0]!.id;
    const subsResp = await fetch(
      `https://api.stripe.com/v1/subscriptions?customer=${customerId}&status=all&limit=1`,
      {
        headers: { authorization: `Bearer ${config.secretKey}` },
      },
    );
    if (!subsResp.ok) {
      log.warn({ status: subsResp.status }, "Stripe subscriptions fetch failed");
      return fallbackFree();
    }
    const subsData = (await subsResp.json()) as {
      data: Array<{
        status: string;
        current_period_end: number;
        cancel_at_period_end: boolean;
        items: { data: Array<{ price: { id: string } }> };
      }>;
    };
    if (subsData.data.length === 0) {
      return { customerId, status: "none", tier: "free", currentPeriodEnd: null, cancelAtPeriodEnd: false };
    }

    const sub = subsData.data[0]!;
    const priceId = sub.items.data[0]?.price.id ?? "";
    const tier = priceId === config.priceIds.pro
      ? "pro"
      : priceId === config.priceIds.basic
        ? "basic"
        : "free";

    return {
      customerId,
      status: sub.status as SubscriptionInfo["status"],
      tier,
      currentPeriodEnd: new Date(sub.current_period_end * 1000).toISOString(),
      cancelAtPeriodEnd: sub.cancel_at_period_end,
    };
  } catch (err) {
    log.error({ err: (err as Error).message }, "Stripe check failed");
    return fallbackFree();
  }
}

function fallbackFree(): SubscriptionInfo {
  return {
    customerId: "",
    status: "none",
    tier: "free",
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
  };
}

export async function createCheckoutUrl(
  email: string,
  tier: "basic" | "pro",
  successUrl: string,
  cancelUrl: string,
): Promise<string | null> {
  const config = getStripeConfig();
  if (!config) return null;

  const log = getLogger();
  const priceId = tier === "pro" ? config.priceIds.pro : config.priceIds.basic;
  if (!priceId) {
    log.warn({ tier }, "No Stripe price ID configured for tier");
    return null;
  }

  try {
    const body = new URLSearchParams({
      "mode": "subscription",
      "customer_email": email,
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": "1",
      "success_url": successUrl,
      "cancel_url": cancelUrl,
    });
    const resp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.secretKey}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    if (!resp.ok) {
      const text = await resp.text();
      log.error({ status: resp.status, body: text.slice(0, 300) }, "Stripe checkout creation failed");
      return null;
    }
    const data = (await resp.json()) as { url: string };
    return data.url;
  } catch (err) {
    log.error({ err: (err as Error).message }, "Stripe checkout error");
    return null;
  }
}
