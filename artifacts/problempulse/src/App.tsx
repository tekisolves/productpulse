import { useState, useEffect, useRef, useCallback } from "react";
import { Chart, BarController, BarElement, CategoryScale, LinearScale, Tooltip, Legend } from "chart.js";
import nlp from "compromise";

Chart.register(BarController, BarElement, CategoryScale, LinearScale, Tooltip, Legend);

// ─── Types ───────────────────────────────────────────────────────────────────

type Phase = "landing" | "onboarding" | "loading" | "results" | "error";

interface Subreddit {
  name: string;
  title: string;
  subscribers: number;
}

interface PainPoint {
  phrase: string;
  count: number;
  posts: string[];
}

interface LoadingStep {
  label: string;
  status: "pending" | "active" | "done";
}

// ─── Popular subreddits for quick-select ─────────────────────────────────────

const POPULAR_SUBREDDITS: Subreddit[] = [
  { name: "entrepreneur", title: "r/entrepreneur", subscribers: 2100000 },
  { name: "startups", title: "r/startups", subscribers: 1300000 },
  { name: "smallbusiness", title: "r/smallbusiness", subscribers: 1100000 },
  { name: "Parenting", title: "r/Parenting", subscribers: 5200000 },
  { name: "personalfinance", title: "r/personalfinance", subscribers: 19000000 },
  { name: "SaaS", title: "r/SaaS", subscribers: 450000 },
  { name: "productivity", title: "r/productivity", subscribers: 1700000 },
  { name: "marketing", title: "r/marketing", subscribers: 1300000 },
  { name: "freelance", title: "r/freelance", subscribers: 450000 },
  { name: "webdev", title: "r/webdev", subscribers: 1800000 },
  { name: "datascience", title: "r/datascience", subscribers: 1400000 },
  { name: "fitness", title: "r/fitness", subscribers: 12000000 },
  { name: "relationship_advice", title: "r/relationship_advice", subscribers: 4800000 },
  { name: "mentalhealth", title: "r/mentalhealth", subscribers: 1100000 },
  { name: "careerguidance", title: "r/careerguidance", subscribers: 620000 },
];

// ─── Stop words (excluded from keyword matching) ──────────────────────────────

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

/**
 * Extract meaningful keywords from a phrase (skip stop words, short words).
 */
function keywords(phrase: string): string[] {
  return phrase
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w));
}

/**
 * Shared meaningful keyword count between two phrases (stem-matched, first 5 chars).
 */
function sharedKeywordCount(a: string, b: string): number {
  const ka = keywords(a);
  const kb = keywords(b);
  let shared = 0;
  for (const wa of ka) {
    for (const wb of kb) {
      if (wa.slice(0, 5) === wb.slice(0, 5)) {
        shared++;
        break;
      }
    }
  }
  return shared;
}

/**
 * Merge semantically similar phrases into canonical groups.
 * Groups are merged if they share 2+ meaningful keywords OR have 40%+ Jaccard overlap.
 * The canonical label is the shortest phrase in the group (most readable).
 */
function mergeSemanticGroups(
  phrases: Map<string, { count: number; posts: string[] }>
): PainPoint[] {
  const entries = [...phrases.entries()]
    .map(([phrase, data]) => ({ phrase, ...data }))
    .sort((a, b) => b.count - a.count);

  const merged: Array<{ canonical: string; count: number; posts: string[] }> = [];
  const used = new Set<number>();

  for (let i = 0; i < entries.length; i++) {
    if (used.has(i)) continue;
    const group = {
      phrases: [entries[i].phrase],
      count: entries[i].count,
      posts: [...entries[i].posts],
    };

    for (let j = i + 1; j < entries.length; j++) {
      if (used.has(j)) continue;

      const shared = sharedKeywordCount(entries[i].phrase, entries[j].phrase);
      const kaLen = keywords(entries[i].phrase).length;
      const kbLen = keywords(entries[j].phrase).length;
      const minLen = Math.min(kaLen, kbLen);

      // Merge if: 2+ shared keywords OR shared keywords cover 50%+ of the shorter phrase
      const shouldMerge = shared >= 2 || (minLen > 0 && shared / minLen >= 0.5);

      if (shouldMerge) {
        group.count += entries[j].count;
        group.posts = [...new Set([...group.posts, ...entries[j].posts])];
        group.phrases.push(entries[j].phrase);
        used.add(j);
      }
    }

    // Pick the canonical phrase: prefer the shortest one that contains a verb
    const withVerb = group.phrases.filter((p) => {
      const doc = nlp(p);
      return (doc.verbs().out("array") as string[]).length > 0;
    });
    const pool = withVerb.length > 0 ? withVerb : group.phrases;
    const canonical = pool.reduce((best, p) =>
      p.split(" ").length < best.split(" ").length ? p : best
    );

    merged.push({ canonical, count: group.count, posts: group.posts });
    used.add(i);
  }

  return merged
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((g) => ({ phrase: g.canonical, count: g.count, posts: g.posts }));
}

