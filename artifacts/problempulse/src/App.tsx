import { useState, useEffect, useRef, useCallback } from "react";
import { Chart, BarController, BarElement, CategoryScale, LinearScale, Tooltip, Legend } from "chart.js";
import nlp from "compromise";

Chart.register(BarController, BarElement, CategoryScale, LinearScale, Tooltip, Legend);

// ─── Google Analytics ─────────────────────────────────────────────────────────

const GA_ID = "G-8V28F53XS9";
const CONSENT_KEY = "pp_cookie_consent";

declare global {
  interface Window {
    dataLayer: unknown[];
    gtag: (...args: unknown[]) => void;
  }
}

function loadGA() {
  if (document.getElementById("ga-script")) return;
  const script = document.createElement("script");
  script.id = "ga-script";
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
  document.head.appendChild(script);
  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag(...args: unknown[]) { window.dataLayer.push(args); };
  window.gtag("js", new Date());
  window.gtag("config", GA_ID, { anonymize_ip: true });
}

function disableGA() {
  (window as unknown as Record<string, unknown>)[`ga-disable-${GA_ID}`] = true;
  ["_ga", "_gid", "_gat"].forEach((name) => {
    document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=${location.hostname}`;
  });
}

type ConsentValue = "accepted" | "declined" | null;

function getStoredConsent(): ConsentValue {
  try {
    const v = localStorage.getItem(CONSENT_KEY);
    if (v === "accepted" || v === "declined") return v;
  } catch { /* ignore */ }
  return null;
}

function persistConsent(v: "accepted" | "declined") {
  try { localStorage.setItem(CONSENT_KEY, v); } catch { /* ignore */ }
  if (v === "accepted") loadGA();
  else disableGA();
}

type Phase = "landing" | "onboarding" | "loading" | "results" | "error";

// ─── Types ────────────────────────────────────────────────────────────────────

interface HNTopic {
  id: string;
  label: string;
  query: string;
  icon: string;
}

interface PainPoint {
  phrase: string;
  count: number;
  posts: string[];
  evidence: string[];
  noSolution: boolean;
}

interface LoadingStep {
  label: string;
  status: "pending" | "active" | "done";
}

interface UrgentProblem {
  id: string;
  title: string;
  cleanTitle: string;
  category: string;
  categoryIcon: string;
  categoryColor: string;
  urgencyScore: number;
  commentCount: number;
  points: number;
  ageHours: number;
  hnUrl: string;
}

interface ThreadAnalysis {
  painPhrases: Array<{ phrase: string; count: number; evidence: string[] }>;
  wishStatements: string[];
  solutionGapPct: number;
  totalPainComments: number;
  totalComments: number;
}

interface SuggestionTier {
  format: string;
  title: string;
  description: string;
}

interface ProductSuggestion {
  phrase: string;
  low: SuggestionTier;
  mid: SuggestionTier;
  full: SuggestionTier;
}

// ─── HN Topic categories ──────────────────────────────────────────────────────

const HN_TOPICS: HNTopic[] = [
  { id: "saas", label: "SaaS & B2B", query: "SaaS software product subscription B2B", icon: "📦" },
  { id: "startup", label: "Startups", query: "startup founder building indie hacker side project", icon: "🚀" },
  { id: "devtools", label: "Dev Tools", query: "developer tools programming workflow IDE editor", icon: "🛠️" },
  { id: "ai", label: "AI & ML", query: "AI machine learning LLM GPT model training", icon: "🤖" },
  { id: "productivity", label: "Productivity", query: "productivity workflow automation focus task management", icon: "⚡" },
  { id: "hiring", label: "Hiring & Jobs", query: "hiring interview job career remote work", icon: "💼" },
  { id: "design", label: "Design & UX", query: "design UX user interface product usability", icon: "🎨" },
  { id: "data", label: "Data & Analytics", query: "data analytics database pipeline warehouse", icon: "📊" },
  { id: "marketing", label: "Marketing & Growth", query: "marketing growth SEO acquisition retention", icon: "📈" },
  { id: "finance", label: "Finance & Payments", query: "finance payments billing subscription pricing fintech", icon: "💳" },
  { id: "security", label: "Security & Privacy", query: "security privacy authentication compliance infosec", icon: "🔒" },
  { id: "remote", label: "Remote Work", query: "remote work distributed team async communication", icon: "🌍" },
];

// ─── Stop words ───────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "the","a","an","and","or","but","in","on","at","to","for","of","with",
  "by","from","up","about","into","through","is","are","was","were","be",
  "been","being","have","has","had","do","does","did","will","would","could",
  "should","may","might","shall","can","need","dare","ought","used","that",
  "this","these","those","it","its","i","me","my","we","our","you","your",
  "he","she","they","them","their","what","which","who","how","when","where",
  "why","all","each","every","both","few","more","most","other","some","such",
  "no","not","only","same","so","than","too","very","just","also","any","get",
  "got","my","im","ive","dont","doesnt","didnt","cant","wont","isnt","arent",
]);

function keywords(phrase: string): string[] {
  return phrase
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w));
}

function sharedKeywordCount(a: string, b: string): number {
  const ka = keywords(a);
  const kb = keywords(b);
  let shared = 0;
  for (const wa of ka) {
    for (const wb of kb) {
      if (wa.slice(0, 5) === wb.slice(0, 5)) { shared++; break; }
    }
  }
  return shared;
}

function mergeSemanticGroups(
  phrases: Map<string, { count: number; posts: string[]; evidence: string[] }>
): PainPoint[] {
  const entries = [...phrases.entries()]
    .map(([phrase, data]) => ({ phrase, ...data }))
    .sort((a, b) => b.count - a.count);

  const merged: Array<{ canonical: string; count: number; posts: string[]; evidence: string[] }> = [];
  const used = new Set<number>();

  for (let i = 0; i < entries.length; i++) {
    if (used.has(i)) continue;
    const group = {
      phrases: [entries[i].phrase],
      count: entries[i].count,
      posts: [...entries[i].posts],
      evidence: [...entries[i].evidence],
    };

    for (let j = i + 1; j < entries.length; j++) {
      if (used.has(j)) continue;
      const shared = sharedKeywordCount(entries[i].phrase, entries[j].phrase);
      const kaLen = keywords(entries[i].phrase).length;
      const kbLen = keywords(entries[j].phrase).length;
      const minLen = Math.min(kaLen, kbLen);
      const shouldMerge = shared >= 2 || (minLen > 0 && shared / minLen >= 0.5);
      if (shouldMerge) {
        group.count += entries[j].count;
        group.posts = [...new Set([...group.posts, ...entries[j].posts])];
        group.evidence = [...new Set([...group.evidence, ...entries[j].evidence])].slice(0, 4);
        group.phrases.push(entries[j].phrase);
        used.add(j);
      }
    }

    const withVerb = group.phrases.filter((p) => {
      const doc = nlp(p);
      return (doc.verbs().out("array") as string[]).length > 0;
    });
    const pool = withVerb.length > 0 ? withVerb : group.phrases;
    const canonical = pool.reduce((best, p) =>
      p.split(" ").length < best.split(" ").length ? p : best
    );

    merged.push({ canonical, count: group.count, posts: group.posts, evidence: group.evidence });
    used.add(i);
  }

  return merged
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((g) => ({
      phrase: g.canonical,
      count: g.count,
      posts: g.posts,
      evidence: g.evidence.slice(0, 3),
      noSolution: g.evidence.filter(hasSolutionMention).length < Math.ceil(g.evidence.length * 0.25),
    }));
}

// ─── Pain signals ─────────────────────────────────────────────────────────────

const PAIN_SEEDS = [
  "can't", "cannot", "struggle", "struggling", "problem", "issue",
  "help", "frustrated", "frustrating", "difficult", "hard to", "hate",
  "annoying", "annoyed", "why is", "why does", "how do i", "how to",
  "need help", "lost", "stuck", "confused", "confusing", "failing", "fail",
  "broken", "not working", "keeps", "impossible", "overwhelming", "overwhelmed",
  "terrible", "horrible", "awful", "unable", "no idea", "what do i",
  "wish", "workaround", "manual", "spreadsheet", "no tool", "doesn't exist",
  "painful", "nightmare", "there should be", "someone should build",
  "why isn't there", "have to manually",
];

// Pain keywords specifically for comment scanning
const PAIN_KEYWORDS = [
  "wish", "frustrating", "frustrated", "broken", "manual", "workaround",
  "spreadsheet", "annoying", "annoyed", "hate", "no tool", "doesn't exist",
  "cant find", "can't find", "no solution", "nothing works", "have to manually",
  "painful", "nightmare", "terrible", "awful", "stuck", "impossible",
  "keeps breaking", "i wish", "why isn't there", "why is there no",
  "there should be", "someone should build", "always fails",
];

const SOLUTION_PHRASES = [
  "use ", "try ", "you can ", "there's ", "there is ", "have you tried",
  "check out", "we use", "works great", "works well", "we built", "i built",
  "i use", "just use", "we switched to", "recommend", "solved it",
];

// ─── Phrase validity guard ────────────────────────────────────────────────────

const FRAGMENT_STARTERS = new Set([
  "in","on","at","of","for","to","a","an","the","and","or","but","so",
  "because","since","although","though","while","when","where","if","that",
  "which","who","whose","with","by","from","into","about","after","before",
  "during","through","between","among","against","without","within","upon",
  "across","along","around","behind","below","beneath","beside","beyond",
  "despite","down","except","inside","near","off","outside","over","past",
  "throughout","toward","under","until","up","via","than","as","per",
]);

const FRAGMENT_ENDERS = new Set([
  "in","on","at","of","for","to","a","an","the","and","or","but","so",
  "is","are","was","were","be","been","being","has","have","had",
  "do","does","did","will","would","could","should","may","might","shall",
  "can","just","also","very","too","even","only","still","really","get",
  "got","my","your","their","its","his","her","our","this","that","these",
  "those","what","which","who","how","when","where","why","about","with",
  "by","from","into","keep","keeps","kept","not","no","more","most",
  "than","as","if","then","now","here","there","both","each","every",
  "always","never","sometimes","often","already","yet","still","back",
]);

function isValidPhrase(phrase: string): boolean {
  const words = phrase.trim().split(/\s+/);
  if (words.length < 4) return false;
  const first = words[0].toLowerCase().replace(/[^a-z]/g, "");
  const last = words[words.length - 1].toLowerCase().replace(/[^a-z]/g, "");
  if (FRAGMENT_STARTERS.has(first)) return false;
  if (FRAGMENT_ENDERS.has(last)) return false;
  const doc = nlp(phrase);
  if ((doc.verbs().out("array") as string[]).length === 0) return false;
  if ((doc.nouns().out("array") as string[]).length === 0) return false;
  const contentWords = words.filter((w) => {
    const clean = w.toLowerCase().replace(/[^a-z]/g, "");
    return clean.length >= 4 && !STOP_WORDS.has(clean);
  });
  return contentWords.length >= 2;
}

function extractPainPhrases(
  texts: string[],
  evidenceMap: Map<string, string[]>
): Map<string, { count: number; posts: string[]; evidence: string[] }> {
  const phraseMap = new Map<string, { count: number; posts: string[]; evidence: string[] }>();

  const addPhrase = (phrase: string, source: string, isComment: boolean) => {
    if (!isValidPhrase(phrase)) return;
    const normalised = phrase
      .toLowerCase().trim()
      .replace(/[^a-z0-9\s']/g, "").replace(/\s+/g, " ").trim();
    if (normalised.split(" ").length < 4) return;
    const existing = phraseMap.get(normalised);
    const ev = isComment && evidenceMap.get(source) ? [source] : [];
    if (existing) {
      existing.count++;
      if (!existing.posts.includes(source)) existing.posts.push(source);
      if (isComment && !existing.evidence.includes(source)) existing.evidence.push(source);
    } else {
      phraseMap.set(normalised, { count: 1, posts: [source], evidence: ev });
    }
  };

  for (const text of texts) {
    const lower = text.toLowerCase();
    const hasPainSignal = PAIN_SEEDS.some((seed) => lower.includes(seed));
    if (!hasPainSignal) continue;

    const isComment = evidenceMap.has(text);
    const words = text.trim().split(/\s+/);

    if (words.length >= 4 && words.length <= 18) {
      addPhrase(text, text, isComment);
    }

    const doc = nlp(text);
    const clauses = doc.clauses().out("array") as string[];
    for (const clause of clauses) {
      const cl = clause.toLowerCase();
      const clauseHasPain = PAIN_SEEDS.some((s) => cl.includes(s));
      if (!clauseHasPain) continue;
      const clauseDoc = nlp(clause);
      if ((clauseDoc.verbs().out("array") as string[]).length > 0) {
        addPhrase(clause, text, isComment);
      }
    }

    for (let size = 5; size <= 8; size++) {
      for (let start = 0; start <= words.length - size; start++) {
        const window = words.slice(start, start + size).join(" ");
        const wl = window.toLowerCase();
        if (!PAIN_SEEDS.some((s) => wl.includes(s))) continue;
        const wDoc = nlp(window);
        if ((wDoc.verbs().out("array") as string[]).length > 0) {
          addPhrase(window, text, isComment);
        }
      }
    }
  }

  return phraseMap;
}

// ─── HN helpers ───────────────────────────────────────────────────────────────

function hasPainKeyword(text: string): boolean {
  const lower = text.toLowerCase();
  return PAIN_KEYWORDS.some((k) => lower.includes(k));
}

function hasSolutionMention(text: string): boolean {
  const lower = text.toLowerCase();
  return SOLUTION_PHRASES.some((p) => lower.includes(p));
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#x2F;/g, "/")
    .replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

// ─── HN Algolia API ───────────────────────────────────────────────────────────

const HN_API = "https://hn.algolia.com/api/v1";

interface HNPost {
  objectID: string;
  title: string;
  num_comments: number;
  points: number;
  author: string;
}

interface HNComment {
  objectID: string;
  comment_text: string | null;
  author: string;
}

async function fetchHNPostsForTopic(topic: HNTopic, sortBy: "recent" | "popular"): Promise<HNPost[]> {
  const endpoint = sortBy === "recent" ? "search_by_date" : "search";
  const url = `${HN_API}/${endpoint}?query=${encodeURIComponent(topic.query)}&tags=ask_hn&hitsPerPage=30&numericFilters=num_comments%3E5`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HN API returned ${res.status}`);
  const data = await res.json();
  const posts: HNPost[] = (data.hits ?? []).map((h: Record<string, unknown>) => ({
    objectID: String(h.objectID ?? ""),
    title: String(h.title ?? ""),
    num_comments: Number(h.num_comments ?? 0),
    points: Number(h.points ?? 0),
    author: String(h.author ?? ""),
  }));
  return posts.sort((a, b) => b.num_comments - a.num_comments);
}

async function fetchHNComments(storyId: string): Promise<HNComment[]> {
  const url = `${HN_API}/search?tags=comment,story_${storyId}&hitsPerPage=100`;
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.hits ?? []).map((h: Record<string, unknown>) => ({
      objectID: String(h.objectID ?? ""),
      comment_text: typeof h.comment_text === "string" ? h.comment_text : null,
      author: String(h.author ?? ""),
    }));
  } catch { return []; }
}

