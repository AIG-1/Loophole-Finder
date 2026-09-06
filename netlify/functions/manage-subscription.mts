import type { Context, Config } from "@netlify/functions";
import Stripe from "stripe";
import { getStore } from "@netlify/blobs";

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  let code = "";
  try {
    const body = await req.json();
    code = typeof body.code === "string" ? body.code.trim() : "";
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!code) {
    return new Response(JSON.stringify({ error: "Enter your access code first." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const subscribers = getStore({ name: "subscribers", consistency: "strong" });
  const record = (await subscribers.get(code, { type: "json" })) as any;

  if (!record) {
    return new Response(JSON.stringify({ error: "That code doesn't match a subscription." }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (!record.stripeCustomerId) {
    return new Response(
      JSON.stringify({ error: "This code is a single-document purchase, not a subscription — nothing to manage." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const secretKey = Netlify.env.get("STRIPE_SECRET_KEY");
  if (!secretKey) {
    return new Response(JSON.stringify({ error: "Server not configured." }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const stripe = new Stripe(secretKey);
  const origin = new URL(req.url).origin;

  try {
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: record.stripeCustomerId,
      return_url: `${origin}/`,
    });
    return new Response(JSON.stringify({ url: portalSession.url }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("manage-subscription error:", err);
    return new Response(
      JSON.stringify({
        error:
          "Couldn't open the subscription management page. If this keeps happening, the Customer Portal may need to be enabled in Stripe settings first.",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};

export const config: Config = {
  path: "/api/manage-subscription",
};