// ─── Pain point extraction ────────────────────────────────────────────────────

const PAIN_SEEDS = [
  "can't", "cannot", "struggle", "struggling", "problem", "issue",
  "help", "frustrated", "frustrating", "difficult", "hard to", "hate",
  "annoying", "annoyed", "why is", "why does", "how do i", "how to",
  "need help", "lost", "stuck", "confused", "confusing", "failing", "fail",
  "broken", "not working", "keeps", "always breaking", "never works",
  "impossible", "overwhelming", "overwhelmed", "exhausted", "burnout",
  "stressed", "worried", "anxious", "terrible", "horrible", "awful",
  "keep", "keeps", "wont", "won't", "unable", "cant stop", "can't stop",
  "every time", "every day", "no matter", "no idea", "what do i",
];

/**
 * Extract complete problem-statement phrases from post titles.
 *
 * Strategy (in priority order):
 *  1. Full title — if short (≤14 words) and contains a pain signal, use it as-is.
 *  2. Clauses — split by Compromise into clauses; keep any clause with a pain signal + verb.
 *  3. Sliding window — 5-8 word windows that straddle a pain signal keyword.
 *
 * All candidates are normalised, then we keep only those ≥4 words long.
 * Count threshold is 1 (single occurrence) — merging handles deduplication.
 */
function extractPainPhrases(titles: string[]): Map<string, { count: number; posts: string[] }> {
  const phraseMap = new Map<string, { count: number; posts: string[] }>();

  const addPhrase = (phrase: string, title: string) => {
    const normalised = phrase
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s']/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const wordCount = normalised.split(" ").length;
    if (wordCount < 4 || normalised.length < 12) return;
    const existing = phraseMap.get(normalised);
    if (existing) {
      existing.count++;
      if (!existing.posts.includes(title)) existing.posts.push(title);
    } else {
      phraseMap.set(normalised, { count: 1, posts: [title] });
    }
  };

  for (const title of titles) {
    const lower = title.toLowerCase();
    const hasPainSignal = PAIN_SEEDS.some((seed) => lower.includes(seed));
    if (!hasPainSignal) continue;

    const words = title.trim().split(/\s+/);

    // Strategy 1: use the full title if concise
    if (words.length >= 4 && words.length <= 14) {
      addPhrase(title, title);
    }

    // Strategy 2: extract clauses that contain a pain signal AND a verb
    const doc = nlp(title);
    const clauses = doc.clauses().out("array") as string[];
    for (const clause of clauses) {
      const cl = clause.toLowerCase();
      const clauseHasPain = PAIN_SEEDS.some((s) => cl.includes(s));
      if (!clauseHasPain) continue;
      const clauseDoc = nlp(clause);
      const hasVerb = (clauseDoc.verbs().out("array") as string[]).length > 0;
      if (hasVerb) addPhrase(clause, title);
    }

    // Strategy 3: sliding windows (5–8 words) that straddle a pain signal
    for (let size = 5; size <= 8; size++) {
      for (let start = 0; start <= words.length - size; start++) {
        const window = words.slice(start, start + size).join(" ");
        const wl = window.toLowerCase();
        const windowHasPain = PAIN_SEEDS.some((s) => wl.includes(s));
        if (!windowHasPain) continue;
        // Only keep windows that also contain a verb
        const wDoc = nlp(window);
        const hasVerb = (wDoc.verbs().out("array") as string[]).length > 0;
        if (hasVerb) addPhrase(window, title);
      }
    }
  }

  return phraseMap;
}

// ─── Reddit fetcher ───────────────────────────────────────────────────────────

async function fetchSubredditTitles(subreddit: string): Promise<string[]> {
  const url = `https://www.reddit.com/r/${subreddit}/hot.json?limit=100`;
  const res = await fetch(url, {
    headers: { "Accept": "application/json" },
  });
  if (!res.ok) throw new Error(`Reddit returned ${res.status} for r/${subreddit}`);
  const json = await res.json();
  const posts = json?.data?.children ?? [];
  return posts
    .filter((p: { data: { is_self: boolean; title: string } }) => !p.data.is_self || p.data.title)
    .map((p: { data: { title: string } }) => p.data.title as string);
}

