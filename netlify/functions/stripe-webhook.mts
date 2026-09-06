import type { Context, Config } from "@netlify/functions";
import Stripe from "stripe";
import { getStore } from "@netlify/blobs";

const DOCUMENTS_PER_MONTH = 10;

function generateAccessCode(): string {
  // Short, easy to read/type/share: e.g. LF-7K3P-Q9XR
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I ambiguity
  const part = (len: number) =>
    Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return `LF-${part(4)}-${part(4)}`;
}

export default async (req: Request, context: Context) => {
  const secretKey = Netlify.env.get("STRIPE_SECRET_KEY");
  const webhookSecret = Netlify.env.get("STRIPE_WEBHOOK_SECRET");

  if (!secretKey || !webhookSecret) {
    console.error("Stripe env vars not configured (STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET).");
    return new Response("Server not configured", { status: 500 });
  }

  const stripe = new Stripe(secretKey);
  const signature = req.headers.get("stripe-signature") || "";
  const rawBody = await req.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    console.error("Webhook signature verification failed:", err);
    return new Response("Invalid signature", { status: 400 });
  }

  const subscribers = getStore({ name: "subscribers", consistency: "strong" });
  const customerIndex = getStore({ name: "customer-index", consistency: "strong" });
  const sessionIndex = getStore({ name: "session-index", consistency: "strong" });

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
        const subscriptionId =
          typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
        if (!customerId || !subscriptionId) break;

        // Avoid creating a duplicate code if this customer already has one
        const existingCode = await customerIndex.get(customerId, { type: "text" });
        const code = existingCode || generateAccessCode();

        const subscription = await stripe.subscriptions.retrieve(subscriptionId);

        await subscribers.setJSON(code, {
          code,
          stripeCustomerId: customerId,
          subscriptionId,
          email: session.customer_details?.email || null,
          documentsUsed: 0,
          documentsAllowed: DOCUMENTS_PER_MONTH,
          status: "active",
          currentPeriodEnd: (subscription as any).current_period_end || null,
        });
        await customerIndex.set(customerId, code);
        await sessionIndex.set(session.id, code);
        break;
      }

      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
        if (!customerId) break;
        const code = await customerIndex.get(customerId, { type: "text" });
        if (!code) break;
        const record = await subscribers.get(code, { type: "json" });
        if (!record) break;
        await subscribers.setJSON(code, {
          ...(record as object),
          documentsUsed: 0,
          status: "active",
        });
        break;
      }

      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId =
          typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id;
        if (!customerId) break;
        const code = await customerIndex.get(customerId, { type: "text" });
        if (!code) break;
        const record = await subscribers.get(code, { type: "json" });
        if (!record) break;
        const stillGood = subscription.status === "active" || subscription.status === "trialing";
        await subscribers.setJSON(code, {
          ...(record as object),
          status: stillGood ? "active" : "inactive",
        });
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId =
          typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id;
        if (!customerId) break;
        const code = await customerIndex.get(customerId, { type: "text" });
        if (!code) break;
        const record = await subscribers.get(code, { type: "json" });
        if (!record) break;
        await subscribers.setJSON(code, { ...(record as object), status: "canceled" });
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
        if (!customerId) break;
        const code = await customerIndex.get(customerId, { type: "text" });
        if (!code) break;
        const record = await subscribers.get(code, { type: "json" });
        if (!record) break;
        await subscribers.setJSON(code, { ...(record as object), status: "past_due" });
        break;
      }
    }
  } catch (err) {
    console.error("stripe-webhook handler error:", err);
    return new Response("Webhook handler error", { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/stripe-webhook",
};
