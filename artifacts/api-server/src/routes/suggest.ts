import { Router } from "express";

const router = Router();

const TIER_FORMATS = {
  low: ["PDF Guide", "Template Pack", "Email Course", "Notion Template", "Checklist", "Directory"],
  mid: ["Chrome Extension", "Web App", "CLI Tool", "API Tool", "Automation Template", "Free Tool"],
  full: ["SaaS", "AI Platform", "B2B SaaS", "Marketplace", "Vertical SaaS", "API Platform"],
};

router.post("/suggest-products", async (req, res) => {
  const { painPoints, topics, totalComments } = req.body as {
    painPoints: Array<{ phrase: string; count: number; noSolution: boolean }>;
    topics: string[];
    totalComments: number;
  };

  if (!Array.isArray(painPoints) || painPoints.length === 0) {
    res.status(400).json({ error: "painPoints must be a non-empty array" });
    return;
  }

  const baseUrl = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;

  if (!baseUrl || !apiKey) {
    res.status(503).json({ error: "AI integration not configured" });
    return;
  }

  const topicContext = topics.length > 0 ? topics.join(", ") : "technology and software";
  const topPhrases = painPoints.slice(0, 5);

  const prompt = `You are a product strategist helping founders find buildable opportunities from real customer pain.

Context: ${totalComments} Hacker News comments about "${topicContext}" revealed these verified pain points.

For each pain point, propose 3 concrete product ideas at different effort levels. Sound like actual product pitches, not generic categories.

EFFORT TIERS:
- LOW (1–3 days): A zero-code or minimal-code digital product — e.g., PDF guide, template bundle, email course, checklist pack, Notion workspace, or curated directory. Must be sellable on Gumroad/Lemon Squeezy and partially address the pain.
- MID (2–6 weeks): A focused software tool — e.g., Chrome extension, simple SaaS web app, CLI tool, free online calculator, or automation template. Directly solves the problem for a specific user type.
- FULL (2–6 months): A comprehensive SaaS, AI-powered platform, marketplace, or B2B tool with a recurring revenue model. Targets the full scope of the problem.

Rules:
- Be specific to this exact pain — do NOT use generic names like "DataTool" or "PainSolver"
- title: a 2–4 word product name concept (title case, evocative)
- format: pick from — Low: [${TIER_FORMATS.low.join(", ")}] | Mid: [${TIER_FORMATS.mid.join(", ")}] | Full: [${TIER_FORMATS.full.join(", ")}]
- description: one sentence — what it does and who it saves time for

Return ONLY a JSON array, no markdown, no explanation:
[{ "phrase": "<exact phrase>", "low": {"format":"...","title":"...","description":"..."}, "mid":{...}, "full":{...} }]

Pain points (backed by ${totalComments} real HN comments):
${topPhrases.map((p, i) => `${i + 1}. "${p.phrase}" — ${p.count} mentions${p.noSolution ? " · no obvious solution exists yet" : ""}`).join("\n")}`;

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_completion_tokens: 2000,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) throw new Error(`OpenAI returned ${response.status}`);

    const json = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    const raw = json.choices?.[0]?.message?.content?.trim() ?? "";
    const cleaned = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
    const suggestions = JSON.parse(cleaned);

    res.json({ suggestions });
  } catch {
    res.json({ suggestions: [] });
  }
});

export default router;