async function fetchTrendingHNPosts(): Promise<HNPost[]> {
  const url = `${HN_API}/search_by_date?tags=ask_hn&hitsPerPage=50&numericFilters=num_comments%3E10`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HN API returned ${res.status}`);
  const data = await res.json();
  const posts: HNPost[] = (data.hits ?? []).map((h: Record<string, unknown>) => ({
    objectID: String(h.objectID ?? ""),
    title: String(h.title ?? ""),
    num_comments: Number(h.num_comments ?? 0),
    points: Number(h.points ?? 0),
    author: String(h.author ?? ""),
  }));
  return posts.sort((a, b) => b.num_comments - a.num_comments).slice(0, 5);
}

// ─── Clean up Ask HN title ────────────────────────────────────────────────────

function cleanHNTitle(title: string): string {
  return title
    .replace(/^Ask HN\s*:\s*/i, "")
    .replace(/^Ask HN\s+/i, "")
    .trim();
}

// ─── Category detection + urgency scoring ────────────────────────────────────

const CATEGORY_MAP = [
  { label: "AI & ML",          icon: "🤖", color: "#a78bfa", bgColor: "rgba(124,58,237,0.14)", pattern: /\b(AI|LLM|GPT|ML|model|claude|openai|chatgpt|gemini|llama|machine.?learning|neural|prompt|embedding|fine.?tun)\b/i },
  { label: "Dev Tools",        icon: "🛠️", color: "#67e8f9", bgColor: "rgba(6,182,212,0.14)",  pattern: /\b(developer|programming|code|coding|debug|git|deploy|API|SDK|framework|library|CLI|terminal|devops|IDE|toolchain|build.?tool)\b/i },
  { label: "SaaS & B2B",       icon: "📦", color: "#6ee7b7", bgColor: "rgba(16,185,129,0.14)", pattern: /\b(SaaS|B2B|subscription|software.?product|startup|enterprise|pricing|customer.?success)\b/i },
  { label: "Data & Analytics", icon: "📊", color: "#fcd34d", bgColor: "rgba(245,158,11,0.14)", pattern: /\b(data|analytics|database|pipeline|ETL|dashboard|metrics|SQL|warehouse|spreadsheet|CSV)\b/i },
  { label: "Productivity",     icon: "⚡", color: "#c4b5fd", bgColor: "rgba(139,92,246,0.14)", pattern: /\b(productivity|workflow|automation|task|manage|organis|focus|note|document|meeting|calendar)\b/i },
  { label: "Security",         icon: "🔒", color: "#fca5a5", bgColor: "rgba(239,68,68,0.14)",  pattern: /\b(security|privacy|auth|encrypt|compliance|vulnerability|password|2FA|GDPR|breach|hack)\b/i },
  { label: "Hiring & HR",      icon: "💼", color: "#f9a8d4", bgColor: "rgba(236,72,153,0.14)", pattern: /\b(hiring|job|career|interview|salary|recruit|remote|resume|HR|onboard|employee)\b/i },
  { label: "Finance",          icon: "💳", color: "#5eead4", bgColor: "rgba(20,184,166,0.14)", pattern: /\b(finance|payment|billing|accounting|tax|money|bank|invoice|expense|payroll|fintech)\b/i },
] as const;

function detectCategory(title: string): typeof CATEGORY_MAP[number] | { label: string; icon: string; color: string; bgColor: string } {
  for (const cat of CATEGORY_MAP) {
    if (cat.pattern.test(title)) return cat;
  }
  return { label: "General", icon: "💡", color: "#8080a4", bgColor: "rgba(128,128,164,0.12)" };
}

function computeUrgency(commentCount: number, points: number, ageHours: number, painHits: number): number {
  const engagement = Math.log10(commentCount + 1) * 3.5 + Math.log10(points + 1) * 0.5;
  const decayDays = ageHours / 24;
  const recency = decayDays < 1 ? 1 : Math.max(0, 1 - (decayDays - 1) / 6);
  const pain = 1 + Math.min(painHits, 3) * 0.4;
  return Math.min(10, parseFloat((engagement * pain * (0.25 + recency * 0.75)).toFixed(1)));
}

function urgencyConfig(score: number): { label: string; color: string; bg: string } {
  if (score >= 7.5) return { label: "Critical", color: "#ef4444", bg: "rgba(239,68,68,0.12)" };
  if (score >= 5)   return { label: "High",     color: "#f59e0b", bg: "rgba(245,158,11,0.12)" };
  if (score >= 3)   return { label: "Medium",   color: "#a78bfa", bg: "rgba(124,58,237,0.12)" };
  return                   { label: "Low",      color: "#8080a4", bg: "rgba(128,128,164,0.12)" };
}

async function fetchUrgentProblems(): Promise<UrgentProblem[]> {
  const [res1, res2] = await Promise.all([
    fetch(`${HN_API}/search_by_date?tags=ask_hn&hitsPerPage=80&numericFilters=num_comments%3E3`, { headers: { Accept: "application/json" } }),
    fetch(`${HN_API}/search_by_date?tags=ask_hn&hitsPerPage=80&numericFilters=num_comments%3E3&page=1`, { headers: { Accept: "application/json" } }),
  ]);
  const [d1, d2] = await Promise.all([res1.json(), res2.json()]);
  const allHits: Record<string, unknown>[] = [...(d1.hits ?? []), ...(d2.hits ?? [])];
  const now = Date.now();
  const seen = new Set<string>();
  const problems: UrgentProblem[] = [];
  for (const hit of allHits) {
    const id = String(hit.objectID ?? "");
    if (seen.has(id)) continue;
    seen.add(id);
    const title = String(hit.title ?? "");
    const titleLower = title.toLowerCase();
    const painHits =
      PAIN_KEYWORDS.filter((k) => titleLower.includes(k)).length +
      PAIN_SEEDS.filter((s) => titleLower.includes(s.replace(/'/g, ""))).length;
    if (painHits === 0) continue;
    const createdAt = String(hit.created_at ?? "");
    const ageMs = createdAt ? now - new Date(createdAt).getTime() : 0;
    const ageHours = Math.max(0, ageMs / 3600000);
    const commentCount = Number(hit.num_comments ?? 0);
    const points = Number(hit.points ?? 0);
    const score = computeUrgency(commentCount, points, ageHours, painHits);
    const cat = detectCategory(title);
    problems.push({
      id, title,
      cleanTitle: cleanHNTitle(title),
      category: cat.label,
      categoryIcon: cat.icon,
      categoryColor: cat.color,
      urgencyScore: score,
      commentCount, points, ageHours,
      hnUrl: `https://news.ycombinator.com/item?id=${id}`,
    });
  }
  return problems.sort((a, b) => b.urgencyScore - a.urgencyScore).slice(0, 18);
}

