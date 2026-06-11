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

// ─── Trending HN Chart ────────────────────────────────────────────────────────

function TrendingHNChart() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);
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

  useEffect(() => {
    if (!canvasRef.current || posts.length === 0) return;
    chartRef.current?.destroy();
    const colors = ["#7c3aed", "#06b6d4", "#10b981", "#f59e0b", "#ef4444"];
    const labels = posts.map((p) =>
      p.title.length > 42 ? p.title.slice(0, 40) + "…" : p.title
    );
    chartRef.current = new Chart(canvasRef.current, {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: "Comments",
          data: posts.map((p) => p.num_comments),
          backgroundColor: colors.slice(0, posts.length),
          borderRadius: 6,
          borderSkipped: false,
        }],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: "#0a0a0f",
            titleColor: "#f0f0f8",
            bodyColor: "#8888a8",
            borderColor: "#2a2a35",
            borderWidth: 1,
            padding: 10,
            callbacks: {
              label: (ctx) => `${ctx.parsed.x} comments · ${posts[ctx.dataIndex]?.points ?? 0} points`,
            },
          },
        },
        scales: {
          x: {
            grid: { color: "rgba(255,255,255,0.04)" },
            ticks: { color: "#55556a", font: { size: 11 } },
          },
          y: {
            grid: { display: false },
            ticks: { color: "#f0f0f8", font: { size: 12, weight: 600 } },
          },
        },
      },
    });
    return () => { chartRef.current?.destroy(); };
  }, [posts]);

  if (error) return null;

  return (
    <div className="trending-card animate-fade-in">
      <div className="trending-head">
        <div className="trending-pulse">
          <span className="pulse-dot" />
          <span className="pulse-text">LIVE</span>
        </div>
        <div>
          <div className="trending-title">Hottest Ask HN threads right now</div>
          <div className="trending-sub">Top 5 recent discussions by comment volume — where people are most actively complaining</div>
        </div>
      </div>
      {loading ? (
        <div className="trending-loader">
          <div className="trending-spinner" />
          Fetching live HN data…
        </div>
      ) : (
        <div className="trending-chart-wrap">
          <canvas ref={canvasRef} />
        </div>
      )}
    </div>
  );
}

// ─── Onboarding Section ───────────────────────────────────────────────────────

function OnboardingSection({
  onAnalyse,
}: {
  onAnalyse: (topics: HNTopic[], sortBy: "recent" | "popular") => void;
}) {
  const [selected, setSelected] = useState<HNTopic[]>([]);
  const [sortBy, setSortBy] = useState<"recent" | "popular">("recent");
  const MAX = 5;

  const toggle = (topic: HNTopic) => {
    setSelected((prev) => {
      if (prev.some((t) => t.id === topic.id)) return prev.filter((t) => t.id !== topic.id);
      if (prev.length >= MAX) return prev;
      return [...prev, topic];
    });
  };

  const isSelected = (topic: HNTopic) => selected.some((t) => t.id === topic.id);

  return (
    <section className="onboarding animate-fade-in">
      <TrendingHNChart />
      <div className="onboarding-card">
        <div className="section-label">
          <div className="section-label-dot" />
          Step 1 of 2 — Choose Topics
        </div>
        <h2>Which topics do you want to scan?</h2>
        <p className="onboarding-desc">
          Pick up to {MAX} categories. We'll scan recent Ask HN threads and surface
          the most common pain points from the comments.
        </p>

        <div className="sort-toggle-row">
          <span className="sort-label">Sort posts by:</span>
          <div className="sort-toggle">
            <button
              className={`sort-btn ${sortBy === "recent" ? "active" : ""}`}
              onClick={() => setSortBy("recent")}
            >
              📅 Recent
            </button>
            <button
              className={`sort-btn ${sortBy === "popular" ? "active" : ""}`}
              onClick={() => setSortBy("popular")}
            >
              🔥 Popular
            </button>
          </div>
        </div>

        <div className="topic-grid">
          {HN_TOPICS.map((topic) => (
            <button
              key={topic.id}
              className={`topic-chip ${isSelected(topic) ? "selected" : ""} ${selected.length >= MAX && !isSelected(topic) ? "disabled" : ""}`}
              onClick={() => toggle(topic)}
              disabled={selected.length >= MAX && !isSelected(topic)}
            >
              <span className="topic-icon">{topic.icon}</span>
              <span className="topic-label">{topic.label}</span>
              {isSelected(topic) && <span className="topic-check">✓</span>}
            </button>
          ))}
        </div>

        {selected.length > 0 && (
          <div className="selected-topics">
            <div className="selected-label">Selected ({selected.length}/{MAX}):</div>
            <div className="selected-chips">
              {selected.map((t) => (
                <span key={t.id} className="selected-chip">
                  {t.icon} {t.label}
                  <button className="chip-remove" onClick={() => toggle(t)} aria-label={`Remove ${t.label}`}>×</button>
                </span>
              ))}
            </div>
          </div>
        )}

        <button
          className="btn-primary"
          style={{ width: "100%", marginTop: 24, justifyContent: "center" }}
          onClick={() => onAnalyse(selected, sortBy)}
          disabled={selected.length === 0}
        >
          Scan for pain points
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>

        <div style={{ textAlign: "center", marginTop: 12, fontSize: 12, color: "var(--text-muted)" }}>
          Powered by the Hacker News Algolia API · no login required
        </div>
      </div>
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

// ─── Bar chart ────────────────────────────────────────────────────────────────

function BarChart({ data }: { data: PainPoint[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);

  useEffect(() => {
    if (!canvasRef.current || data.length === 0) return;
    if (chartRef.current) chartRef.current.destroy();

    const labels = data.map((d) =>
      d.phrase.length > 28 ? d.phrase.slice(0, 26) + "…" : d.phrase
    );
    const counts = data.map((d) => d.count);
    const maxCount = Math.max(...counts);

    chartRef.current = new Chart(canvasRef.current, {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: "Mentions",
          data: counts,
          backgroundColor: counts.map((c) => `rgba(124, 58, 237, ${0.5 + (c / maxCount) * 0.5})`),
          borderColor: counts.map((c) => `rgba(124, 58, 237, ${0.6 + (c / maxCount) * 0.4})`),
          borderWidth: 1,
          borderRadius: 6,
          borderSkipped: false,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 800, easing: "easeOutQuart" },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: "#18181f",
            borderColor: "#2a2a35",
            borderWidth: 1,
            titleColor: "#f0f0f8",
            bodyColor: "#8888a8",
            padding: 12,
            callbacks: {
              title: (items) => data[items[0].dataIndex].phrase,
              label: (item) => ` ${item.raw} mention${Number(item.raw) !== 1 ? "s" : ""} across comments`,
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            border: { display: false },
            ticks: { color: "#8888a8", font: { size: 11, family: "Inter" }, maxRotation: 20 },
          },
          y: {
            grid: { color: "#1e1e28" },
            border: { display: false },
            ticks: { color: "#8888a8", font: { size: 11, family: "Inter" }, stepSize: 1 },
          },
        },
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
      {phase === "onboarding" && <OnboardingSection onAnalyse={runAnalysis} />}
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
