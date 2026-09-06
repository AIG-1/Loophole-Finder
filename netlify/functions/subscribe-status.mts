import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("session_id");

  if (!sessionId) {
    return new Response(JSON.stringify({ error: "Missing session_id" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const sessionIndex = getStore({ name: "session-index", consistency: "strong" });
  const code = await sessionIndex.get(sessionId, { type: "text" });

  if (!code) {
    // Webhook may not have landed yet — client should retry briefly.
    return new Response(JSON.stringify({ ready: false }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ ready: true, code }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/subscribe-status",
};
