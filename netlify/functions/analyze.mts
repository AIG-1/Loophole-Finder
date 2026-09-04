import type { Context, Config } from "@netlify/functions";

const SYSTEM_PROMPT = `You are a senior contract-review attorney conducting a rigorous risk audit of a document for another attorney at your firm. You read closely, cite the document's actual language, and never invent clauses that are not present in the text. You output only valid JSON — no prose outside the JSON, no markdown code fences, no preamble or sign-off.`;

function buildUserPrompt(documentText: string): string {
  return `Conduct a loophole audit of the document below. Produce exactly three types of findings, each grounded in the document's actual text.

1. CONTRADICTIONS — places where two clauses conflict, overlap incompatibly, or one section undermines another (e.g. differing notice periods, conflicting termination rights, a term defined one way and used another).
2. VAGUE OR UNDEFINED TERMS — words or phrases doing real legal work but left undefined or open to interpretation (e.g. "reasonable," "material," "as needed," "promptly," an undefined defined-term).
3. GAPS — things the document does NOT prohibit, require, or address that a careful counterparty could exploit (e.g. no confidentiality survival clause, no cap on scope changes, silence on subcontracting, no remedy for late delivery).

Rules:
- Quote the actual document text for clauseA / clauseB / context fields (short excerpts, under 25 words each).
- Do not invent clauses that are not present in the document.
- Cap each category at 6 items, ranked by severity/importance first.
- Keep each explanation and suggestedFix / suggestedAddition to one short sentence.
- If a category has zero genuine findings, return an empty array for it — never manufacture findings to fill space.

Document:
<document>
${documentText}
</document>

Respond with ONLY this JSON shape, nothing else, no markdown fences:
{"summary":"one short paragraph (2-3 sentences) on overall risk posture","contradictions":[{"title":"","severity":"High|Medium|Low","clauseA":"","clauseB":"","explanation":""}],"vagueTerms":[{"term":"","context":"","whyVague":"","suggestedFix":""}],"gaps":[{"title":"","risk":"High|Medium|Low","explanation":"","suggestedAddition":""}]}`;
}

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

  // Guard against runaway input on this endpoint.
  if (documentText.length > 200000) {
    documentText = documentText.slice(0, 200000);
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

  // Netlify kills this function at ~30s. Cut our own request off at 25s so
  // we always get to return a clean JSON error instead of a raw platform 502.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000);

  try {
    let anthropicRes: Response;
    try {
      anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1800,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: buildUserPrompt(documentText) }],
        }),
        signal: controller.signal,
      });
    } catch (fetchErr: any) {
      if (fetchErr?.name === "AbortError") {
        return new Response(
          JSON.stringify({
            error:
              "The review is taking longer than this server allows. Try a shorter document, or split it into sections.",
          }),
          { status: 504, headers: { "Content-Type": "application/json" } }
        );
      }
      throw fetchErr;
    } finally {
      clearTimeout(timeoutId);
    }

    if (!anthropicRes.ok) {
      const errBody = await anthropicRes.text();
      console.error("Anthropic API error:", anthropicRes.status, errBody);
      return new Response(
        JSON.stringify({ error: `Analysis service error (${anthropicRes.status}). Try again shortly.` }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    const data = await anthropicRes.json();
    const textBlocks = (data.content || [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");
    const cleaned = textBlocks.replace(/```json|```/g, "").trim();

    let parsed: any;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      console.error("Failed to parse model output as JSON:", cleaned.slice(0, 500));
      return new Response(
        JSON.stringify({ error: "The review didn't complete cleanly. Try again, or trim the document." }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    const safe = {
      summary: parsed.summary || "",
      contradictions: Array.isArray(parsed.contradictions) ? parsed.contradictions : [],
      vagueTerms: Array.isArray(parsed.vagueTerms) ? parsed.vagueTerms : [],
      gaps: Array.isArray(parsed.gaps) ? parsed.gaps : [],
    };

    return new Response(JSON.stringify(safe), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("analyze function error:", err);
    return new Response(
      JSON.stringify({ error: "The review didn't complete cleanly. Try again shortly." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};

export const config: Config = {
  path: "/api/analyze",
};