function extractWishStatements(cleanComments: string[]): string[] {
  const WISH_MARKERS = [
    "i wish", "wish there was", "wish there were", "would love a tool",
    "someone should build", "there should be", "why isn't there",
    "why is there no", "we need a tool", "would be amazing if",
    "it would be great if", "i'd pay for", "i would pay for",
  ];
  const results: string[] = [];
  for (const comment of cleanComments) {
    if (results.length >= 4) break;
    const lower = comment.toLowerCase();
    for (const marker of WISH_MARKERS) {
      if (!lower.includes(marker)) continue;
      const sentences = comment.replace(/\n+/g, " ").split(/(?<=[.!?])\s+/);
      for (const s of sentences) {
        if (!s.toLowerCase().includes(marker)) continue;
        if (s.length < 25 || s.length > 240) continue;
        const clean = s.trim().replace(/^[^a-zA-Z"']+/, "");
        if (clean && !results.some((r) => r.slice(0, 30) === clean.slice(0, 30))) {
          results.push(clean.charAt(0).toUpperCase() + clean.slice(1));
        }
      }
      break;
    }
  }
  return results;
}

async function analyzeThread(problem: UrgentProblem): Promise<ThreadAnalysis> {
  const comments = await fetchHNComments(problem.id);
  const total = comments.length;
  const cleaned = comments
    .map((c) => (c.comment_text ? stripHtml(c.comment_text) : null))
    .filter((c): c is string => c !== null && c.length > 25);
  const painComments = cleaned.filter(hasPainKeyword);
  const evidenceMap = new Map<string, string[]>();
  painComments.forEach((c) => evidenceMap.set(c, [c]));
  const phraseMap = extractPainPhrases(painComments, evidenceMap);
  const phrases = mergeSemanticGroups(phraseMap)
    .slice(0, 5)
    .map((p) => ({ phrase: p.phrase, count: p.count, evidence: p.evidence.slice(0, 2) }));
  const withSolution = painComments.filter(hasSolutionMention).length;
  const solutionGapPct =
    painComments.length > 0 ? Math.round((1 - withSolution / painComments.length) * 100) : 50;
  return {
    painPhrases: phrases,
    wishStatements: extractWishStatements(cleaned),
    solutionGapPct,
    totalPainComments: painComments.length,
    totalComments: total,
  };
}

const DETAIL_COLORS = ["#a78bfa", "#67e8f9", "#6ee7b7", "#fcd34d", "#fca5a5"];

// ─── Trending HN Feed ─────────────────────────────────────────────────────────

const FEED_COLORS = ["#7c3aed", "#06b6d4", "#10b981", "#f59e0b", "#ef4444"];

function TrendingHNFeed() {
  const [posts, setPosts] = useState<HNPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchTrendingHNPosts();
        if (!cancelled) { setPosts(data); setLoading(false); }
      } catch {
        if (!cancelled) { setError(true); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (error) return null;

  return (
    <div className="trending-card animate-fade-in">
      <div className="trending-head">
        <div className="trending-pulse">
          <span className="pulse-dot" />
          <span className="pulse-text">LIVE</span>
        </div>
        <div>
          <div className="trending-title">Hottest discussions on Hacker News right now</div>
          <div className="trending-sub">Most-commented Ask HN threads from the last 48 hours</div>
        </div>
      </div>

      {loading ? (
        <div className="trending-loader">
          <div className="trending-spinner" />
          Fetching live HN discussions…
        </div>
      ) : (
        <div className="hn-feed">
          {posts.map((post, i) => (
            <div key={post.objectID} className="hn-feed-item">
              <div className="hn-feed-rank" style={{ color: FEED_COLORS[i] }}>
                {i + 1}
              </div>
              <div className="hn-feed-body">
                <div className="hn-feed-title">{cleanHNTitle(post.title)}</div>
                <div className="hn-feed-meta">
                  <span className="hn-feed-badge hn-comments">
                    <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                      <path d="M2 2h8a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4l-2 2V3a1 1 0 0 1 1-1z" stroke="currentColor" strokeWidth="1.3" fill="none"/>
                    </svg>
                    {post.num_comments} comments
                  </span>
                  <span className="hn-feed-badge hn-points">
                    <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                      <path d="M6 1l1.5 3.5H11l-2.8 2 1 3.5L6 8.2 2.8 10l1-3.5L1 4.5h3.5z" stroke="currentColor" strokeWidth="1.2" fill="none"/>
                    </svg>
                    {post.points} pts
                  </span>
                </div>
              </div>
              <div className="hn-feed-bar" style={{ background: FEED_COLORS[i], width: `${Math.max(4, (post.num_comments / (posts[0]?.num_comments || 1)) * 48)}px` }} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Problem Card ────────────────────────────────────────────────────────────

function ProblemCard({
  problem,
  isSelected,
  onSelect,
  onDetail,
}: {
  problem: UrgentProblem;
  isSelected: boolean;
  onSelect: (p: UrgentProblem) => void;
  onDetail: (p: UrgentProblem) => void;
}) {
  const urgency = urgencyConfig(problem.urgencyScore);
  const ageLabel =
    problem.ageHours < 1 ? "<1h ago"
    : problem.ageHours < 24 ? `${Math.floor(problem.ageHours)}h ago`
    : `${Math.floor(problem.ageHours / 24)}d ago`;

  return (
    <div
      className={`prob-card ${isSelected ? "selected" : ""}`}
      onClick={() => onDetail(problem)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && onDetail(problem)}
    >
      <div className="prob-card-head">
        <span
          className="prob-cat-badge"
          style={{ color: problem.categoryColor, background: `${problem.categoryColor}18`, borderColor: `${problem.categoryColor}38` }}
        >
          {problem.categoryIcon} {problem.category}
        </span>
        <span
          className="prob-urgency-badge"
          style={{ color: urgency.color, background: urgency.bg }}
        >
          {problem.urgencyScore.toFixed(1)} · {urgency.label}
        </span>
      </div>

      <div className="prob-title">{problem.cleanTitle}</div>

      <div className="prob-stats">
        <span className="prob-stat">💬 {problem.commentCount}</span>
        <span className="prob-stat-sep">·</span>
        <span className="prob-stat">▲ {problem.points}</span>
        <span className="prob-stat-sep">·</span>
        <span className="prob-stat">🕐 {ageLabel}</span>
      </div>

      <div className="prob-card-footer">
        <button
          className="prob-detail-btn"
          onClick={(e) => { e.stopPropagation(); onDetail(problem); }}
        >
          Open research brief →
        </button>
        <button
          className={`prob-select-btn ${isSelected ? "selected" : ""}`}
          onClick={(e) => { e.stopPropagation(); onSelect(problem); }}
          aria-label={isSelected ? "Deselect" : "Select for analysis"}
        >
          {isSelected ? "✓ Selected" : "+ Select"}
        </button>
      </div>
    </div>
  );
}

// ─── Opportunity label helper ─────────────────────────────────────────────────

function opportunityInfo(gapPct: number): { label: string; sub: string; color: string; icon: string } {
  if (gapPct >= 70) return {
    label: "High opportunity",
    sub: "Most discussions mention no solution — this pain is largely unaddressed in the market.",
    color: "#10b981", icon: "🔓",
  };
  if (gapPct >= 40) return {
    label: "Moderate opportunity",
    sub: "Some solutions are mentioned but pain persists — room for a significantly better product.",
    color: "#f59e0b", icon: "⚠️",
  };
  return {
    label: "Saturated space",
    sub: "Multiple solutions actively mentioned — high competition or tight niche positioning needed.",
    color: "#8080a4", icon: "✓",
  };
}

// ─── Problem Detail Panel (research brief) ───────────────────────────────────

function ProblemDetailPanel({
  problem,
  onClose,
  onAnalyze,
}: {
  problem: UrgentProblem;
  onClose: () => void;
  onAnalyze: (p: UrgentProblem) => void;
}) {
  const [analysis, setAnalysis] = useState<ThreadAnalysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);
  const [prodSuggestions, setProdSuggestions] = useState<ProductSuggestion[]>([]);
  const [prodSugLoading, setProdSugLoading] = useState(false);
  const urgency = urgencyConfig(problem.urgencyScore);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFetchError(false);
    setAnalysis(null);
    analyzeThread(problem)
      .then((result) => { if (!cancelled) { setAnalysis(result); setLoading(false); } })
      .catch(() => { if (!cancelled) { setFetchError(true); setLoading(false); } });
    return () => { cancelled = true; };
  }, [problem.id]);

  useEffect(() => {
    if (!analysis || analysis.painPhrases.length === 0) return;
    setProdSugLoading(true);
    fetch("/api/suggest-products", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        painPoints: analysis.painPhrases.slice(0, 3).map((p) => ({
          phrase: p.phrase,
          count: p.count,
          noSolution: false,
        })),
        topics: [problem.category],
        totalComments: analysis.totalComments,
      }),
    })
      .then((r) => r.json())
      .then((data: { suggestions: ProductSuggestion[] }) => setProdSuggestions(data.suggestions ?? []))
      .catch(() => {})
      .finally(() => setProdSugLoading(false));
  }, [analysis]);

  const opp = analysis ? opportunityInfo(analysis.solutionGapPct) : null;
  const maxCount = analysis?.painPhrases[0]?.count ?? 1;
  const allEvidence = analysis?.painPhrases.flatMap((p) => p.evidence) ?? [];

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="detail-panel animate-fade-in-scale" role="dialog" aria-modal="true">

        {/* ── Header ── */}
        <div className="detail-header">
          <div className="detail-header-left">
            <span
              className="prob-cat-badge"
              style={{ color: problem.categoryColor, background: `${problem.categoryColor}18`, borderColor: `${problem.categoryColor}38` }}
            >
              {problem.categoryIcon} {problem.category}
            </span>
            <span className="detail-urgency" style={{ color: urgency.color }}>
              {urgency.label} urgency · {problem.urgencyScore.toFixed(1)}/10
            </span>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <a href={problem.hnUrl} target="_blank" rel="noopener noreferrer" className="detail-hn-link">
              HN thread ↗
            </a>
            <button className="modal-close" style={{ position: "static" }} onClick={onClose}>✕</button>
          </div>
        </div>

        {/* ── Problem title ── */}
        <h2 className="detail-title">{problem.cleanTitle}</h2>

        {/* ── Stat cards ── */}
        <div className="detail-stats">
          <div className="detail-stat-card">
            <div className="detail-stat-value">{problem.commentCount}</div>
            <div className="detail-stat-label">Discussions</div>
          </div>
          <div className="detail-stat-card">
            <div className="detail-stat-value" style={{ color: urgency.color }}>
              {problem.urgencyScore.toFixed(1)}
              <span style={{ fontSize: 13, opacity: 0.5, fontWeight: 600 }}>/10</span>
            </div>
            <div className="detail-stat-label">Urgency score</div>
          </div>
          <div className="detail-stat-card">
            {loading
              ? <div className="detail-stat-value" style={{ color: "var(--text-muted)" }}>—</div>
              : <div className="detail-stat-value" style={{ color: opp?.color }}>{analysis?.solutionGapPct ?? 0}%</div>
            }
            <div className="detail-stat-label">Unsolved rate</div>
          </div>
        </div>

        {/* ── Opportunity banner ── */}
        {!loading && opp && (
          <div
            className="detail-opportunity"
            style={{ borderColor: `${opp.color}40`, background: `${opp.color}0e` }}
          >
            <span style={{ fontSize: 22, lineHeight: 1, flexShrink: 0 }}>{opp.icon}</span>
            <div>
              <div className="detail-opp-label" style={{ color: opp.color }}>{opp.label}</div>
              <div className="detail-opp-sub">{opp.sub}</div>
            </div>
          </div>
        )}

        <div className="detail-body">

          {/* ── Pain signals ── */}
          <div className="detail-section">
            <div className="detail-section-title">Top pain signals from this thread</div>
            {loading ? (
              <div className="detail-loading">
                <div className="trending-spinner" style={{ width: 14, height: 14, borderWidth: 1.5 }} />
                Scanning {problem.commentCount} comments with NLP…
              </div>
            ) : fetchError ? (
              <div className="detail-loading" style={{ color: "#fca5a5" }}>Could not fetch comments — check your connection.</div>
            ) : analysis!.painPhrases.length === 0 ? (
              <div className="detail-loading">No clear pain signals extracted from this thread.</div>
            ) : (
              <div className="detail-phrases">
                {analysis!.painPhrases.map((p, i) => (
                  <div key={i} className="detail-phrase-row">
                    <div className="detail-phrase-label">{i + 1}</div>
                    <div className="detail-phrase-text">{p.phrase}</div>
                    <div className="detail-phrase-bar-wrap">
                      <div
                        className="detail-phrase-bar"
                        style={{ width: `${(p.count / maxCount) * 100}%`, background: DETAIL_COLORS[i] }}
                      />
                    </div>
                    <div className="detail-phrase-count">{p.count}×</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Wish statements ── */}
          {!loading && !fetchError && (analysis?.wishStatements.length ?? 0) > 0 && (
            <div className="detail-section">
              <div className="detail-section-title">💡 What people wish existed</div>
              <div className="detail-wishes">
                {analysis!.wishStatements.map((w, i) => (
                  <div key={i} className="detail-wish">"{w}"</div>
                ))}
              </div>
            </div>
          )}

          {/* ── Evidence quotes ── */}
          {!loading && !fetchError && allEvidence.length > 0 && (
            <div className="detail-section">
              <div className="detail-section-title">💬 Real comments from the thread</div>
              <div className="detail-evidence-list">
                {allEvidence.slice(0, 3).map((ev, i) => (
                  <div key={i} className="detail-evidence-quote">
                    "{ev.length > 220 ? ev.slice(0, 220) + "…" : ev}"
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Product ideas ── */}
          {(prodSugLoading || prodSuggestions.length > 0) && (
            <div className="detail-section">
              <div className="detail-section-title">🏗️ Product ideas from this pain</div>
              {prodSugLoading ? (
                <div style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--text-secondary)", fontSize: 13, padding: "8px 0" }}>
                  <div className="trending-spinner" style={{ width: 14, height: 14, borderWidth: 1.5 }} />
                  Generating opportunities…
                </div>
              ) : (
                <div className="detail-mini-suggestions">
                  {prodSuggestions.map((sug, i) => (
                    <div key={i} className="detail-mini-sug-item">
                      {prodSuggestions.length > 1 && (
                        <div className="detail-mini-sug-phrase">Re: "{sug.phrase}"</div>
                      )}
                      <div className="detail-mini-tiers">
                        {BUILD_TIERS.map(({ key, emoji, cls }) => {
                          const tier = sug[key];
                          return (
                            <div key={key} className={`detail-mini-tier ${cls.replace("build-tier-", "detail-mini-tier-")}`}>
                              <div className="detail-mini-tier-top">
                                <span style={{ fontSize: 15 }}>{emoji}</span>
                                <div className="detail-mini-tier-label">
                                  {key === "low" ? "Low · 1–3 days" : key === "mid" ? "Mid · 2–6 wks" : "SaaS · months"}
                                </div>
                              </div>
                              <div className="detail-mini-tier-format">{tier.format}</div>
                              <div className="detail-mini-tier-title">{tier.title}</div>
                              <div className="detail-mini-tier-desc">{tier.description}</div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

        </div>

        {/* ── Actions ── */}
        <div className="detail-actions">
          <button className="btn-ghost" style={{ fontSize: 13 }} onClick={onClose}>← Back</button>
          <button
            className="btn-primary"
            style={{ fontSize: 14, padding: "10px 20px" }}
            onClick={() => { onClose(); onAnalyze(problem); }}
          >
            Run deep analysis
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M2 7h10M8 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Problem Discovery Section ────────────────────────────────────────────────

function ProblemDiscoverySection({
  onAnalyse,
}: {
  onAnalyse: (topics: HNTopic[], sortBy: "recent" | "popular") => void;
}) {
  const [problems, setProblems] = useState<UrgentProblem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [selected, setSelected] = useState<UrgentProblem[]>([]);
  const [detailProblem, setDetailProblem] = useState<UrgentProblem | null>(null);
  const [filterCat, setFilterCat] = useState("All");

  useEffect(() => {
    let cancelled = false;
    fetchUrgentProblems()
      .then((probs) => { if (!cancelled) { setProblems(probs); setLoading(false); } })
      .catch(() => { if (!cancelled) { setLoadError(true); setLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  const categories = ["All", ...Array.from(new Set(problems.map((p) => p.category)))];
  const filtered = filterCat === "All" ? problems : problems.filter((p) => p.category === filterCat);

  const toggleSelect = (prob: UrgentProblem) =>
    setSelected((prev) =>
      prev.some((p) => p.id === prob.id)
        ? prev.filter((p) => p.id !== prob.id)
        : prev.length < 5 ? [...prev, prob] : prev
    );

  const toTopic = (p: UrgentProblem): HNTopic => ({
    id: p.id,
    label: p.cleanTitle.length > 28 ? p.cleanTitle.slice(0, 27) + "…" : p.cleanTitle,
    query: p.cleanTitle.split(" ").slice(0, 6).join(" "),
    icon: p.categoryIcon,
  });

  return (
    <section className="discovery animate-fade-in" style={{ paddingBottom: selected.length > 0 ? 96 : 40 }}>

      <div className="discovery-header">
        <div className="discovery-badge">
          <span className="pulse-dot" style={{ background: "#ef4444" }} />
          Live from Hacker News
        </div>
        <h2>Real problems people are struggling with right now</h2>
        <p className="discovery-sub">
          Each card is a live Hacker News discussion, scored by urgency and analysed for market opportunity.
          Click any card to open its research brief, then select problems to run a deep analysis.
        </p>
      </div>

      {!loading && !loadError && (
        <div className="discovery-filters">
          {categories.map((cat) => (
            <button
              key={cat}
              className={`discovery-filter-btn ${filterCat === cat ? "active" : ""}`}
              onClick={() => setFilterCat(cat)}
            >
              {cat}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="discovery-loading">
          <div className="trending-spinner" />
          Scanning Hacker News for urgent problems…
        </div>
      ) : loadError ? (
        <div className="discovery-loading">
          Could not load problems — check your connection and refresh.
        </div>
      ) : (
        <div className="discovery-grid">
          {filtered.map((prob) => (
            <ProblemCard
              key={prob.id}
              problem={prob}
              isSelected={selected.some((p) => p.id === prob.id)}
              onSelect={toggleSelect}
              onDetail={setDetailProblem}
            />
          ))}
        </div>
      )}

      <div className="discovery-footer">
        Powered by the Hacker News Algolia API · Refreshes on each visit · No login required
      </div>

      {selected.length > 0 && (
        <div className="discovery-selected-bar">
          <div className="dsb-info">
            <div className="dsb-count">{selected.length} problem{selected.length !== 1 ? "s" : ""} selected</div>
            <div className="dsb-names">
              {selected.map((p) => `${p.categoryIcon} ${p.cleanTitle.slice(0, 20)}…`).join("  ")}
            </div>
          </div>
          <button
            className="btn-primary"
            style={{ fontSize: 14, padding: "10px 22px", flexShrink: 0 }}
            onClick={() => onAnalyse(selected.map(toTopic), "recent")}
          >
            Run deep analysis
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M2 7h10M8 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        </div>
      )}

      {detailProblem && (
        <ProblemDetailPanel
          problem={detailProblem}
          onClose={() => setDetailProblem(null)}
          onAnalyze={(prob) => {
            setDetailProblem(null);
            onAnalyse([toTopic(prob)], "recent");
          }}
        />
      )}
    </section>
  );
}

// ─── Loading Section ──────────────────────────────────────────────────────────

function LoadingSection({ steps }: { steps: LoadingStep[] }) {
  return (
    <section className="loading-screen animate-fade-in">
      <div className="loading-spinner" />
      <div className="loading-title">Scanning Hacker News…</div>
      <div className="loading-subtitle">
        Fetching Ask HN threads, scanning comments for pain signals, and grouping similar problems.
      </div>
      <div className="loading-steps">
        {steps.map((step, i) => (
          <div key={i} className={`loading-step ${step.status}`}>
            <div className="step-icon">
              {step.status === "done" ? "✓" : step.status === "active" ? "·" : ""}
            </div>
            {step.label}
          </div>
        ))}
      </div>
    </section>
  );
}

// ─── Build Opportunities Panel ────────────────────────────────────────────────

const BUILD_TIERS: Array<{
  key: "low" | "mid" | "full";
  emoji: string;
  label: string;
  effort: string;
  cls: string;
}> = [
  { key: "low",  emoji: "🍎", label: "Low hanging fruit", effort: "1–3 days",    cls: "build-tier-low"  },
  { key: "mid",  emoji: "🔧", label: "Mid-tier tool",     effort: "2–6 weeks",  cls: "build-tier-mid"  },
  { key: "full", emoji: "🚀", label: "Full SaaS",         effort: "2–6 months", cls: "build-tier-full" },
];

function BuildOpportunitiesPanel({
  painPoints,
  topics,
  totalComments,
}: {
  painPoints: PainPoint[];
  topics: HNTopic[];
  totalComments: number;
}) {
  const [suggestions, setSuggestions] = useState<ProductSuggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [errored, setErrored] = useState(false);

  const RANK_COLORS = ["#7c3aed", "#06b6d4", "#10b981", "#f59e0b", "#ef4444"];

  useEffect(() => {
    if (painPoints.length === 0) { setLoading(false); return; }
    fetch("/api/suggest-products", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        painPoints: painPoints.slice(0, 5).map((p) => ({
          phrase: p.phrase,
          count: p.count,
          noSolution: p.noSolution,
        })),
        topics: topics.map((t) => t.label),
        totalComments,
      }),
    })
      .then((r) => r.json())
      .then((data: { suggestions: ProductSuggestion[] }) => setSuggestions(data.suggestions ?? []))
      .catch(() => setErrored(true))
      .finally(() => setLoading(false));
  }, []);

  if (!loading && (errored || suggestions.length === 0)) return null;

  return (
    <div className="build-panel">
      <div className="build-panel-header">
        <div>
          <div className="build-panel-title">🏗️ What you could build</div>
          <div className="build-panel-sub">
            Product opportunities grounded in {totalComments.toLocaleString()} real HN comments —
            suggestions are specific to the pain signals above, not generic guesses
          </div>
        </div>
        <div className="build-data-badge">
          <span className="pulse-dot" style={{ background: "#10b981", animationDuration: "2.5s" }} />
          Backed by live data
        </div>
      </div>

      {loading ? (
        <div className="build-loading">
          <div className="trending-spinner" />
          Generating product opportunities…
        </div>
      ) : (
        <div className="build-list">
          {suggestions.map((sug, i) => (
            <div key={i} className="build-item">
              <div className="build-pain-label">
                <span
                  className="build-pain-rank"
                  style={{
                    color: RANK_COLORS[i],
                    borderColor: `${RANK_COLORS[i]}44`,
                    background: `${RANK_COLORS[i]}12`,
                  }}
                >
                  #{i + 1}
                </span>
                <span className="build-pain-phrase">{sug.phrase}</span>
                <span className="build-pain-count">{painPoints[i]?.count ?? 0} mentions</span>
              </div>
              <div className="build-tiers">
                {BUILD_TIERS.map(({ key, emoji, label, effort, cls }) => {
                  const tier = sug[key];
                  return (
                    <div key={key} className={`build-tier ${cls}`}>
                      <div className="build-tier-header">
                        <span className="build-tier-emoji">{emoji}</span>
                        <div>
                          <div className="build-tier-label">{label}</div>
                          <div className="build-tier-effort">{effort}</div>
                        </div>
                      </div>
                      <div className="build-tier-format">{tier.format}</div>
                      <div className="build-tier-title">{tier.title}</div>
                      <div className="build-tier-desc">{tier.description}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Bar chart ────────────────────────────────────────────────────────────────

// Split a phrase into at most 2 lines at a word boundary
function wrapLabel(phrase: string, maxChars = 30): string[] {
  if (phrase.length <= maxChars) return [phrase];
  const words = phrase.split(" ");
  let line1 = "";
  const rest: string[] = [];
  let filled = false;
  for (const word of words) {
    if (!filled && (line1 + (line1 ? " " : "") + word).length <= maxChars) {
      line1 = line1 ? line1 + " " + word : word;
    } else {
      filled = true;
      rest.push(word);
    }
  }
  const line2 = rest.join(" ");
  return line2 ? [line1, line2] : [line1];
}

const BAR_COLORS = [
  { bg: "rgba(124,58,237,0.75)",  border: "rgba(167,139,250,0.9)" },
  { bg: "rgba(6,182,212,0.75)",   border: "rgba(103,232,249,0.9)" },
  { bg: "rgba(16,185,129,0.75)",  border: "rgba(52,211,153,0.9)"  },
  { bg: "rgba(245,158,11,0.75)",  border: "rgba(251,191,36,0.9)"  },
  { bg: "rgba(239,68,68,0.75)",   border: "rgba(252,165,165,0.9)" },
];

function BarChart({ data }: { data: PainPoint[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);

  useEffect(() => {
    if (!canvasRef.current || data.length === 0) return;
    if (chartRef.current) chartRef.current.destroy();

    // Wrap labels into 2-line arrays so nothing is truncated
    const labels = data.map((d) => wrapLabel(d.phrase));
    const counts = data.map((d) => d.count);

    chartRef.current = new Chart(canvasRef.current, {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: "Mentions",
          data: counts,
          backgroundColor: BAR_COLORS.slice(0, data.length).map((c) => c.bg),
          borderColor:      BAR_COLORS.slice(0, data.length).map((c) => c.border),
          borderWidth: 1.5,
          borderRadius: 6,
          borderSkipped: false,
        }],
      },
      options: {
        // Horizontal bars so labels read left-to-right
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 700, easing: "easeOutQuart" },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: "#111118",
            borderColor: "#3d3d4d",
            borderWidth: 1,
            titleColor: "#f0f0f8",
            bodyColor: "#a8a8c8",
            padding: 12,
            cornerRadius: 8,
            callbacks: {
              // Always show the full phrase in the tooltip title
              title: (items) => data[items[0].dataIndex].phrase,
              label: (item) => `  ${item.parsed.x} mention${Number(item.parsed.x) !== 1 ? "s" : ""} across comments`,
            },
          },
        },
        scales: {
          // X-axis = the numeric count axis (bottom)
          x: {
            grid: { color: "rgba(255,255,255,0.05)", tickLength: 0 },
            border: { display: false },
            ticks: {
              color: "#8080a4",
              font: { size: 11, family: "Inter" },
              stepSize: 1,
              maxTicksLimit: 6,
            },
          },
          // Y-axis = the phrase label axis (left)
          y: {
            grid: { display: false },
            border: { display: false },
            ticks: {
              color: "#d8d8f0",
              font: { size: 12, family: "Inter", weight: 600 },
              crossAlign: "far",
              padding: 8,
            },
          },
        },
        layout: { padding: { right: 16 } },
      },
    });

    return () => { chartRef.current?.destroy(); chartRef.current = null; };
  }, [data]);

  return <div className="chart-container"><canvas ref={canvasRef} /></div>;
}

// ─── Email modal ──────────────────────────────────────────────────────────────

interface EmailModalProps {
  onClose: () => void;
  topics: HNTopic[];
}

function EmailModal({ onClose, topics }: EmailModalProps) {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const [marketingConsent, setMarketingConsent] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.includes("@")) { setError("Please enter a valid email address."); return; }
    if (!marketingConsent) { setError("Please tick the consent box to continue."); return; }
    setLoading(true);
    setError("");
    try {
      const res = await fetch("https://formspree.io/f/xzdyepba", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ email, topics: topics.map((t) => t.label).join(", ") }),
      });
      if (res.ok) setDone(true);
      else setError("Something went wrong. Please try again.");
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal animate-fade-in-scale" role="dialog" aria-modal="true">
        <button className="modal-close" onClick={onClose} aria-label="Close">✕</button>
        {done ? (
          <div className="modal-success">
            <div className="success-icon">🎉</div>
            <h3>You're on the list!</h3>
            <p className="modal-desc" style={{ marginTop: 8, marginBottom: 0 }}>
              We'll send daily pain point summaries for your chosen topics straight to your inbox.
            </p>
          </div>
        ) : (
          <>
            <div className="modal-icon">📬</div>
            <h3>Save your feed &amp; get daily updates</h3>
            <p className="modal-desc">
              Get a daily digest of the top pain points from{" "}
              {topics.map((t) => t.label).join(", ")} — delivered to your inbox, free.
            </p>
            <div className="modal-perks">
              {["Daily top-5 pain point digest", "Trend alerts when a problem spikes", "No spam, unsubscribe anytime"].map((perk) => (
                <div key={perk} className="perk">
                  <div className="perk-dot" />
                  {perk}
                </div>
              ))}
            </div>
            <form className="modal-form" onSubmit={handleSubmit}>
              <input
                className="modal-input"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
              />
              <label className="gdpr-checkbox-label">
                <input
                  type="checkbox"
                  checked={marketingConsent}
                  onChange={(e) => setMarketingConsent(e.target.checked)}
                  required
                />
                <span>
                  I agree to receive ProblemPulse email updates. I can unsubscribe at any time. Your data is processed per our{" "}
                  <button
                    type="button"
                    className="inline-link"
                    onClick={() => { onClose(); setTimeout(() => document.dispatchEvent(new CustomEvent("pp:showPrivacy")), 100); }}
                  >
                    Privacy Policy
                  </button>.
                </span>
              </label>
              {error && <div style={{ fontSize: 13, color: "var(--danger)" }}>{error}</div>}
              <button className="btn-submit" type="submit" disabled={loading || !marketingConsent}>
                {loading ? (
                  <>
                    <div style={{ width: 14, height: 14, border: "2px solid rgba(255,255,255,0.3)", borderTopColor: "white", borderRadius: "50%", animation: "spin 0.7s linear infinite" }} />
                    Saving…
                  </>
                ) : (
                  <>
                    Save my feed
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <path d="M2 7h10M8 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </>
                )}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Report generator ─────────────────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function generateReportHTML(painPoints: PainPoint[], topics: HNTopic[], totalComments: number): string {
  const date = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const time = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const maxCount = painPoints[0]?.count ?? 1;
  const COLORS = ["#7c3aed", "#06b6d4", "#10b981", "#f59e0b", "#ef4444"];

  const painRows = painPoints.map((p, i) => {
    const pct = Math.round((p.count / maxCount) * 100);
    const evidenceSamples = p.evidence.slice(0, 2);
    const evHtml = evidenceSamples.map((ev) =>
      `<li class="sample-post">"${escapeHtml(ev.slice(0, 180))}${ev.length > 180 ? "…" : ""}"</li>`
    ).join("");

    return `
      <div class="pain-block">
        <div class="pain-header">
          <span class="pain-rank" style="background:${COLORS[i]}22;color:${COLORS[i]}">#${i + 1}</span>
          <span class="pain-phrase">${escapeHtml(p.phrase)}</span>
          <span class="pain-count">${p.count} mention${p.count !== 1 ? "s" : ""}</span>
          ${p.noSolution ? `<span class="no-solution-badge">No obvious solution</span>` : ""}
        </div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${COLORS[i]}"></div></div>
        ${evidenceSamples.length > 0 ? `
        <div class="sample-label">Evidence from comments:</div>
        <ul class="sample-list">${evHtml}</ul>` : ""}
      </div>`;
  }).join("");

  const topicChips = topics.map((t) => `<span class="chip">${escapeHtml(t.icon)} ${escapeHtml(t.label)}</span>`).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>ProblemPulse Report — ${date}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet"/>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter',sans-serif;background:#0a0a0f;color:#f0f0f8;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .page{max-width:780px;margin:0 auto;padding:48px 40px}
  .header{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:40px;padding-bottom:28px;border-bottom:1px solid #2a2a35}
  .logo{display:flex;align-items:center;gap:10px}
  .logo-dot{width:10px;height:10px;border-radius:50%;background:#7c3aed;flex-shrink:0}
  .logo-name{font-size:20px;font-weight:800;letter-spacing:-0.02em;color:#f0f0f8}
  .logo-tag{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:#7c3aed;margin-top:2px}
  .meta{text-align:right;font-size:12px;color:#55556a;line-height:1.7}
  .hero{margin-bottom:36px}
  .hero h1{font-size:30px;font-weight:900;letter-spacing:-0.025em;color:#f0f0f8;line-height:1.15;margin-bottom:10px}
  .hero h1 span{color:#a78bfa}
  .hero-sub{font-size:14px;color:#8888a8;line-height:1.6;max-width:520px}
  .section-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#55556a;margin-bottom:12px}
  .chips{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:32px}
  .chip{background:#18181f;border:1px solid #2a2a35;border-radius:100px;padding:5px 13px;font-size:12px;font-weight:500;color:#8888a8}
  .stats-row{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:36px}
  .stat-card{background:#111118;border:1px solid #2a2a35;border-radius:12px;padding:18px 20px}
  .stat-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#55556a;margin-bottom:6px}
  .stat-value{font-size:24px;font-weight:800;letter-spacing:-0.02em;color:#f0f0f8}
  .stat-sub{font-size:11px;color:#55556a;margin-top:2px}
  .pain-blocks{display:flex;flex-direction:column;gap:20px;margin-bottom:40px}
  .pain-block{background:#111118;border:1px solid #2a2a35;border-radius:12px;padding:20px 22px}
  .pain-header{display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap}
  .pain-rank{font-size:11px;font-weight:700;border-radius:6px;padding:3px 8px;flex-shrink:0}
  .pain-phrase{font-size:15px;font-weight:700;color:#f0f0f8;flex:1;line-height:1.3}
  .pain-count{font-size:12px;font-weight:600;color:#55556a;white-space:nowrap}
  .no-solution-badge{font-size:10px;font-weight:700;background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);color:#ef4444;border-radius:4px;padding:2px 6px}
  .bar-track{height:5px;background:#1e1e28;border-radius:3px;overflow:hidden;margin-bottom:14px}
  .bar-fill{height:100%;border-radius:3px}
  .sample-label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:#55556a;margin-bottom:8px}
  .sample-list{list-style:none;display:flex;flex-direction:column;gap:6px}
  .sample-post{font-size:12px;color:#8888a8;line-height:1.5;padding-left:12px;border-left:2px solid #2a2a35;font-style:italic}
  .footer{border-top:1px solid #2a2a35;padding-top:24px;display:flex;align-items:center;justify-content:space-between}
  .footer-left{font-size:12px;color:#55556a;line-height:1.6}
  .footer-brand{font-size:11px;font-weight:700;color:#7c3aed;text-decoration:none}
  @media print{body{background:#fff;color:#111}.header,.pain-block,.stat-card{border-color:#e5e7eb}.stat-card,.pain-block{background:#f9fafb}.pain-phrase,.stat-value,.hero h1{color:#111}.stat-label,.stat-sub,.section-title,.sample-label,.footer-left,.pain-count,.meta{color:#6b7280}.chip{background:#f3f4f6;border-color:#e5e7eb;color:#374151}.bar-track{background:#e5e7eb}.sample-post{color:#374151;border-color:#d1d5db}.footer{border-color:#e5e7eb}.logo-name{color:#111}}
</style>
</head>
<body>
<div class="page">
  <div class="header">
    <div class="logo">
      <div class="logo-dot"></div>
      <div>
        <div class="logo-name">ProblemPulse</div>
        <div class="logo-tag">Pain Point Intelligence</div>
      </div>
    </div>
    <div class="meta">Generated ${date} at ${time}<br/>${topics.length} topic${topics.length !== 1 ? "s" : ""} · ${totalComments.toLocaleString()} comments scanned</div>
  </div>
  <div class="hero">
    <h1>Top <span>${painPoints.length} Pain Points</span> Right Now</h1>
    <p class="hero-sub">Real problems extracted from Hacker News Ask HN threads using NLP and semantic grouping. Each phrase represents a cluster of similar complaints from real people.</p>
  </div>
  <div class="section-title">Topics Analysed</div>
  <div class="chips">${topicChips}</div>
  <div class="stats-row">
    <div class="stat-card">
      <div class="stat-label">Comments Scanned</div>
      <div class="stat-value">${totalComments.toLocaleString()}</div>
      <div class="stat-sub">across ${topics.length} topic${topics.length !== 1 ? "s" : ""}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Pain Points Found</div>
      <div class="stat-value">${painPoints.length}</div>
      <div class="stat-sub">semantically grouped</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Top Issue</div>
      <div class="stat-value" style="font-size:14px;line-height:1.4">${escapeHtml(painPoints[0]?.phrase ?? "—")}</div>
      <div class="stat-sub">${painPoints[0]?.count ?? 0} mentions</div>
    </div>
  </div>
  <div class="section-title">Pain Point Breakdown</div>
  <div class="pain-blocks">${painRows}</div>
  <div class="footer">
    <div class="footer-left">Data sourced from Hacker News via Algolia API · Analysis by NLP phrase extraction &amp; semantic clustering<br/>This report reflects content from the time of generation and may not reflect current trends.</div>
    <a class="footer-brand" href="#">ProblemPulse</a>
  </div>
</div>
</body>
</html>`;
}

function downloadReport(painPoints: PainPoint[], topics: HNTopic[], totalComments: number) {
  const html = generateReportHTML(painPoints, topics, totalComments);
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const dateStr = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `problempulse-hn-report-${dateStr}.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── Results Section ──────────────────────────────────────────────────────────

function ResultsSection({
  painPoints,
  topics,
  totalComments,
  onRestart,
}: {
  painPoints: PainPoint[];
  topics: HNTopic[];
  totalComments: number;
  onRestart: () => void;
}) {
  const [showModal, setShowModal] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [expandedEvidence, setExpandedEvidence] = useState<Set<number>>(new Set());
  const maxCount = painPoints[0]?.count ?? 1;

  const handleDownload = () => {
    setDownloading(true);
    setTimeout(() => { downloadReport(painPoints, topics, totalComments); setDownloading(false); }, 50);
  };

  useEffect(() => {
    const timer = setTimeout(() => setShowModal(true), 3500);
    return () => clearTimeout(timer);
  }, []);

  const toggleEvidence = (i: number) => {
    setExpandedEvidence((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  };

  const COLORS = ["#7c3aed", "#06b6d4", "#10b981", "#f59e0b", "#ef4444"];

  return (
    <>
      <section className="results animate-fade-in">
        <div className="results-header">
          <div className="results-meta">
            <span className="meta-chip accent">Live HN Data</span>
            {topics.map((t) => (
              <span key={t.id} className="meta-chip">{t.icon} {t.label}</span>
            ))}
          </div>
          <h2>Top pain points right now</h2>
          <p className="results-sub">
            Extracted from {totalComments.toLocaleString()} HN comments · NLP + semantic grouping
          </p>
        </div>

        <div className="results-grid">
          <div className="stat-card">
            <div className="stat-card-label">Comments Scanned</div>
            <div className="stat-card-value">{totalComments.toLocaleString()}</div>
            <div className="stat-card-sub">across {topics.length} topic{topics.length !== 1 ? "s" : ""}</div>
          </div>
          <div className="stat-card">
            <div className="stat-card-label">Top Pain Phrase</div>
            <div className="stat-card-value" style={{ fontSize: 18, lineHeight: 1.4 }}>
              {painPoints[0]?.phrase ?? "—"}
            </div>
            <div className="stat-card-sub">{painPoints[0]?.count ?? 0} mentions</div>
          </div>
        </div>

        <div className="chart-card">
          <div className="chart-card-header">
            <div>
              <div className="chart-card-title">Pain Point Frequency</div>
              <div className="chart-card-subtitle">Top 5 phrases by mention count, semantically deduplicated</div>
            </div>
            <div className="chart-legend">
              <div className="chart-legend-dot" />
              Mentions
            </div>
          </div>
          <BarChart data={painPoints} />
        </div>

        <div className="pain-list">
          {painPoints.map((p, i) => (
            <div key={p.phrase} className="pain-item" style={{ animationDelay: `${i * 80}ms` }}>
              <div className={`pain-rank ${i < 3 ? "top" : ""}`} style={{ color: COLORS[i] }}>#{i + 1}</div>
              <div className="pain-body">
                <div className="pain-phrase-row">
                  <div className="pain-phrase">{p.phrase}</div>
                  {p.noSolution && (
                    <span className="no-solution-pill" title="No obvious existing solution mentioned in these threads">
                      ⚠ No obvious solution
                    </span>
                  )}
                </div>
                <div className="pain-bar-track">
                  <div className="pain-bar-fill" style={{ width: `${(p.count / maxCount) * 100}%`, background: COLORS[i] }} />
                </div>
                {p.evidence.length > 0 && (
                  <div className="evidence-section">
                    <button
                      className="evidence-toggle"
                      onClick={() => toggleEvidence(i)}
                    >
                      {expandedEvidence.has(i) ? "▲ Hide" : "▼ Show"} {p.evidence.length} source comment{p.evidence.length !== 1 ? "s" : ""}
                    </button>
                    {expandedEvidence.has(i) && (
                      <div className="evidence-list">
                        {p.evidence.map((ev, j) => (
                          <div key={j} className="evidence-quote">
                            "{ev.length > 200 ? ev.slice(0, 200) + "…" : ev}"
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div className="pain-count">
                {p.count} <span>mentions</span>
              </div>
            </div>
          ))}
        </div>

        <BuildOpportunitiesPanel
          painPoints={painPoints}
          topics={topics}
          totalComments={totalComments}
        />

        <div className="results-actions">
          <button className="btn-ghost" onClick={onRestart}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M2 7a5 5 0 1 0 1-2.9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              <path d="M2 2v3h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            Scan different topics
          </button>
          <button
            className="btn-ghost"
            onClick={handleDownload}
            disabled={downloading}
            style={{ borderColor: downloading ? "var(--accent)" : undefined, color: downloading ? "var(--accent-light)" : undefined }}
          >
            {downloading ? (
              <>
                <div style={{ width: 13, height: 13, border: "1.5px solid currentColor", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.7s linear infinite" }} />
                Generating…
              </>
            ) : (
              <>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M7 1v8M4 6l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M2 11h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
                Download report
              </>
            )}
          </button>
          <button
            className="btn-primary"
            style={{ fontSize: 14, padding: "10px 20px" }}
            onClick={() => setShowModal(true)}
          >
            Get daily updates
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M2 7h10M8 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        </div>
      </section>

      {showModal && <EmailModal onClose={() => setShowModal(false)} topics={topics} />}
    </>
  );
}

// ─── Privacy Policy Modal ─────────────────────────────────────────────────────

function PrivacyPolicyModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal privacy-modal animate-fade-in-scale" role="dialog" aria-modal="true" aria-label="Privacy Policy">
        <button className="modal-close" onClick={onClose} aria-label="Close">✕</button>
        <h3 style={{ marginBottom: 16 }}>Privacy Policy</h3>
        <div className="privacy-body">
          <p><strong>Last updated:</strong> June 2026</p>
          <p>ProblemPulse (&ldquo;we&rdquo;, &ldquo;us&rdquo;) is committed to protecting your personal data and complying with the General Data Protection Regulation (GDPR) and UK GDPR.</p>
          <h4>1. Who we are</h4>
          <p>ProblemPulse is operated by its owner (&ldquo;the Controller&rdquo;). For data-related queries, contact us via our website.</p>
          <h4>2. What data we collect</h4>
          <ul>
            <li><strong>Email address</strong> — only if you voluntarily subscribe to our mailing list. Legal basis: consent (Art. 6(1)(a) GDPR).</li>
            <li><strong>Usage analytics</strong> — only if you accept cookies. We use Google Analytics 4 with IP anonymisation enabled. Legal basis: consent (Art. 6(1)(a) GDPR).</li>
            <li><strong>Hacker News comment data</strong> — fetched in real-time from the public Algolia HN API in your browser. This data is not stored on our servers and never leaves your browser session.</li>
          </ul>
          <h4>3. How we use your data</h4>
          <ul>
            <li>Email: to send you pain-point digests you signed up for.</li>
            <li>Analytics: to understand how people use ProblemPulse and improve it.</li>
          </ul>
          <h4>4. Third-party processors</h4>
          <ul>
            <li><strong>Formspree</strong> — processes email submissions. See <a href="https://formspree.io/legal/privacy-policy" target="_blank" rel="noopener noreferrer">Formspree Privacy Policy</a>.</li>
            <li><strong>Google Analytics</strong> — only activated with your consent. See <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer">Google Privacy Policy</a>.</li>
            <li><strong>Algolia / Hacker News</strong> — comment data is fetched from the public Algolia HN Search API. See <a href="https://www.algolia.com/policies/privacy/" target="_blank" rel="noopener noreferrer">Algolia Privacy Policy</a>.</li>
          </ul>
          <h4>5. Data retention</h4>
          <p>Email addresses are retained until you unsubscribe. Analytics data is retained per Google Analytics default settings (26 months). We do not store Hacker News comment content.</p>
          <h4>6. Your rights</h4>
          <p>Under GDPR you have the right to: access your data, rectify inaccurate data, erase your data, restrict processing, data portability, and withdraw consent at any time. To exercise these rights, contact us via the website.</p>
          <h4>7. Withdrawing consent</h4>
          <p>You can withdraw cookie consent at any time using the &ldquo;Cookie Settings&rdquo; link in the banner. To unsubscribe from emails, use the unsubscribe link in any email we send.</p>
          <h4>8. Cookies</h4>
          <p><strong>Essential:</strong> No tracking cookies. Your consent preference is stored in local storage and never sent to our servers.</p>
          <p><strong>Analytics (optional):</strong> Google Analytics sets <code>_ga</code>, <code>_gid</code>, and related cookies only after you give consent.</p>
          <h4>9. Children</h4>
          <p>ProblemPulse is not directed at children under 16. We do not knowingly collect data from children.</p>
          <h4>10. Changes to this policy</h4>
          <p>We may update this policy. Changes will be noted with a revised &ldquo;Last updated&rdquo; date.</p>
        </div>
        <button className="btn-primary" onClick={onClose} style={{ marginTop: 24, width: "100%" }}>Close</button>
      </div>
    </div>
  );
}

// ─── Cookie Settings Modal ────────────────────────────────────────────────────

function CookieSettingsModal({
  current, onSave, onClose, onShowPrivacy,
}: {
  current: ConsentValue;
  onSave: (v: "accepted" | "declined") => void;
  onClose: () => void;
  onShowPrivacy: () => void;
}) {
  const [analytics, setAnalytics] = useState(current === "accepted");

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal animate-fade-in-scale" role="dialog" aria-modal="true" aria-label="Cookie Settings">
        <button className="modal-close" onClick={onClose} aria-label="Close">✕</button>
        <div className="modal-icon">🍪</div>
        <h3>Cookie Settings</h3>
        <p className="modal-desc">Manage which cookies ProblemPulse uses. Essential functions always run — they keep the site working and store your preferences locally.</p>
        <div className="cookie-toggle-list">
          <div className="cookie-toggle-row">
            <div className="cookie-toggle-info">
              <div className="cookie-toggle-title">Essential</div>
              <div className="cookie-toggle-desc">Stores your cookie preference in local storage. Always active.</div>
            </div>
            <div className="cookie-toggle-always">Always on</div>
          </div>
          <div className="cookie-toggle-row">
            <div className="cookie-toggle-info">
              <div className="cookie-toggle-title">Analytics (Google Analytics 4)</div>
              <div className="cookie-toggle-desc">Helps us understand how visitors use the site. IP anonymisation is enabled.</div>
            </div>
            <label className="toggle-switch" aria-label="Enable analytics cookies">
              <input type="checkbox" checked={analytics} onChange={(e) => setAnalytics(e.target.checked)} />
              <span className="toggle-slider" />
            </label>
          </div>
        </div>
        <button
          className="btn-primary"
          style={{ marginTop: 20, width: "100%" }}
          onClick={() => { onSave(analytics ? "accepted" : "declined"); onClose(); }}
        >
          Save preferences
        </button>
        <button className="cookie-privacy-link" onClick={onShowPrivacy}>Read our Privacy Policy</button>
      </div>
    </div>
  );
}

// ─── Cookie Consent Banner ────────────────────────────────────────────────────

function CookieBanner({ onAccept, onDecline, onSettings, onPrivacy }: {
  onAccept: () => void;
  onDecline: () => void;
  onSettings: () => void;
  onPrivacy: () => void;
}) {
  return (
    <div className="cookie-banner" role="region" aria-label="Cookie consent">
      <div className="cookie-banner-text">
        <span>We use optional analytics cookies to improve ProblemPulse. Your email (if provided) is processed by Formspree. No cookies are set without your consent.</span>
        <button className="cookie-text-btn" onClick={onPrivacy}>Privacy Policy</button>
        <span>·</span>
        <button className="cookie-text-btn" onClick={onSettings}>Cookie Settings</button>
      </div>
      <div className="cookie-banner-actions">
        <button className="cookie-btn-decline" onClick={onDecline}>Decline</button>
        <button className="cookie-btn-accept" onClick={onAccept}>Accept all</button>
      </div>
    </div>
  );
}

// ─── Landing Section ──────────────────────────────────────────────────────────

function LandingSection({ onStart }: { onStart: () => void }) {
  return (
    <section className="landing animate-fade-in">
      <div className="landing-bg" />
      <div className="landing-grid" />
      <div className="landing-content">
        <div className="logo-badge">
          <div className="logo-dot" />
          Pain Point Intelligence
        </div>
        <h1>
          Discover what builders are<br />
          <span className="gradient-text">actually struggling with</span>
        </h1>
        <p className="landing-subtitle">
          <strong>ProblemPulse</strong> scans Hacker News Ask HN threads in real time,
          extracts pain points from the comments, and visualises the most burning
          unsolved problems — instantly.
        </p>
        <button className="btn-primary" onClick={onStart}>
          Get Started
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        <div className="landing-stats">
          <div className="stat">
            <div className="stat-value">Free</div>
            <div className="stat-label">No cost, ever</div>
          </div>
          <div className="stat">
            <div className="stat-value">Real-time</div>
            <div className="stat-label">Live HN data</div>
          </div>
          <div className="stat">
            <div className="stat-value">NLP</div>
            <div className="stat-label">Semantic grouping</div>
          </div>
        </div>
      </div>

      <div className="how-it-works">
        <div className="hiw-label">How it works</div>
        <div className="hiw-steps">
          <div className="hiw-step">
            <div className="hiw-num">1</div>
            <div className="hiw-icon">🎯</div>
            <div className="hiw-step-title">Pick topics</div>
            <div className="hiw-step-desc">Choose up to 5 categories you care about — SaaS, AI, dev tools, hiring, and more.</div>
          </div>
          <div className="hiw-arrow">→</div>
          <div className="hiw-step">
            <div className="hiw-num">2</div>
            <div className="hiw-icon">🔍</div>
            <div className="hiw-step-title">We scan HN</div>
            <div className="hiw-step-desc">We fetch the most-discussed Ask HN threads and scan hundreds of comments for pain signals.</div>
          </div>
          <div className="hiw-arrow">→</div>
          <div className="hiw-step">
            <div className="hiw-num">3</div>
            <div className="hiw-icon">📊</div>
            <div className="hiw-step-title">See the pain points</div>
            <div className="hiw-step-desc">NLP clusters the complaints into clear problem statements with evidence quotes and frequency counts.</div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [phase, setPhase] = useState<Phase>("landing");
  const [selectedTopics, setSelectedTopics] = useState<HNTopic[]>([]);
  const [painPoints, setPainPoints] = useState<PainPoint[]>([]);
  const [totalComments, setTotalComments] = useState(0);
  const [errorMsg, setErrorMsg] = useState("");
  const [loadingSteps, setLoadingSteps] = useState<LoadingStep[]>([]);

  const [consent, setConsent] = useState<ConsentValue>(getStoredConsent);
  const [showCookieSettings, setShowCookieSettings] = useState(false);
  const [showPrivacyPolicy, setShowPrivacyPolicy] = useState(false);

  useEffect(() => {
    if (consent === "accepted") loadGA();
    const handler = () => setShowPrivacyPolicy(true);
    document.addEventListener("pp:showPrivacy", handler);
    return () => document.removeEventListener("pp:showPrivacy", handler);
  }, []);

  const handleAccept = () => { persistConsent("accepted"); setConsent("accepted"); };
  const handleDecline = () => { persistConsent("declined"); setConsent("declined"); };
  const handleSaveSettings = (v: "accepted" | "declined") => { persistConsent(v); setConsent(v); };

  const setStepStatus = (index: number, status: LoadingStep["status"]) => {
    setLoadingSteps((prev) => prev.map((s, i) => i === index ? { ...s, status } : s));
  };

  const runAnalysis = useCallback(async (topics: HNTopic[], sortBy: "recent" | "popular") => {
    setSelectedTopics(topics);

    const steps: LoadingStep[] = [
      ...topics.map((t) => ({ label: `Fetching Ask HN: ${t.label}`, status: "pending" as const })),
      { label: "Scanning comments for pain keywords", status: "pending" as const },
      { label: "Extracting pain signals via NLP", status: "pending" as const },
      { label: "Grouping semantically similar problems", status: "pending" as const },
      { label: "Rewriting into clear problem statements", status: "pending" as const },
    ];
    setLoadingSteps(steps);
    setPhase("loading");

    try {
      const allTexts: string[] = [];
      const evidenceMap = new Map<string, string[]>();

      for (let i = 0; i < topics.length; i++) {
        setStepStatus(i, "active");

        const posts = await fetchHNPostsForTopic(topics[i], sortBy);
        // Add post titles
        for (const post of posts) {
          if (post.title) allTexts.push(post.title);
        }
        // Fetch comments for top 5 most-discussed posts
        const topPosts = posts.slice(0, 5);
        for (const post of topPosts) {
          const comments = await fetchHNComments(post.objectID);
          for (const c of comments) {
            if (!c.comment_text) continue;
            const clean = stripHtml(c.comment_text);
            if (clean.length < 20) continue;
            // Only keep comments with pain keywords
            if (hasPainKeyword(clean)) {
              allTexts.push(clean);
              evidenceMap.set(clean, [clean]);
            }
          }
        }

        setStepStatus(i, "done");
      }

      const filterStepIdx = topics.length;
      const nlpStepIdx = topics.length + 1;
      const mergeStepIdx = topics.length + 2;
      const rewriteStepIdx = topics.length + 3;

      setStepStatus(filterStepIdx, "done");

      setStepStatus(nlpStepIdx, "active");
      await new Promise((r) => setTimeout(r, 200));
      const phraseMap = extractPainPhrases(allTexts, evidenceMap);
      setStepStatus(nlpStepIdx, "done");

      setStepStatus(mergeStepIdx, "active");
      await new Promise((r) => setTimeout(r, 200));
      const merged = mergeSemanticGroups(phraseMap);
      setStepStatus(mergeStepIdx, "done");

      setTotalComments(allTexts.length);

      if (merged.length === 0) {
        setErrorMsg(
          "We didn't find enough pain-point signals in those topics right now. Try adding more topics or switching to 'Popular' sort to scan posts with higher engagement."
        );
        setPhase("error");
        return;
      }

      setStepStatus(rewriteStepIdx, "active");
      let finalPoints = merged;
      try {
        const rewriteRes = await fetch("/api/rewrite-phrases", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            phrases: merged.map((p) => p.phrase),
            subreddits: topics.map((t) => t.label),
          }),
        });
        if (rewriteRes.ok) {
          const { phrases: rewritten } = await rewriteRes.json() as { phrases: string[] };
          finalPoints = merged.map((p, i) => ({
            ...p,
            phrase: rewritten[i] ?? p.phrase,
          }));
        }
      } catch {
        // Fall back to NLP-only phrases
      }
      setStepStatus(rewriteStepIdx, "done");

      setPainPoints(finalPoints);
      await new Promise((r) => setTimeout(r, 400));
      setPhase("results");

    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      if (msg.includes("Failed to fetch") || msg.includes("NetworkError")) {
        setErrorMsg("Could not reach the Hacker News API. Please check your internet connection and try again.");
      } else {
        setErrorMsg(`Something went wrong: ${msg}`);
      }
      setPhase("error");
    }
  }, []);

  const reset = () => {
    setPainPoints([]);
    setSelectedTopics([]);
    setTotalComments(0);
    setErrorMsg("");
    setLoadingSteps([]);
    setPhase("onboarding");
  };

  return (
    <div className="app">
      {phase === "landing" && <LandingSection onStart={() => setPhase("onboarding")} />}
      {phase === "onboarding" && <ProblemDiscoverySection onAnalyse={runAnalysis} />}
      {phase === "loading" && <LoadingSection steps={loadingSteps} />}
      {phase === "results" && (
        <ResultsSection
          painPoints={painPoints}
          topics={selectedTopics}
          totalComments={totalComments}
          onRestart={reset}
        />
      )}
      {phase === "error" && (
        <section className="loading-screen animate-fade-in">
          <div className="error-card">
            <div className="error-icon">⚠️</div>
            <div className="error-title">Analysis incomplete</div>
            <div className="error-msg">{errorMsg}</div>
            <button className="btn-primary" onClick={reset}>Try again</button>
          </div>
        </section>
      )}

      {consent === null && (
        <CookieBanner
          onAccept={handleAccept}
          onDecline={handleDecline}
          onSettings={() => setShowCookieSettings(true)}
          onPrivacy={() => setShowPrivacyPolicy(true)}
        />
      )}

      {consent !== null && (
        <button
          className="cookie-settings-float"
          onClick={() => setShowCookieSettings(true)}
          aria-label="Cookie settings"
          title="Cookie settings"
        >
          🍪
        </button>
      )}

      {showCookieSettings && (
        <CookieSettingsModal
          current={consent}
          onSave={handleSaveSettings}
          onClose={() => setShowCookieSettings(false)}
          onShowPrivacy={() => { setShowCookieSettings(false); setShowPrivacyPolicy(true); }}
        />
      )}

      {showPrivacyPolicy && <PrivacyPolicyModal onClose={() => setShowPrivacyPolicy(false)} />}
    </div>
  );
}
