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

  const jobId = crypto.randomUUID();
  const store = getStore({ name: "loophole-jobs", consistency: "strong" });
  await store.setJSON(jobId, { status: "pending", createdAt: Date.now() });

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
