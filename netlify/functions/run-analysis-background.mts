import type { Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const SYSTEM_PROMPT = `You are a senior contract-review attorney conducting a rigorous risk audit of a document for another attorney at your firm, and also translating specific named clauses into plain English for the person who is about to sign. You read closely, cite the document's actual language, and never invent clauses that are not present in the text. You output only valid JSON — no prose outside the JSON, no markdown code fences, no preamble or sign-off.`;

function buildUserPrompt(documentText: string): string {
  return `Conduct a loophole audit of the document below. Produce exactly four types of findings, each grounded in the document's actual text.

1. CONTRADICTIONS — places where two clauses conflict, overlap incompatibly, or one section undermines another (e.g. differing notice periods, conflicting termination rights, a term defined one way and used another).
2. VAGUE OR UNDEFINED TERMS — words or phrases doing real legal work but left undefined or open to interpretation (e.g. "reasonable," "material," "as needed," "promptly," an undefined defined-term).
3. GAPS — things the document does NOT prohibit, require, or address that a careful counterparty could exploit (e.g. no confidentiality survival clause, no cap on scope changes, silence on subcontracting, no remedy for late delivery).
4. KEY CLAUSES CHECK — search specifically for these four named clause types, in this exact order, and report on every one of them whether present or absent: Auto-Renewal, Arbitration, Indemnification, Entire Agreement (merger clause). For each: say whether it's present, quote it if present (leave the quote empty if absent), and give a two-sentence plain-English translation of what it means for the person about to sign — written for a non-lawyer, not for another attorney. If absent, explain what that absence means for the signer instead.

Rules:
- Quote the actual document text for clauseA / clauseB / context / quote fields (short excerpts, under 25 words each).
- Do not invent clauses that are not present in the document.
- Cap contradictions, vagueTerms, and gaps at 10 items each, ranked by severity/importance first.
- keyClauses always has exactly 4 entries, in the fixed order above, regardless of how many are present.
- Keep each explanation and suggestedFix / suggestedAddition to one or two sentences.
- If a category has zero genuine findings, return an empty array for it — never manufacture findings to fill space.

Document:
<document>
${documentText}
</document>

Respond with ONLY this JSON shape, nothing else, no markdown fences:
{"summary":"one short paragraph (2-3 sentences) on overall risk posture","contradictions":[{"title":"","severity":"High|Medium|Low","clauseA":"","clauseB":"","explanation":""}],"vagueTerms":[{"term":"","context":"","whyVague":"","suggestedFix":""}],"gaps":[{"title":"","risk":"High|Medium|Low","explanation":"","suggestedAddition":""}],"keyClauses":[{"clause":"Auto-Renewal","present":true,"quote":"","plainEnglish":""},{"clause":"Arbitration","present":true,"quote":"","plainEnglish":""},{"clause":"Indemnification","present":true,"quote":"","plainEnglish":""},{"clause":"Entire Agreement","present":true,"quote":"","plainEnglish":""}]}`;
}

export default async (req: Request, context: Context) => {
  const store = getStore({ name: "loophole-jobs", consistency: "strong" });

  let jobId = "";
  let documentText = "";
  try {
    const body = await req.json();
    jobId = body.jobId;
    documentText = body.documentText;
  } catch (err) {
    console.error("run-analysis-background: invalid request body", err);
    return;
  }

  if (!jobId) return;

  const apiKey = Netlify.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    await store.setJSON(jobId, {
      status: "error",
      error: "This site doesn't have an ANTHROPIC_API_KEY set.",
    });
    return;
  }

  try {
    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 5000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserPrompt(documentText) }],
      }),
    });

    if (!anthropicRes.ok) {
      const errBody = await anthropicRes.text();
      console.error("Anthropic API error:", anthropicRes.status, errBody);
      await store.setJSON(jobId, {
        status: "error",
        error: `Analysis service error (${anthropicRes.status}). Try again shortly.`,
      });
      return;
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
      await store.setJSON(jobId, {
        status: "error",
        error: "The review didn't complete cleanly. Try again, or trim the document.",
      });
      return;
    }

    const defaultKeyClauses = ["Auto-Renewal", "Arbitration", "Indemnification", "Entire Agreement"].map(
      (clause) => ({ clause, present: false, quote: "", plainEnglish: "Not evaluated." })
    );

    const safe = {
      summary: parsed.summary || "",
      contradictions: Array.isArray(parsed.contradictions) ? parsed.contradictions : [],
      vagueTerms: Array.isArray(parsed.vagueTerms) ? parsed.vagueTerms : [],
      gaps: Array.isArray(parsed.gaps) ? parsed.gaps : [],
      keyClauses:
        Array.isArray(parsed.keyClauses) && parsed.keyClauses.length === 4
          ? parsed.keyClauses
          : defaultKeyClauses,
    };

    await store.setJSON(jobId, { status: "done", result: safe, finishedAt: Date.now() });
  } catch (err) {
    console.error("run-analysis-background error:", err);
    await store.setJSON(jobId, {
      status: "error",
      error: "The review didn't complete cleanly. Try again shortly.",
    });
  }
};
