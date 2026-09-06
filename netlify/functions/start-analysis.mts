import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const MAX_CHARS = 150000; // roughly 70-80 pages of dense text

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  let documentText = "";
  try {
    const body = await req.json();
    documentText = typeof body.documentText === "string" ? body.documentText : "";
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!documentText.trim()) {
    return new Response(JSON.stringify({ error: "No document text provided" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (documentText.length > MAX_CHARS) {
    return new Response(
      JSON.stringify({
        error: `This document is too long for now (${documentText.length.toLocaleString()} characters, limit is ${MAX_CHARS.toLocaleString()}). Trim it and try again.`,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const apiKey = Netlify.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return new Response(
      JSON.stringify({
        error:
          "This site doesn't have an ANTHROPIC_API_KEY set yet. Add one in Site configuration > Environment variables.",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  // Cost guard, three tiers:
  // 1. Static admin ACCESS_CODE — unlimited, no metering (your own testing).
  // 2. A subscriber code — capped at their monthly allowance.
  // 3. No code at all — free tier, capped at FREE_TIER_LIMIT per visitor,
  //    tracked by an anonymous id the browser generates and persists.
  const FREE_TIER_LIMIT = 2;
  const requiredCode = Netlify.env.get("ACCESS_CODE");
  const providedCode = req.headers.get("x-access-code") || "";
  const visitorId = req.headers.get("x-visitor-id") || "";

  let usingSubscriberCode = false;
  let subscriberStore;
  let subscriberRecord: any = null;
  let usingFreeTier = false;
  let freeTierStore;
  let freeTierCount = 0;

  if (requiredCode && providedCode === requiredCode) {
    // Admin/testing code — unlimited, no metering.
  } else if (providedCode) {
    subscriberStore = getStore({ name: "subscribers", consistency: "strong" });
    subscriberRecord = await subscriberStore.get(providedCode, { type: "json" });

    if (!subscriberRecord) {
      return new Response(JSON.stringify({ error: "Invalid or missing access code." }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (subscriberRecord.status !== "active") {
      return new Response(
        JSON.stringify({
          error:
            subscriberRecord.status === "past_due"
              ? "Your last payment didn't go through. Update your card to keep using Loophole Finder Pro."
              : "This subscription isn't active.",
        }),
        { status: 402, headers: { "Content-Type": "application/json" } }
      );
    }
    if (subscriberRecord.documentsUsed >= subscriberRecord.documentsAllowed) {
      const resetDate = subscriberRecord.currentPeriodEnd
        ? new Date(subscriberRecord.currentPeriodEnd * 1000).toLocaleDateString()
        : "your next billing date";
      return new Response(
        JSON.stringify({
          error: `You've used all ${subscriberRecord.documentsAllowed} documents included this billing period. Resets on ${resetDate}.`,
        }),
        { status: 402, headers: { "Content-Type": "application/json" } }
      );
    }
    usingSubscriberCode = true;
  } else {
    // No code provided at all — free tier.
    if (!visitorId) {
      return new Response(
        JSON.stringify({ error: "Couldn't identify this browser session. Refresh the page and try again." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
    freeTierStore = getStore({ name: "free-usage", consistency: "strong" });
    const existing = await freeTierStore.get(visitorId, { type: "json" });
    freeTierCount = (existing as any)?.count || 0;

    if (freeTierCount >= FREE_TIER_LIMIT) {
      return new Response(
        JSON.stringify({
          error: `You've used your ${FREE_TIER_LIMIT} free reviews. Enter an access code, or subscribe for more.`,
        }),
        { status: 402, headers: { "Content-Type": "application/json" } }
      );
    }
    usingFreeTier = true;
  }

  const jobId = crypto.randomUUID();
  const store = getStore({ name: "loophole-jobs", consistency: "strong" });
  await store.setJSON(jobId, { status: "pending", createdAt: Date.now() });

  if (usingSubscriberCode && subscriberStore && subscriberRecord) {
    await subscriberStore.setJSON(providedCode, {
      ...subscriberRecord,
      documentsUsed: subscriberRecord.documentsUsed + 1,
    });
  }
  if (usingFreeTier && freeTierStore) {
    await freeTierStore.setJSON(visitorId, { count: freeTierCount + 1 });
  }

  // Hand off to the background function and don't wait for it to finish —
  // just confirm it was accepted, then return the job id right away.
  const origin = new URL(req.url).origin;
  try {
    await fetch(`${origin}/.netlify/functions/run-analysis-background`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId, documentText }),
    });
  } catch (err) {
    console.error("Failed to trigger background analysis:", err);
    await store.setJSON(jobId, {
      status: "error",
      error: "Couldn't start the review. Try again.",
    });
  }

  return new Response(JSON.stringify({ jobId }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/start-analysis",
};