// ─── Subreddit search via Reddit's public API ─────────────────────────────────

async function searchSubreddits(query: string): Promise<Subreddit[]> {
  if (!query.trim()) return [];
  try {
    const url = `https://www.reddit.com/subreddits/search.json?q=${encodeURIComponent(query)}&limit=6`;
    const res = await fetch(url, { headers: { "Accept": "application/json" } });
    if (!res.ok) throw new Error("search failed");
    const json = await res.json();
    const children = json?.data?.children ?? [];
    return children.map((c: { data: { display_name: string; title: string; subscribers: number } }) => ({
      name: c.data.display_name,
      title: `r/${c.data.display_name}`,
      subscribers: c.data.subscribers || 0,
    }));
  } catch {
    // Fall back to filtering popular list
    return POPULAR_SUBREDDITS.filter(
      (s) =>
        s.name.toLowerCase().includes(query.toLowerCase()) ||
        s.title.toLowerCase().includes(query.toLowerCase())
    ).slice(0, 6);
  }
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function getSubredditInitial(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

// ─── Components ───────────────────────────────────────────────────────────────

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
          Discover what people are<br />
          <span className="gradient-text">screaming about</span>
        </h1>
        <p className="landing-subtitle">
          <strong>ProblemPulse</strong> scans Reddit communities in real time,
          extracts pain point phrases, and visualises the most burning problems
          in your chosen communities — instantly.
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
            <div className="stat-label">Live Reddit data</div>
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

function OnboardingSection({
  onAnalyse,
}: {
  onAnalyse: (subreddits: Subreddit[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Subreddit[]>([]);
  const [selected, setSelected] = useState<Subreddit[]>([]);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const MAX = 5;

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setResults(POPULAR_SUBREDDITS.slice(0, 8));
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      const found = await searchSubreddits(query);
      setResults(found.filter((r) => !selected.some((s) => s.name === r.name)));
      setSearching(false);
    }, 350);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, selected]);

  const toggle = (sub: Subreddit) => {
    setSelected((prev) => {
      if (prev.some((s) => s.name === sub.name)) {
        return prev.filter((s) => s.name !== sub.name);
      }
      if (prev.length >= MAX) return prev;
      return [...prev, sub];
    });
  };

  const isSelected = (sub: Subreddit) => selected.some((s) => s.name === sub.name);

  return (
    <section className="onboarding animate-fade-in">
      <div className="onboarding-card">
        <div className="section-label">
          <div className="section-label-dot" />
          Step 1 of 2 — Choose Communities
        </div>
        <h2>Which Reddit communities matter to you?</h2>
        <p className="onboarding-desc">
          Pick up to {MAX} subreddits. We'll scan their top posts and surface the most
          common pain points.
        </p>

        <div className="search-wrapper">
          <svg className="search-icon" width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5"/>
            <path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
          <input
            className="search-input"
            type="text"
            placeholder="Search subreddits… e.g. 'SaaS', 'fitness'"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {results.length > 0 && (
          <div className="search-results">
            {searching && (
              <div className="search-result-item" style={{ justifyContent: "center", color: "var(--text-muted)", fontSize: 13 }}>
                Searching…
              </div>
            )}
            {!searching && results.map((sub) => (
              <button
                key={sub.name}
                className="search-result-item"
                onClick={() => toggle(sub)}
                style={{ width: "100%", textAlign: "left", background: "transparent" }}
                disabled={!isSelected(sub) && selected.length >= MAX}
              >
                <div className="subreddit-icon">{getSubredditInitial(sub.name)}</div>
                <div>
                  <div className="subreddit-name">{sub.title}</div>
                  {sub.subscribers > 0 && (
                    <div className="subreddit-meta">{formatNumber(sub.subscribers)} members</div>
                  )}
                </div>
                {isSelected(sub) && (
                  <svg className="check-icon" width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <path d="M3 8l4 4 6-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                )}
              </button>
            ))}
          </div>
        )}

        <div className="count-indicator">
          <span className="count-text">
            {selected.length === 0
              ? "No communities selected yet"
              : `${selected.length} of ${MAX} selected`}
          </span>
          <div className="count-badges">
            {Array.from({ length: MAX }).map((_, i) => (
              <div key={i} className={`count-badge ${i < selected.length ? "filled" : ""}`} />
            ))}
          </div>
        </div>

        <div className="selected-pills">
          {selected.length === 0 ? (
            <span className="empty-selection">Your selected communities will appear here</span>
          ) : (
            selected.map((sub) => (
              <div key={sub.name} className="pill">
                {sub.title}
                <button className="pill-remove" onClick={() => toggle(sub)} aria-label={`Remove ${sub.title}`}>
                  ✕
                </button>
              </div>
            ))
          )}
        </div>

        <button
          className="btn-analyze"
          disabled={selected.length === 0}
          onClick={() => onAnalyse(selected)}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M2 12l4-4 3 3 5-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Analyse Pain Points
        </button>
      </div>
    </section>
  );
}

function LoadingSection({ steps }: { steps: LoadingStep[] }) {
  return (
    <section className="loading-screen animate-fade-in">
      <div className="loading-spinner" />
      <div className="loading-title">Scanning communities…</div>
      <div className="loading-subtitle">
        Fetching posts, extracting pain signals, and grouping similar complaints.
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
        datasets: [
          {
            label: "Mentions",
            data: counts,
            backgroundColor: counts.map((c) => {
              const opacity = 0.5 + (c / maxCount) * 0.5;
              return `rgba(124, 58, 237, ${opacity})`;
            }),
            borderColor: counts.map((c) => {
              const opacity = 0.6 + (c / maxCount) * 0.4;
              return `rgba(124, 58, 237, ${opacity})`;
            }),
            borderWidth: 1,
            borderRadius: 6,
            borderSkipped: false,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: {
          duration: 800,
          easing: "easeOutQuart",
        },
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
              title: (items) => {
                const idx = items[0].dataIndex;
                return data[idx].phrase;
              },
              label: (item) => ` ${item.raw} mention${Number(item.raw) !== 1 ? "s" : ""} across posts`,
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            border: { display: false },
            ticks: {
              color: "#8888a8",
              font: { size: 11, family: "Inter" },
              maxRotation: 20,
            },
          },
          y: {
            grid: {
              color: "#1e1e28",
            },
            border: { display: false },
            ticks: {
              color: "#8888a8",
              font: { size: 11, family: "Inter" },
              stepSize: 1,
            },
          },
        },
      },
    });

    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [data]);

  return (
    <div className="chart-container">
      <canvas ref={canvasRef} />
    </div>
  );
}

