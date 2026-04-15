import { Router } from "express";

const router = Router();

router.post("/rewrite-phrases", async (req, res) => {
  const { phrases, subreddits } = req.body as {
    phrases: string[];
    subreddits?: string[];
  };

  if (!Array.isArray(phrases) || phrases.length === 0) {
    res.status(400).json({ error: "phrases must be a non-empty array" });
    return;
  }

  const baseUrl = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;

  if (!baseUrl || !apiKey) {
    res.status(503).json({ error: "AI integration not configured" });
    return;
  }

  const context = subreddits?.length
    ? `r/${subreddits.join(", r/")}`
    : "entrepreneurship and business communities";

  const prompt = `You are cleaning up pain-point phrases extracted from Reddit communities (${context}) for a market research report.

Each phrase must be a complete, clear problem statement that a founder or product manager can immediately understand. 

Rules:
- Start with a verb describing the struggle (e.g. "struggling to", "unable to", "failing to", "can't", "losing") OR a concrete noun describing the problem (e.g. "payment failures", "customer churn")
- 4–9 words long
- Self-contained — readable without any surrounding context
- Specific — describes a real, concrete problem, not a vague activity
- Do NOT use "you" as the subject
- Remove filler words, numbers, years, or phrases like "keep going" that don't describe a problem
- If a phrase is already a clear problem statement, return it unchanged

Return ONLY a JSON array of exactly ${phrases.length} strings, one rewritten phrase per input, in the same order. No explanation, no markdown, no extra text.

Input phrases:
${phrases.map((p, i) => `${i + 1}. "${p}"`).join("\n")}`;

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-5-nano",
        max_completion_tokens: 512,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI returned ${response.status}`);
    }

    const json = await response.json() as {
      choices: Array<{ message: { content: string } }>;
    };
    const content = json.choices?.[0]?.message?.content?.trim() ?? "";

    const rewritten: string[] = JSON.parse(content);

    if (!Array.isArray(rewritten) || rewritten.length !== phrases.length) {
      throw new Error("Unexpected response shape");
    }

    res.json({ phrases: rewritten });
  } catch {
    res.json({ phrases });
  }
});

export default router;