interface EmailModalProps {
  onClose: () => void;
  subreddits: Subreddit[];
}

function EmailModal({ onClose, subreddits }: EmailModalProps) {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.includes("@")) {
      setError("Please enter a valid email address.");
      return;
    }
    setLoading(true);
    setError("");

    try {
      // Using Formspree — user should replace FORM_ID with their own
      const FORMSPREE_ENDPOINT = "https://formspree.io/f/xdkeorpb";
      const res = await fetch(FORMSPREE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          email,
          subreddits: subreddits.map((s) => s.name).join(", "),
        }),
      });
      if (res.ok) {
        setDone(true);
      } else {
        setError("Something went wrong. Please try again.");
      }
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
              We'll send daily pain point summaries for your chosen communities straight to your inbox.
            </p>
          </div>
        ) : (
          <>
            <div className="modal-icon">📬</div>
            <h3>Save your feed &amp; get daily updates</h3>
            <p className="modal-desc">
              Get a daily digest of the top pain points in{" "}
              {subreddits.map((s) => s.title).join(", ")} — delivered to your inbox, free.
            </p>
            <div className="modal-perks">
              {[
                "Daily top-5 pain point digest",
                "Trend alerts when a phrase spikes",
                "No spam, unsubscribe anytime",
              ].map((perk) => (
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
              {error && (
                <div style={{ fontSize: 13, color: "var(--danger)" }}>{error}</div>
              )}
              <button className="btn-submit" type="submit" disabled={loading}>
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
              <div className="modal-privacy">
                Your email is only used for ProblemPulse updates. No third parties, ever.
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

function ResultsSection({
  painPoints,
  subreddits,
  totalPosts,
  onRestart,
}: {
  painPoints: PainPoint[];
  subreddits: Subreddit[];
  totalPosts: number;
  onRestart: () => void;
}) {
  const [showModal, setShowModal] = useState(false);
  const maxCount = painPoints[0]?.count ?? 1;

  useEffect(() => {
    const timer = setTimeout(() => setShowModal(true), 3500);
    return () => clearTimeout(timer);
  }, []);

  return (
    <>
      <section className="results animate-fade-in">
        <div className="results-header">
          <div className="results-meta">
            <span className="meta-chip accent">Live Reddit Data</span>
            {subreddits.map((s) => (
              <span key={s.name} className="meta-chip">{s.title}</span>
            ))}
          </div>
          <h2>Top pain points right now</h2>
          <p className="results-sub">
            Extracted and semantically grouped from {totalPosts.toLocaleString()} posts
          </p>
        </div>

        <div className="results-grid">
          <div className="stat-card">
            <div className="stat-card-label">Posts Scanned</div>
            <div className="stat-card-value">{totalPosts.toLocaleString()}</div>
            <div className="stat-card-sub">across {subreddits.length} communities</div>
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
              <div className="chart-card-subtitle">
                Top 5 phrases by mention count, semantically deduplicated
              </div>
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
              <div className={`pain-rank ${i < 3 ? "top" : ""}`}>#{i + 1}</div>
              <div className="pain-bar-wrapper">
                <div className="pain-phrase">{p.phrase}</div>
                <div className="pain-bar-track">
                  <div
                    className="pain-bar-fill"
                    style={{ width: `${(p.count / maxCount) * 100}%` }}
                  />
                </div>
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
            Analyse different communities
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

      {showModal && (
        <EmailModal onClose={() => setShowModal(false)} subreddits={subreddits} />
      )}
    </>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [phase, setPhase] = useState<Phase>("landing");
  const [selectedSubreddits, setSelectedSubreddits] = useState<Subreddit[]>([]);
  const [painPoints, setPainPoints] = useState<PainPoint[]>([]);
  const [totalPosts, setTotalPosts] = useState(0);
  const [errorMsg, setErrorMsg] = useState("");
  const [loadingSteps, setLoadingSteps] = useState<LoadingStep[]>([]);

  const setStepStatus = (index: number, status: LoadingStep["status"]) => {
    setLoadingSteps((prev) =>
      prev.map((s, i) => (i === index ? { ...s, status } : s))
    );
  };

  const runAnalysis = useCallback(async (subreddits: Subreddit[]) => {
    setSelectedSubreddits(subreddits);

    const steps: LoadingStep[] = [
      ...subreddits.map((s) => ({ label: `Fetching r/${s.name}`, status: "pending" as const })),
      { label: "Extracting pain signals via NLP", status: "pending" as const },
      { label: "Grouping semantically similar phrases", status: "pending" as const },
    ];
    setLoadingSteps(steps);
    setPhase("loading");

    try {
      const allTitles: string[] = [];

      for (let i = 0; i < subreddits.length; i++) {
        setStepStatus(i, "active");
        const titles = await fetchSubredditTitles(subreddits[i].name);
        allTitles.push(...titles);
        setStepStatus(i, "done");
      }

      const nlpStepIdx = subreddits.length;
      const mergeStepIdx = subreddits.length + 1;

      setStepStatus(nlpStepIdx, "active");
      await new Promise((r) => setTimeout(r, 200)); // allow UI update
      const phraseMap = extractPainPhrases(allTitles);
      setStepStatus(nlpStepIdx, "done");

      setStepStatus(mergeStepIdx, "active");
      await new Promise((r) => setTimeout(r, 200));
      const merged = mergeSemanticGroups(phraseMap);
      setStepStatus(mergeStepIdx, "done");

      setTotalPosts(allTitles.length);

      if (merged.length === 0) {
        setErrorMsg(
          "We didn't find enough pain-point signals in those communities right now. Try subreddits focused on problems, advice, or questions — like r/entrepreneur or r/personalfinance."
        );
        setPhase("error");
        return;
      }

      setPainPoints(merged);
      await new Promise((r) => setTimeout(r, 400));
      setPhase("results");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      if (msg.includes("CORS") || msg.includes("NetworkError") || msg.includes("Failed to fetch")) {
        setErrorMsg(
          "Could not reach Reddit's API. This is usually a temporary network issue. Please try again in a moment."
        );
      } else {
        setErrorMsg(`Something went wrong: ${msg}`);
      }
      setPhase("error");
    }
  }, []);

  const reset = () => {
    setPainPoints([]);
    setSelectedSubreddits([]);
    setTotalPosts(0);
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
          subreddits={selectedSubreddits}
          totalPosts={totalPosts}
          onRestart={reset}
        />
      )}
      {phase === "error" && (
        <section className="loading-screen animate-fade-in">
          <div className="error-card">
            <div className="error-icon">⚠️</div>
            <div className="error-title">Analysis incomplete</div>
            <div className="error-msg">{errorMsg}</div>
            <button className="btn-primary" onClick={reset}>
              Try again
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
