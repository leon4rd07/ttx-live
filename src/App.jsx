import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";

/* ------------------------------------------------------------------ *
 * TTX Live — b19
 *
 * Three surfaces off one socket:
 *   /        participants, one device per business unit
 *   /host    the facilitator
 *   /screen  the projector, read-only
 *
 * A join code is a SEAT, not a password. One business unit sends one
 * device; a second device on the same code is refused and offered a
 * take-over, which is how a unit that refreshed or dropped gets back in
 * without losing its answers.
 *
 * Multiple choice is scored on correctness and speed, server-side.
 * Essay questions fall through to facilitator scoring.
 * ------------------------------------------------------------------ */

/* Bumping this version invalidates every stored session. A leftover
   session from an older build was the cause of the white screens. */
const V = "v4";
const BUILD = "b20";  // shown in the corner so you can confirm what is deployed
const K_HOST = `ttx:${V}:host`;
const K_ME = `ttx:${V}:me`;
const K_KEY = `ttx:${V}:key`;
const K_THEME = "ttx:theme";

const isHostRoute = () =>
  /^\/host\/?$/i.test(location.pathname) || /^#\/?host$/i.test(location.hash);
const isScreenRoute = () => /^\/screen\/?$/i.test(location.pathname);
const screenRoom = () =>
  (location.hash || "").replace(/^#/, "").trim() ||
  new URLSearchParams(location.search).get("room") || "";

/* Four fixed shapes. The same shape, colour and letter appear on the phone,
   the host screen and the projector, so the facilitator can call an option
   out loud — "siapa yang pilih segitiga?" — and the room knows what he means. */
const SHAPES = {
  triangle: "M12 3l9.5 17H2.5z",
  diamond: "M12 2l10 10-10 10L2 12z",
  circle: "M12 2a10 10 0 100 20 10 10 0 000-20z",
  square: "M3.5 3.5h17v17h-17z",
};
const OPT_SHAPES = ["triangle", "diamond", "circle", "square"];
const OPT_VAR = ["var(--oA)", "var(--oB)", "var(--oC)", "var(--oD)"];
const optOf = (i) => {
  const k = ((i % 4) + 4) % 4;
  return { shape: OPT_SHAPES[k], name: OPT_SHAPES[k], c: OPT_VAR[k], ltr: String.fromCharCode(65 + i) };
};
const Glyph = ({ shape, size = 16 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
    <path d={SHAPES[shape] || SHAPES.circle} />
  </svg>
);

const UNIT_VARS = ["var(--u1)", "var(--u2)", "var(--u3)", "var(--u4)", "var(--u5)", "var(--u6)"];
const SKIP_WORDS = /^(&|dan|and|of|the|de|dari)$/i;
function monogram(s) {
  const w = String(s || "").split(/[\s/]+/).filter((x) => /[A-Za-z0-9]/.test(x) && !SKIP_WORDS.test(x));
  if (!w.length) return "??";
  if (w.length >= 2) return (w[0][0] + w[1][0]).toUpperCase();
  return w[0].slice(0, 2).toUpperCase();
}

const SCORE_LABELS = ["Not addressed", "Partial", "Adequate", "Strong"];
const DECISION_OPTS = [
  { k: "reached", label: "Decided", color: "var(--live)" },
  { k: "deferred", label: "Deferred", color: "var(--warn)" },
  { k: "none", label: "No decision", color: "var(--wrong)" },
  { k: "na", label: "N/A", color: "var(--faint)" },
];
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const rand = (n = 4) => Array.from({ length: n }, () => ALPHABET[Math.floor(Math.random() * 32)]).join("");
const fmt = (s) => `${Math.floor((s || 0) / 60)}:${String(Math.floor(s || 0) % 60).padStart(2, "0")}`;
const fmtAgo = (ms) => {
  const m = Math.floor((ms || 0) / 60000);
  if (m < 1) return "less than a minute";
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h`;
};
const ordinal = (n) => (n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th");

function nukeAll() {
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith("ttx:") && k !== K_THEME)
      .forEach((k) => localStorage.removeItem(k));
  } catch (e) { /* private mode */ }
}
const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } };
const lsDel = (k) => { try { localStorage.removeItem(k); } catch (e) { /* private mode */ } };

/* ---------------------------- theme ---------------------------- */

function readTheme() {
  try {
    const v = localStorage.getItem(K_THEME);
    if (v === "light" || v === "dark" || v === "auto") return v;
  } catch (e) { /* private mode */ }
  return "auto";
}
function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", mode);
  try { localStorage.setItem(K_THEME, mode); } catch (e) { /* private mode */ }
}
function ThemeToggle({ compact }) {
  const [mode, setMode] = useState(readTheme);
  useEffect(() => { applyTheme(mode); }, [mode]);
  return (
    <div className={`themes ${compact ? "compact" : ""}`} role="group" aria-label="Theme">
      {[["light", "Light"], ["dark", "Dark"], ["auto", "Auto"]].map(([k, label]) => (
        <button key={k} aria-pressed={mode === k} title={`${label} theme`}
          onClick={() => setMode(k)}>{compact ? label[0] : label}</button>
      ))}
    </div>
  );
}

/* ---------------------------- brand mark ---------------------------- */

/* The logo is an asset you drop in, not something the app draws. Put the
   official file at public/brand/logo.svg (and optionally logo-dark.svg for a
   knockout version on the dark theme). If neither is there, nothing renders
   and the wordmark stands alone — so the app never ships a broken image. */
const LOGO_LIGHT = "/brand/logo.svg";
const LOGO_DARK = "/brand/logo-dark.svg";

function useIsDark() {
  const read = () => {
    const a = document.documentElement.getAttribute("data-theme");
    if (a === "dark") return true;
    if (a === "light") return false;
    return window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)").matches : false;
  };
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const upd = () => setDark(read());
    const mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    if (mq?.addEventListener) mq.addEventListener("change", upd);
    const mo = new MutationObserver(upd);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      if (mq?.removeEventListener) mq.removeEventListener("change", upd);
      mo.disconnect();
    };
  }, []);
  return dark;
}

function BrandLogo({ className = "" }) {
  const dark = useIsDark();
  const chain = dark ? [LOGO_DARK, LOGO_LIGHT] : [LOGO_LIGHT];
  const [i, setI] = useState(0);
  useEffect(() => { setI(0); }, [dark]);
  if (i >= chain.length) return null;
  return (
    <img className={`brandlogo ${className}`} src={chain[i]} alt=""
      onError={() => setI((n) => n + 1)} />
  );
}

/* Shown small and quiet wherever someone might reasonably want to know. */
const AiNote = () => (
  <p className="aidisc">This tool was built in-house with AI assistance.</p>
);

/* ---------------------------- transport ---------------------------- */

/* True once the answering window has closed. Recomputed on a tick so the
   UI locks itself rather than relying on the server to refuse a tap. */
function useExpired(openedAt, limit, active) {
  const [over, setOver] = useState(false);
  useEffect(() => {
    if (!active || !limit || !openedAt) { setOver(false); return; }
    const check = () => setOver(Date.now() - openedAt >= limit * 1000);
    check();
    const iv = setInterval(check, 250);
    return () => clearInterval(iv);
  }, [openedAt, limit, active]);
  return over;
}

function useSocket(onMessage) {
  const ws = useRef(null);
  const handler = useRef(onMessage);
  const queue = useRef([]);
  const [status, setStatus] = useState("connecting");
  /* Bumped on every successful open. A reconnect gives the server a brand new
     socket with no room attached, so whoever owns the session has to re-register
     or they silently stop receiving phase changes. */
  const [gen, setGen] = useState(0);
  handler.current = onMessage;

  useEffect(() => {
    let closed = false, retry = 0, timer;
    const open = () => {
      if (closed) return;
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const sock = new WebSocket(`${proto}//${location.host}/ws`);
      ws.current = sock;
      sock.onopen = () => {
        retry = 0; setStatus("live");
        queue.current.splice(0).forEach((m) => sock.send(JSON.stringify(m)));
        setGen((g) => g + 1);
      };
      sock.onmessage = (e) => {
        try { handler.current?.(JSON.parse(e.data)); } catch (err) { /* junk */ }
      };
      sock.onclose = () => {
        if (closed) return;
        setStatus("reconnecting");
        retry = Math.min(retry + 1, 6);
        timer = setTimeout(open, 400 * 2 ** retry);
      };
      sock.onerror = () => sock.close();
    };
    open();
    return () => { closed = true; clearTimeout(timer); ws.current?.close(); };
  }, []);

  const send = useCallback((msg) => {
    if (ws.current?.readyState === 1) ws.current.send(JSON.stringify(msg));
    else queue.current.push(msg);
  }, []);

  return { send, status, gen };
}

/* ---------------------------- parsing ---------------------------- */

const HEADER_ALIASES = {
  inject: "inject", injectno: "inject", injectnumber: "inject", injectnum: "inject",
  no: "inject", nomor: "inject", nomorinject: "inject",
  condition: "condition", kondisi: "condition", skenario: "condition",
  scenario: "condition", situation: "condition", situasi: "condition",
  peran: "peran", role: "peran", roles: "peran", unit: "peran",
  businessunit: "peran", bu: "peran", audience: "peran", target: "peran",
  siklus: "siklus", cycle: "siklus", phase: "siklus", fase: "siklus",
  round: "siklus", babak: "siklus", tahap: "siklus",
  question: "question", pertanyaan: "question", q: "question", prompt: "question",
  answer: "answer", jawaban: "answer", expectedanswer: "answer",
  jawabanyangdiharapkan: "answer", kuncijawaban: "answer", key: "answer",
  window: "window", windowmin: "window", waktu: "window",
  decisionwindow: "window", bataswaktu: "window", windowminutes: "window",
  tipe: "qtype", type: "qtype", jenis: "qtype", format: "qtype",
  tipesoal: "qtype", jenissoal: "qtype", questiontype: "qtype", answertype: "qtype",
};

/* An optional Tipe column decides the question type outright. Leave it blank, or
   leave the column out entirely, and the shape of the Answer cell decides — so
   every sheet written before b20 still imports unchanged.

   Note "multiple choice" maps to single choice, because that is what people mean
   by it. Ticking several boxes is "checkbox" / "centang" / "pilih banyak". */
const TYPE_ALIASES = {
  pg: "choice", pilihan: "choice", pilihanganda: "choice", choice: "choice", mc: "choice",
  multiplechoice: "choice", single: "choice", singlechoice: "choice", radio: "choice",
  tunggal: "choice", pgtunggal: "choice", satujawaban: "choice",
  checkbox: "checkbox", kotakcentang: "checkbox", centang: "checkbox", multi: "checkbox",
  multiselect: "checkbox", multipleselect: "checkbox", pilihbanyak: "checkbox",
  pgmulti: "checkbox", banyakjawaban: "checkbox", pilihsemua: "checkbox",
  esai: "open", essay: "open", uraian: "open", terbuka: "open", open: "open",
  text: "open", teks: "open", isian: "open", jawabansingkat: "open", shortanswer: "open",
};
const normKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
/* Split only on unambiguous list separators. "&", "/", "dan" and "and" all
   appear inside real unit names — "Hukum & Kepatuhan" is one unit, not two. */
const splitPeran = (v) => [...new Set(
  String(v || "").split(/[,;|]|\r?\n/).map((s) => s.trim()).filter(Boolean)
)];

function detectAnswerType(raw) {
  const t = String(raw || "").trim();
  if (!t) return "open";
  const lines = t.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const bare = lines.map((l) => l.replace(/^\s*\*+\s*/, ""));
  if (bare.filter((s) => /^(?:[A-Ea-e][.)]|[1-6][.)])\s+\S/.test(s)).length >= 2) return "choice";
  return "open";
}
const parseChoices = (raw) => String(raw || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  .map((s) => ({
    /* strip the correct-marker first, then the A./1) prefix — the other
       order leaves the letter in the text and the UI renders it twice */
    text: s
      .replace(/^\s*\*+\s*/, "").replace(/\s*\*+\s*$/, "")
      .replace(/\(correct\)|\[x\]/gi, "")
      .replace(/^\s*(?:[A-Ea-e][.)]|[1-6][.)])\s*/, "")
      .trim(),
    correct: /^\s*\*|\*\s*$|\(correct\)|\[x\]/i.test(s),
  }));

function buildModel(rows) {
  if (!rows.length) return { injects: [], roles: [], warnings: ["The sheet has no rows."] };
  const hmap = {};
  Object.keys(rows[0]).forEach((k) => {
    const hit = HEADER_ALIASES[normKey(k)];
    if (hit && !hmap[hit]) hmap[hit] = k;
  });
  const warnings = [];
  ["inject", "peran", "question"].forEach((f) => {
    if (!hmap[f]) warnings.push(`No column matched "${f}". Check the header row spelling.`);
  });
  const get = (row, f) => (hmap[f] ? String(row[hmap[f]] ?? "").trim() : "");

  let lastInject = "", lastCondition = "", lastSiklus = "", lastWindow = "";
  const flat = [];
  rows.forEach((row, i) => {
    const rawInject = get(row, "inject");
    const inject = rawInject || lastInject;
    if (rawInject) { lastInject = rawInject; lastCondition = ""; lastWindow = ""; }
    if (get(row, "condition")) lastCondition = get(row, "condition");
    if (get(row, "siklus")) lastSiklus = get(row, "siklus");
    if (get(row, "window")) lastWindow = get(row, "window");
    const question = get(row, "question");
    const peranRaw = get(row, "peran");
    if (!question && !peranRaw && !inject) return;
    flat.push({
      srcRow: i + 2, inject: inject || "(unnumbered)",
      condition: get(row, "condition") || lastCondition,
      siklus: get(row, "siklus") || lastSiklus || "(no siklus)",
      window: get(row, "window") || lastWindow,
      question, answer: get(row, "answer"), roles: splitPeran(peranRaw),
      qtype: TYPE_ALIASES[normKey(get(row, "qtype"))] || "",
    });
  });

  const roles = [];
  flat.forEach((r) => r.roles.forEach((x) => { if (!roles.includes(x)) roles.push(x); }));

  const byInject = new Map();
  let noKey = 0;
  const badCheck = [];
  flat.forEach((r) => {
    if (!byInject.has(r.inject)) {
      byInject.set(r.inject, { id: r.inject, siklus: r.siklus, window: r.window, conditions: [], questions: [] });
    }
    const inj = byInject.get(r.inject);
    if (r.condition && !inj.conditions.includes(r.condition)) inj.conditions.push(r.condition);
    if (!inj.window && r.window) inj.window = r.window;
    if (!r.question) return;
    /* The Tipe column wins; otherwise fall back to reading the Answer cell, and
       treat two or more starred options as a checkbox question. */
    let type = r.qtype || detectAnswerType(r.answer);
    let choices = type === "choice" || type === "checkbox" ? parseChoices(r.answer) : [];
    if (!r.qtype && type === "choice" && choices.filter((c) => c.correct).length > 1) type = "checkbox";
    if (r.qtype === "checkbox" && !choices.length) { type = "open"; choices = []; badCheck.push(r.inject); }
    if ((type === "choice" || type === "checkbox") && !choices.some((c) => c.correct)) noKey += 1;
    (r.roles.length ? r.roles : ["(untargeted)"]).forEach((peran, k) => {
      inj.questions.push({
        qid: `${r.inject}::${peran}::${r.srcRow}::${k}`,
        peran, text: r.question, answerRaw: r.answer, type, choices,
      });
    });
  });

  const num = (s) => { const m = String(s).match(/\d+/); return m ? parseInt(m[0], 10) : 9999; };
  const injects = [...byInject.values()].map((inj) => {
    const rs = [];
    inj.questions.forEach((q) => { if (!rs.includes(q.peran)) rs.push(q.peran); });
    return { ...inj, roles: rs, condition: inj.conditions[0] || "", splitNarrative: inj.conditions.length > 1 };
  }).sort((a, b) => num(a.siklus) - num(b.siklus) || num(a.id) - num(b.id));

  const allQ = injects.flatMap((i) => i.questions);
  const mc = allQ.filter((q) => q.type === "choice" || q.type === "checkbox").length;
  if (badCheck.length) {
    warnings.push(`${[...new Set(badCheck)].join(", ")}: marked as checkbox but the Answer cell has no options, so it falls back to an essay question.`);
  }
  if (noKey > 0) {
    warnings.push(`${noKey} multiple-choice question${noKey > 1 ? "s have" : " has"} no correct option marked. Put * at the start of the right answer, or those questions score zero.`);
  }
  injects.forEach((i) => {
    if (i.splitNarrative) warnings.push(`Inject ${i.id} has more than one Condition. Only the first is shown.`);
    if (!i.condition) warnings.push(`Inject ${i.id} has no Condition text.`);
  });
  /* Units are not asked the same number of questions, so say so before the run
     rather than letting it surface as a lopsided leaderboard afterwards. */
  const perRole = {};
  allQ.forEach((q) => {
    if (q.type !== "choice" && q.type !== "checkbox") return;
    if (!(q.choices || []).some((c) => c.correct)) return;
    perRole[q.peran] = (perRole[q.peran] || 0) + 1;
  });
  const counts = Object.values(perRole);
  if (counts.length > 1 && Math.max(...counts) !== Math.min(...counts)) {
    const spread = Object.entries(perRole).sort((a, b) => b[1] - a[1])
      .map(([r, n]) => `${r} ${n}`).join(", ");
    warnings.push(`Units are asked different numbers of scored questions (${spread}). Points alone would favour whoever gets more, so the leaderboard ranks by percentage of each unit's own maximum. Raw points are still shown.`);
  }
  return { injects, roles, warnings, mcCount: mc };
}

const SAMPLE = [
  { "Inject No.": "1", Siklus: "Siklus 1 - Detection", Window: "2", Condition: "At 02:14 the SOC monitoring tool raises a burst of failed authentications against the core banking admin portal, originating from an internal subnet assigned to a third-party maintenance vendor. The on-call analyst has not yet escalated.", Peran: "SOC, IT Operations", Question: "What is your first action in the next 15 minutes?", Answer: "A. Wait for a second alert before acting\n*B. Verify the alert, disable the vendor account, notify the IR lead\nC. Call the vendor and ask what they are doing\nD. Open a ticket and hand over at shift change" },
  { "Inject No.": "", Siklus: "", Condition: "", Peran: "Vendor Management", Question: "Do you have current after-hours contact details and a contractual notification window for this vendor?", Answer: "A. No, we would have to wait for business hours\n*B. Yes, both are in the contract register and reachable now\nC. We have a contact but no defined window" },
  { "Inject No.": "2", Siklus: "Siklus 1 - Detection", Window: "1.5", Condition: "Thirty minutes later the vendor account is confirmed compromised. Logs show successful access to a database holding customer identity documents. The volume of records touched is not yet known.", Peran: "Risk Management", Tipe: "pg", Question: "Has this crossed your threshold for declaring a major incident?", Answer: "A. Not yet, wait for the record count\n*B. Yes, declare immediately on confirmed unauthorised access to customer data\nC. Escalate to the CISO for a decision\nD. Log it as a security event and review at the weekly forum" },
  { "Inject No.": "", Siklus: "", Condition: "", Peran: "SOC", Tipe: "checkbox", Question: "Which of these must be preserved before you rebuild the host? Tick all that apply.", Answer: "*A. Authentication logs for the vendor account\n*B. A memory image of the affected host\nC. The vendor's own ticket history\n*D. Database access logs for the period" },
  { "Inject No.": "", Siklus: "", Condition: "", Peran: "Hukum & Kepatuhan", Question: "What regulatory notification clock has now started?", Answer: "*A. The clock started at confirmation of unauthorised access to personal data\nB. It starts once the record count is final\nC. It starts when the board is briefed" },
  { "Inject No.": "3", Siklus: "Siklus 2 - Response", Window: "2", Condition: "A journalist emails corporate communications at 08:40 asking to confirm a data breach affecting customer identity documents. They cite a post on a criminal forum and want a response within two hours.", Peran: "Corporate Communications, Hukum & Kepatuhan", Question: "What goes in the first response?", Answer: "A. A full account of what happened so far\n*B. A holding statement, legally reviewed, from one named spokesperson\nC. No response until the investigation closes" },
  { "Inject No.": "", Siklus: "", Condition: "", Peran: "Executive", Question: "Do you notify the board now or wait for confirmed scope?", Answer: "*A. Now, covering what is known, what is not, and decisions taken\nB. Wait until scope is confirmed\nC. Delegate to the CISO at the next scheduled meeting" },
];

/* ------------------------- crash containment ------------------------- */

class Boundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div className="crash">
        <h1>Something broke</h1>
        <p className="muted">
          Try clearing first. If it returns immediately, it's a fault in the app
          rather than your device — send this message to whoever runs the exercise.
        </p>
        <pre>{String(this.state.err?.message || this.state.err)}</pre>
        <button className="btn" onClick={() => { nukeAll(); location.reload(); }}>
          Clear and start fresh
        </button>
      </div>
    );
  }
}

/* ================================================================== */

export default function App() {
  const [route, setRoute] = useState(() =>
    isScreenRoute() ? "screen" : isHostRoute() ? "host" : "participant");
  useEffect(() => {
    const onPop = () => setRoute(isScreenRoute() ? "screen" : isHostRoute() ? "host" : "participant");
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const leaveHost = () => { history.pushState({}, "", "/"); setRoute("participant"); };

  return (
    <div className="ttx">
      <style>{CSS}</style>
      <Boundary>
        {route === "screen" ? <Screen />
          : route === "host" ? <Host onExit={leaveHost} />
            : <Participant />}
      </Boundary>
    </div>
  );
}

/* --------------------------- shared pieces --------------------------- */

function Ring({ openedAt, limit, size = "s72", cap }) {
  const [left, setLeft] = useState(limit);
  useEffect(() => {
    const tick = () => setLeft(Math.max(0, limit - (Date.now() - (openedAt || Date.now())) / 1000));
    tick();
    const iv = setInterval(tick, 200);
    return () => clearInterval(iv);
  }, [openedAt, limit]);
  const CIRC = 2 * Math.PI * 52;
  const frac = limit ? Math.max(0, left / limit) : 0;
  const cls = left <= 0 ? "done" : left <= 10 ? "urgent" : frac <= 0.34 ? "warn" : "";
  return (
    <div className={`ring ${size} ${cls}`}>
      <svg viewBox="0 0 120 120">
        <circle className="rtrack" cx="60" cy="60" r="52" />
        <circle className="rfill" cx="60" cy="60" r="52"
          style={{ strokeDasharray: `${CIRC * frac} ${CIRC}` }} />
      </svg>
      <span className="rnum">{fmt(Math.ceil(left))}</span>
      {cap && <span className="rcap">{cap}</span>}
    </div>
  );
}

const Crest = ({ peran, idx, size }) => (
  <span className="crest" style={{
    background: UNIT_VARS[(idx < 0 ? 0 : idx) % 6],
    ...(size ? { width: size, height: size, fontSize: Math.round(size * 0.42) } : {}),
  }}>{monogram(peran)}</span>
);

function Bar({ left, right, onExit, exitLabel = "Exit", conn, theme = true }) {
  return (
    <header className="bar striped">
      <div className="brand"><BrandLogo />{left}</div>
      <div className="barright">
        {conn && conn !== "live" && <span className="offline">Reconnecting</span>}
        {right}
        {theme && <ThemeToggle compact />}
        <span className="build">{BUILD}</span>
        {onExit && <button className="btn quiet" onClick={onExit}>{exitLabel}</button>}
      </div>
    </header>
  );
}

const PHASES = [
  { k: "lobby", label: "Waiting" },
  { k: "briefing", label: "Brief" },
  { k: "open", label: "Answer" },
  { k: "revealed", label: "Discuss" },
];
function PhaseSteps({ phase, onPick }) {
  const at = PHASES.findIndex((p) => p.k === phase);
  return (
    <div className="phases" role="group" aria-label="Phase">
      {PHASES.map((p, i) => (
        <button key={p.k} className={i === at ? "on" : i < at ? "past" : ""}
          onClick={() => onPick(p.k)}>{p.label}</button>
      ))}
    </div>
  );
}

const Check = ({ label, checked, onChange, hint }) => (
  <label className="chk span2">
    <input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} />
    <span><b>{label}</b>{hint && <em>{hint}</em>}</span>
  </label>
);

/* ============================== HOST ============================== */

function Host({ onExit }) {
  const [screen, setScreen] = useState("setup"); // setup | config | run | report
  const [roomId, setRoomId] = useState("");
  const [codes, setCodes] = useState({});
  const [draftCodes, setDraftCodes] = useState({});
  const [settings, setSettings] = useState({
    mode: "auto", timeLimit: 60, points: 1000,
    speedBonus: true, autoReveal: true, showNames: true, showUnits: true, leaderboard: true,
  });
  const [times, setTimes] = useState({});
  const [model, setModel] = useState(null);
  const [warnings, setWarnings] = useState([]);
  const [fileName, setFileName] = useState("");
  const [parseError, setParseError] = useState("");
  const [phase, setPhase] = useState("lobby");
  const [activeIdx, setActiveIdx] = useState(0);
  const [openedAt, setOpenedAt] = useState(null);
  const [keyShown, setKeyShown] = useState(false);
  const [people, setPeople] = useState([]);
  const [scores, setScores] = useState({});
  const [notes, setNotes] = useState({});
  const [revealKey, setRevealKey] = useState({});
  const [roomOpen, setRoomOpen] = useState(false);
  const [confirmNext, setConfirmNext] = useState(false);
  const echo = useRef("");
  const [booted, setBooted] = useState(false);
  const [keyRequired, setKeyRequired] = useState(false);
  const [keyIn, setKeyIn] = useState(() => lsGet(K_KEY) || "");
  const [denied, setDenied] = useState(false);
  const fileRef = useRef(null);

  const onMsg = useCallback((m) => {
    if (m.t === "hosted") {
      setRoomId(m.roomId); setCodes(m.codes); setSettings(m.settings); setTimes(m.times || {});
      setActiveIdx(m.state.activeIdx); setPhase(m.state.phase);
      setKeyShown(!!m.state.keyShown);
      setOpenedAt(m.state.openedAt); setScreen("run");
    } else if (m.t === "state") {
      /* remember what arrived so the push effect below doesn't echo it back */
      echo.current = `${m.activeIdx}:${m.phase}`;
      setActiveIdx(m.activeIdx);
      setPhase(m.phase);
      setKeyShown(!!m.keyShown);
      if (m.openedAt) setOpenedAt(m.openedAt);
    } else if (m.t === "roster") setPeople(m.people || []);
    else if (m.t === "settings") { setSettings(m.settings); if (m.times) setTimes(m.times); }
    else if (m.t === "hello") setKeyRequired(!!m.keyRequired);
    else if (m.t === "denied") { setDenied(true); lsDel(K_KEY); }
    else if (m.t === "gone") { lsDel(K_HOST); setModel(null); setRoomId(""); setScreen("setup"); }
  }, []);
  const { send, status, gen } = useSocket(onMsg);

  /* re-attach after any reconnect */
  useEffect(() => {
    if (gen > 1 && roomId) send({ t: "rehost", roomId });
  }, [gen, roomId, send]);

  useEffect(() => {
    const s = lsGet(K_HOST);
    if (s?.roomId && s?.model) {
      setRoomId(s.roomId); setModel(s.model); setFileName(s.fileName || "");
      setScores(s.scores || {}); setNotes(s.notes || {});
      setCodes(s.codes || {}); setSettings(s.settings || settings); setTimes(s.times || {});
      setScreen("run");
      send({ t: "rehost", roomId: s.roomId });
    }
    setBooted(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [send]);

  useEffect(() => {
    if (!booted || !model || !roomId) return;
    const t = setTimeout(() => {
      lsSet(K_HOST, { roomId, model, fileName, scores, notes, codes, settings, times });
    }, 500);
    return () => clearTimeout(t);
  }, [booted, model, roomId, fileName, scores, notes, codes, settings, times]);

  useEffect(() => {
    if (!roomId || screen !== "run") return;
    const sig = `${activeIdx}:${phase}`;
    if (echo.current === sig) return; // this change came from the server
    send({ t: "state", roomId, activeIdx, phase });
  }, [roomId, screen, activeIdx, phase, send]);

  const roleIdx = useCallback((p) => (model ? model.roles.indexOf(p) : -1), [model]);

  function loadRows(rows, name) {
    const built = buildModel(rows);
    if (!built.injects.length) { setParseError("No injects found. Check that the header row is the first row."); return; }
    setModel({ injects: built.injects, roles: built.roles });
    setWarnings(built.warnings); setFileName(name); setParseError("");
    setDraftCodes(Object.fromEntries(built.roles.map((r) => [r, rand(4)])));
    setTimes(Object.fromEntries(built.injects.map((i) => [i.id, i.window ? String(Math.round(Number(i.window) * 60)) : ""])));
    setScores({}); setNotes({}); setActiveIdx(0); setPhase("lobby");
    setScreen("config");
  }

  async function handleFile(file) {
    if (!file) return;
    try {
      const XLSX = await import("xlsx");
      const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
      loadRows(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" }), file.name);
    } catch (e) {
      setParseError("That file could not be read. Save it as .xlsx or .csv and try again.");
    }
  }

  const start = () => {
    setDenied(false);
    if (keyIn) lsSet(K_KEY, keyIn);
    send({ t: "host", deck: model, settings, codes: draftCodes, times, key: keyIn });
  };

  const setInjectTime = (id, v) => {
    setTimes((t) => ({ ...t, [id]: v }));
    if (roomId) send({ t: "settings", roomId, times: { [id]: v } });
  };
  const limitOf = (id) => {
    const v = times[id];
    return v === "" || v == null ? settings.timeLimit : Number(v);
  };

  const patchSettings = (patch) => {
    setSettings((s) => ({ ...s, ...patch }));
    if (roomId) send({ t: "settings", roomId, settings: patch });
  };

  function endSession() {
    if (roomId) send({ t: "end", roomId });
    lsDel(K_HOST);
    setModel(null); setRoomId(""); setPeople([]); setScreen("setup"); onExit();
  }

  const setScore = (qid, patch) =>
    setScores((s) => ({ ...s, [qid]: { score: null, decision: null, ...(s[qid] || {}), ...patch } }));

  const inject = model?.injects[activeIdx];
  const unitOf = (peran) => {
    if (settings.showUnits) return peran;
    const i = roleIdx(peran);
    return `Unit ${i < 0 ? "?" : String.fromCharCode(65 + i)}`;
  };
  const seatOf = (peran) => people.find((p) => p.peran === peran);
  const openProjector = useCallback(() => {
    if (roomId) window.open(`/screen#${roomId}`, "_blank", "noopener");
  }, [roomId]);

  /* ---- keyboard: the room is watching, don't hunt for buttons ---- */
  const goNext = useCallback(() => {
    if (!model) return;
    setConfirmNext(false); echo.current = "";
    setActiveIdx((i) => Math.min(model.injects.length - 1, i + 1));
    setPhase("briefing");
  }, [model]);
  const goPrev = useCallback(() => {
    setConfirmNext(false); echo.current = "";
    setActiveIdx((i) => Math.max(0, i - 1));
    setPhase("briefing");
  }, []);
  const advance = useCallback(() => {
    echo.current = "";
    if (phase === "lobby") setPhase("briefing");
    else if (phase === "briefing") { setOpenedAt(Date.now()); setPhase("open"); }
    else if (phase === "open") setPhase("revealed");
    else goNext();
  }, [phase, goNext]);

  useEffect(() => {
    if (screen !== "run") return;
    const onKey = (e) => {
      if (e.target.closest && e.target.closest("input, textarea, select")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = String(e.key).toLowerCase();
      if (e.key === " ") { e.preventDefault(); advance(); }
      else if (k === "r" && phase === "open") { echo.current = ""; setPhase("revealed"); }
      else if (k === "k" && phase === "revealed" && !keyShown) send({ t: "showkey", roomId });
      else if (k === "c") setRoomOpen((v) => !v);
      else if (k === "p") openProjector();
      else if (e.key === "ArrowRight") goNext();
      else if (e.key === "ArrowLeft") goPrev();
      else if (e.key === "Escape") setRoomOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [screen, phase, keyShown, roomId, send, advance, goNext, goPrev, openProjector]);

  /* ---- setup ---- */
  if (screen === "setup") {
    return (
      <>
        <Bar left={<b className="wordmark">TTX Live</b>} onExit={onExit} exitLabel="Back" conn={status} />
        <main className="load">
          <div className="loadinner">
            <p className="eyebrow">Facilitator</p>
            <h1>Load your inject sheet</h1>
            <p className="lede">
              One row per question, with <b>Inject No.</b>, <b>Condition</b>, <b>Peran</b>,{" "}
              <b>Siklus</b>, <b>Question</b> and <b>Answer</b>. Optional <b>Window</b> sets the
              answering time for that inject, in minutes.
            </p>
            <p className="lede">
              For multiple choice, put each option on its own line in the Answer cell
              (<code>A. …</code> / <code>B. …</code>) and mark the correct one with a
              leading <code>*</code>. Star <b>two or more</b> options and it becomes a
              tick-all-that-apply question.
            </p>
            <p className="lede">
              An optional <b>Tipe</b> column settles it outright — <code>pg</code>,{" "}
              <code>checkbox</code> or <code>esai</code>. Leave it blank, or leave the
              column out, and the Answer cell decides as before.
            </p>
            <div className="drop" onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); handleFile(e.dataTransfer.files[0]); }}>
              <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" hidden
                onChange={(e) => handleFile(e.target.files[0])} />
              <button className="btn" onClick={() => fileRef.current?.click()}>Choose a file</button>
              <span className="or">or drop it here</span>
            </div>
            {parseError && <div className="err">{parseError}</div>}
            <button className="link" onClick={() => loadRows(SAMPLE, "sample-exercise")}>
              Load a sample exercise instead
            </button>
            <AiNote />
          </div>
        </main>
      </>
    );
  }

  /* ---- config ---- */
  if (screen === "config") {
    return (
      <>
        <Bar left={<b className="wordmark">Before you start</b>}
          onExit={() => setScreen("setup")} exitLabel="Back" conn={status} />
        <main className="load">
          <div className="loadinner wide">
            <h1>Before you start</h1>

            {warnings.length > 0 && (
              <details className="warn" open>
                <summary>{warnings.length} thing{warnings.length > 1 ? "s" : ""} to check</summary>
                <ul>{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
              </details>
            )}

            <h3>Scoring</h3>
            <div className="setgrid">
              <div className="fld span2">
                <span>Mode</span>
                <div className="seg2">
                  {[["auto", "Auto (multiple choice)"], ["manual", "Manual (you score)"]].map(([v, l]) => (
                    <button key={v} className={settings.mode === v ? "on" : ""}
                      onClick={() => patchSettings({ mode: v })}>{l}</button>
                  ))}
                </div>
              </div>
              <p className="hint span2">
                Auto scores multiple-choice answers by correctness and speed. Manual keeps
                answers unscored so you grade them after the discussion. Questions with no
                options always fall through to manual.
              </p>

              {settings.mode === "auto" && (
                <>
                  <label className="fld">
                    <span>Points per question</span>
                    <input type="number" min="0" step="100" value={settings.points}
                      onChange={(e) => patchSettings({ points: Number(e.target.value) })} />
                  </label>
                  <label className="fld">
                    <span>Time limit (seconds, 0 for none)</span>
                    <input type="number" min="0" step="5" value={settings.timeLimit}
                      onChange={(e) => patchSettings({ timeLimit: Number(e.target.value) })} />
                  </label>
                  <Check label="Speed bonus" checked={settings.speedBonus}
                    onChange={(v) => patchSettings({ speedBonus: v })}
                    hint="A correct answer earns half the points, plus up to half again for answering early." />
                  <Check label="Reveal automatically when time runs out" checked={settings.autoReveal}
                    onChange={(v) => patchSettings({ autoReveal: v })}
                    hint="Closes answering and moves the room to discussion the moment the clock hits zero." />
                  <Check label="Show leaderboard" checked={settings.leaderboard}
                    onChange={(v) => patchSettings({ leaderboard: v })}
                    hint="Ranking units against each other can make people defensive rather than candid. Off is the safer default for a first exercise." />
                </>
              )}

              <Check label="Show operator names" checked={settings.showNames}
                onChange={(v) => patchSettings({ showNames: v })}
                hint="Off hides who is sitting at each unit's device." />
              <Check label="Show unit names" checked={settings.showUnits}
                onChange={(v) => patchSettings({ showUnits: v })}
                hint="Off replaces every Peran with a neutral label on your screen. Useful when you're projecting and don't want the room to see which unit gave which answer." />
            </div>

            {settings.mode === "auto" && (
              <>
                <h3>Time per inject</h3>
                <p className="hint">
                  How long each unit gets to answer. Blank uses the {settings.timeLimit}s
                  default. Seeded from the Window column if your sheet has one, and editable
                  during the exercise.
                </p>
                <ul className="codelist">
                  {model.injects.map((i) => (
                    <li key={i.id}>
                      <span className="cname"><b className="mono">{i.id}</b> {i.siklus}</span>
                      <input className="cinput narrow" type="number" min="0" step="5"
                        placeholder={String(settings.timeLimit)}
                        value={times[i.id] ?? ""}
                        onChange={(e) => setTimes((t) => ({ ...t, [i.id]: e.target.value }))} />
                      <span className="unit">sec</span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            <h3>Seats</h3>
            <p className="hint">
              One seat per business unit. The code decides the unit, and the first device to
              use it holds the seat — a second device on the same code is refused. Edit any
              code, or generate a new one.
            </p>
            <ul className="codelist">
              {model.roles.map((r, i) => (
                <li key={r}>
                  <Crest peran={r} idx={i} />
                  <span className="cname">{r}</span>
                  <input className="cinput" maxLength={8} value={draftCodes[r] || ""}
                    onChange={(e) => setDraftCodes((d) => ({ ...d, [r]: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") }))} />
                  <button className="btn quiet" onClick={() => setDraftCodes((d) => ({ ...d, [r]: rand(4) }))}>
                    Random
                  </button>
                </li>
              ))}
            </ul>

            {keyRequired && (
              <>
                <h3>Facilitator passcode</h3>
                <label className="fld">
                  <span>Set by whoever deployed this</span>
                  <input type="password" value={keyIn} autoComplete="off"
                    onChange={(e) => { setKeyIn(e.target.value); setDenied(false); }} />
                </label>
              </>
            )}
            {denied && <div className="err">That passcode was not accepted.</div>}
            <button className="btn wide" onClick={start}
              disabled={keyRequired && !keyIn}>Open the room</button>
          </div>
        </main>
      </>
    );
  }

  /* ---- report ---- */
  if (screen === "report") {
    return <Report {...{ model, scores, notes, people, settings, roleIdx, fileName, unitOf }}
      onBack={() => setScreen("run")} onEnd={endSession} />;
  }

  /* ---- run ---- */
  if (!model || !inject) {
    return (
      <>
        <Bar left={<b className="wordmark">TTX Live</b>} onExit={onExit} exitLabel="Back" conn={status} />
        <div className="crash">
          <h1>This session is no longer on the server</h1>
          <p className="muted">It may have expired, or the service restarted without a volume.</p>
          <button className="btn" onClick={() => { nukeAll(); location.reload(); }}>Start fresh</button>
        </div>
      </>
    );
  }

  const answeredBy = (q) => people.filter((p) => p.peran === q.peran && p.answers?.[q.qid]);
  const seatsHere = inject.roles.map(seatOf).filter(Boolean);
  const allIn = seatsHere.length === inject.roles.length && seatsHere.length > 0 &&
    inject.questions.every((q) => seatOf(q.peran)?.answers?.[q.qid]);

  return (
    <>
      <Bar conn={status} onExit={onExit}
        left={<>
          <span className="crumb">{inject.siklus}</span>
          <b className="injno">Inject {inject.id}</b>
          <PhaseSteps phase={phase} onPick={(k) => {
            echo.current = "";
            if (k === "open" && phase !== "open") setOpenedAt(Date.now());
            setPhase(k);
          }} />
        </>}
        right={<>
          <button className={`btn quiet pill ${settings.showUnits ? "" : "off"}`}
            title={settings.showUnits ? "Hide unit names" : "Show unit names"}
            onClick={() => patchSettings({ showUnits: !settings.showUnits })}>Units</button>
          <button className={`btn quiet pill ${settings.showNames ? "" : "off"}`}
            title={settings.showNames ? "Hide operator names" : "Show operator names"}
            onClick={() => patchSettings({ showNames: !settings.showNames })}>Names</button>
          <button className="btn quiet" onClick={() => setRoomOpen(true)}>
            Seats · {people.length}/{model.roles.length}
          </button>
          <button className="btn quiet" onClick={openProjector} title="Open the projector view">Project</button>
          <button className="btn quiet" onClick={() => setScreen("report")}>Report</button>
        </>} />

      {roomOpen && (
        <RoomPanel {...{ codes, model, settings, unitOf, seatOf }}
          onSetting={patchSettings}
          onRelease={(peran) => send({ t: "release", roomId, peran })}
          onClose={() => setRoomOpen(false)}
          onLobby={() => { echo.current = ""; setPhase("lobby"); setRoomOpen(false); }} />
      )}

      <main className="run">
        <aside className="rail">
          <ol className="tl">
            {model.injects.map((inj, i) => {
              const head = i === 0 || model.injects[i - 1].siklus !== inj.siklus;
              const state = i < activeIdx ? "done" : i === activeIdx ? "now" : "next";
              const words = (inj.condition || "").split(/\s+/).slice(0, 6).join(" ");
              return (
                <React.Fragment key={inj.id}>
                  {head && <li className="tlhead">{inj.siklus}</li>}
                  <li className={`tlrow ${state}`}>
                    <button onClick={() => { echo.current = ""; setActiveIdx(i); setPhase("briefing"); }}>
                      <span className="tldot" aria-hidden="true" />
                      <span className="tlno">{inj.id}</span>
                      <span className="tltext">{words}{words ? "…" : "—"}</span>
                    </button>
                  </li>
                </React.Fragment>
              );
            })}
          </ol>
          <div className="tlfoot">
            <span className="mono">{activeIdx + 1}/{model.injects.length}</span>
            <span className="tlprog"><i style={{ width: `${((activeIdx + 1) / model.injects.length) * 100}%` }} /></span>
          </div>
        </aside>

        <section className="stage">
          {phase === "lobby" ? (
            <Lobby {...{ codes, people, model, unitOf, seatOf }} showNames={settings.showNames}
              onBegin={() => { echo.current = ""; setPhase("briefing"); }} injectId={inject.id} />
          ) : (
            <>
              {inject.condition
                ? <blockquote className="scenario"><span className="eyebrow">Condition</span>{inject.condition}</blockquote>
                : <div className="empty">No scenario text for this inject. Brief the room from your notes.</div>}

              <div className="callon">
                <span>Asking</span>
                {inject.roles.map((r) => (
                  <span key={r} className="chip"><Crest peran={r} idx={roleIdx(r)} />{unitOf(r)}</span>
                ))}
              </div>

              <div className="actbar">
                {phase === "briefing" && (<>
                  <span className="msg">On every device now. Read it aloud, then open the window.</span>
                  {settings.mode === "auto" && (
                    <span className="inlinetime">
                      <input type="number" min="0" step="5" placeholder={String(settings.timeLimit)}
                        value={times[inject.id] ?? ""}
                        onChange={(e) => setInjectTime(inject.id, e.target.value)} />
                      <span className="unit">sec</span>
                    </span>
                  )}
                  <button className="btn" onClick={() => {
                    echo.current = ""; setOpenedAt(Date.now()); setPhase("open");
                  }}>Open for answers</button>
                </>)}

                {phase === "open" && (<>
                  {settings.mode === "auto" && limitOf(inject.id) > 0
                    ? <Ring openedAt={openedAt} limit={limitOf(inject.id)} />
                    : <span className="msg">Answers are open.</span>}
                  <span className="msg">
                    {seatsHere.length === 0 ? "No unit has taken a seat for this inject"
                      : allIn ? "All units in"
                        : `Waiting on answers — ${seatsHere.length} of ${inject.roles.length} units seated`}
                  </span>
                  <button className="btn" onClick={() => { echo.current = ""; setPhase("revealed"); }}>
                    Reveal answers
                  </button>
                </>)}

                {phase === "revealed" && (<>
                  <span className="msg">
                    {keyShown
                      ? "Answer key is on every screen."
                      : "Discuss first. Reveal the key when the room has argued it out."}
                  </span>
                  {!keyShown && (
                    <button className="btn" onClick={() => send({ t: "showkey", roomId })}>
                      Show correct answers
                    </button>
                  )}
                  <button className="btn quiet" onClick={() => {
                    echo.current = ""; setOpenedAt(Date.now()); setPhase("open");
                  }}>Reopen</button>
                </>)}
              </div>

              {phase === "open" && (
                <div className="tracker">
                  {inject.roles.map((r) => {
                    const seat = seatOf(r);
                    const qs = inject.questions.filter((q) => q.peran === r);
                    const done = seat ? qs.filter((q) => seat.answers?.[q.qid]).length : 0;
                    const pct = qs.length ? Math.round((done / qs.length) * 100) : 0;
                    const finishedMs = seat && qs.length && done === qs.length
                      ? Math.max(...qs.map((q) => seat.answers[q.qid]?.ms || 0)) : null;
                    return (
                      <div key={r} className={`trow ${seat && done === qs.length ? "in" : ""}`}
                        style={{ "--c": UNIT_VARS[(roleIdx(r) < 0 ? 0 : roleIdx(r)) % 6] }}>
                        <Crest peran={r} idx={roleIdx(r)} />
                        <span className="tname">{unitOf(r)}</span>
                        <span className="tbar"><i style={{ width: `${pct}%` }} /></span>
                        <span className="tcount mono">{done}/{qs.length}</span>
                        {finishedMs != null
                          ? <span className="tdone mono">{(finishedMs / 1000).toFixed(1)}s</span>
                          : !seat ? <span className="tmiss">seat open</span>
                            : <span className="tmiss">answering</span>}
                      </div>
                    );
                  })}
                </div>
              )}

              {phase === "revealed" && inject.roles.map((peran) => (
                <div key={peran} className="rolegroup">
                  <div className="rolerule" style={{ "--c": UNIT_VARS[(roleIdx(peran) < 0 ? 0 : roleIdx(peran)) % 6] }}>
                    <Crest peran={peran} idx={roleIdx(peran)} />{unitOf(peran)}
                  </div>
                  {inject.questions.filter((q) => q.peran === peran).map((q) => (
                    <QuestionResult key={q.qid} {...{ q, settings, keyShown, unitOf }}
                      answers={answeredBy(q)}
                      sc={scores[q.qid] || {}}
                      onScore={(patch) => setScore(q.qid, patch)}
                      showExpected={revealKey[q.qid]}
                      toggleExpected={() => setRevealKey((v) => ({ ...v, [q.qid]: !v[q.qid] }))} />
                  ))}
                </div>
              ))}

              {phase === "revealed" && (
                <div className="notes">
                  <label htmlFor={`n-${inject.id}`}>Facilitator notes</label>
                  <textarea id={`n-${inject.id}`} rows={3} value={notes[inject.id] || ""}
                    placeholder="Gaps, arguments, who hesitated, anything that becomes a finding"
                    onChange={(e) => setNotes((n) => ({ ...n, [inject.id]: e.target.value }))} />
                </div>
              )}

              <div className="nav">
                <button className="btn quiet" disabled={activeIdx === 0} onClick={goPrev}>Previous</button>
                {activeIdx < model.injects.length - 1 ? (
                  confirmNext ? (
                    <span className="confirm">
                      <span className="msg">Move everyone to inject {model.injects[activeIdx + 1].id}?</span>
                      <button className="btn quiet" onClick={() => setConfirmNext(false)}>Cancel</button>
                      <button className="btn" onClick={goNext}>Yes, move on</button>
                    </span>
                  ) : (
                    <button className="btn" onClick={() => setConfirmNext(true)}>Next inject</button>
                  )
                ) : (
                  <button className="btn" onClick={() => setScreen("report")}>Finish</button>
                )}
              </div>

              <p className="keys">
                <kbd>Space</kbd> advance · <kbd>R</kbd> reveal · <kbd>K</kbd> show key ·{" "}
                <kbd>←</kbd> <kbd>→</kbd> injects · <kbd>C</kbd> seats · <kbd>P</kbd> projector
              </p>
            </>
          )}
        </section>
      </main>
    </>
  );
}

/* --------------------------- host pieces --------------------------- */

function Lobby({ codes, people, model, unitOf, seatOf, showNames, onBegin, injectId }) {
  const taken = people.length;
  return (
    <div className="lobby">
      <div className="lobbytop">
        <div>
          <h2>{model.roles.length} units, {model.roles.length} seats</h2>
          <p className="muted">
            One seat per business unit — the code decides the unit, and the first device to
            use it holds the seat. A second device on the same code is refused.
          </p>
        </div>
        <div className="dial">
          <b className="mono">{taken}</b><span>of {model.roles.length} seats</span>
        </div>
      </div>

      <ul className="codegrid">
        {model.roles.map((r, i) => {
          const code = Object.keys(codes).find((c) => codes[c] === r);
          const seat = seatOf(r);
          return (
            <li key={r} className={seat ? "in" : ""} style={{ "--c": UNIT_VARS[i % 6] }}>
              <span className="cghead">
                <Crest peran={r} idx={i} />
                <b>{unitOf(r)}</b>
                {!seat && <span className="seatopen">seat open</span>}
              </span>
              <b className="cgcode">{code}</b>
              <span className="cgwho">
                {!seat ? "code not used yet"
                  : showNames
                    ? `${seat.name}${seat.live === false ? " · offline" : ""}`
                    : seat.live === false ? "seated · offline" : "seated"}
              </span>
            </li>
          );
        })}
      </ul>

      <button className="btn wide" onClick={onBegin}>
        {injectId ? `Continue to inject ${injectId}` : "Begin the exercise"}
      </button>
      {taken === 0 && (
        <p className="hint">
          You can start with nobody in. A unit that joins later lands on the current inject.
        </p>
      )}
    </div>
  );
}

function RoomPanel({ codes, model, settings, unitOf, seatOf, onSetting, onRelease, onClose, onLobby }) {
  const [confirm, setConfirm] = useState("");
  useEffect(() => {
    const esc = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  return (
    <div className="scrim" onClick={onClose}>
      <aside className="panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Seats">
        <div className="phead">
          <h2>Seats</h2>
          <button className="btn quiet" onClick={onClose}>Close</button>
        </div>
        <p className="hint">
          One device per unit. A unit that lost its page can re-enter its code and take its own
          seat back, keeping its answers. Release a seat only if a unit needs to start clean.
        </p>
        <ul className="codelist big">
          {model.roles.map((r, i) => {
            const code = Object.keys(codes).find((c) => codes[c] === r);
            const seat = seatOf(r);
            return (
              <li key={r}>
                <Crest peran={r} idx={i} />
                <span className="cname">{unitOf(r)}</span>
                <b className="bigcode mono">{code}</b>
                <span className={seat && seat.live !== false ? "tin" : "tmiss"}>
                  {!seat ? "open"
                    : settings.showNames
                      ? `${seat.name}${seat.live === false ? " · offline" : ""}`
                      : seat.live === false ? "offline" : "seated"}
                </span>
                {seat && (confirm === r
                  ? <span className="confirm">
                    <button className="btn quiet" onClick={() => setConfirm("")}>Cancel</button>
                    <button className="btn danger" onClick={() => { onRelease(r); setConfirm(""); }}>Release</button>
                  </span>
                  : <button className="btn quiet" onClick={() => setConfirm(r)}>Release</button>)}
              </li>
            );
          })}
        </ul>

        <h3>On-screen display</h3>
        <Check label="Unit names" checked={settings.showUnits}
          onChange={(v) => onSetting({ showUnits: v })}
          hint="Off shows Unit A, Unit B instead of the real Peran." />
        <Check label="Operator names" checked={settings.showNames}
          onChange={(v) => onSetting({ showNames: v })}
          hint="Off hides who is sitting at each unit's device." />

        <button className="btn quiet wide" onClick={onLobby}>Back to the waiting room</button>
        <p className="hint">
          Sends every device back to standby. Your scores and notes are kept.
        </p>
      </aside>
    </div>
  );
}

const picksOf = (a) => (a ? (a.picks || (a.choice != null ? [a.choice] : [])) : []);

function QuestionResult({ q, answers, settings, sc, onScore, showExpected, toggleExpected, keyShown, unitOf }) {
  const isCheck = q.type === "checkbox";
  const isAuto = settings.mode === "auto" && (q.type === "choice" || isCheck);
  const correctIdx = q.choices ? q.choices.findIndex((c) => c.correct) : -1;

  const dist = useMemo(() => {
    if (!q.choices?.length) return [];
    return q.choices.map((c, i) => ({
      ...c, i, n: answers.filter((p) => picksOf(p.answers[q.qid]).includes(i)).length,
    }));
  }, [q, answers]);
  /* The bar is share of responding units, not share of ticks — on a checkbox
     question the ticks add up to more than the number of units. */
  const total = Math.max(1, answers.length);

  return (
    <div className="qcard">
      <p className="qtext">{q.text}
        {isCheck && <span className="typetag">Pick all that apply</span>}</p>

      {isAuto ? (
        <>
          <ul className="votes">
            {dist.map((c) => {
              const o = optOf(c.i);
              const isKey = keyShown && c.correct;
              return (
                <li key={c.i} className={`vrow ${isKey ? "correct" : ""}`} style={{ "--c": o.c }}>
                  <span className="vglyph"><Glyph shape={o.shape} size={14} /></span>
                  <span className="vtrack">
                    <i className="vfill" style={{ width: `${(c.n / total) * 100}%` }} />
                    <span className="vlabel">{c.text}{isKey && <b> — key</b>}</span>
                  </span>
                  <span className="vn mono">{c.n}<em>{c.n === 1 ? "unit" : "units"}</em></span>
                </li>
              );
            })}
          </ul>
          {keyShown && correctIdx < 0 && (
            <p className="hint warnhint">No correct option marked in your sheet, so nobody scored.</p>
          )}
          <ul className="who-list">
            {answers.map((p) => {
              const a = p.answers[q.qid];
              const picks = picksOf(a);
              const part = a.correct === false && a.acc > 0;
              return (
                <li key={p.pid} className={!keyShown ? "" : a.correct ? "ok" : part ? "part" : a.correct === false ? "no" : ""}>
                  {a.rank && <span className="rk mono">{a.rank}</span>}
                  <span className="wname">{settings.showNames ? p.name : unitOf(p.peran)}</span>
                  <span className="wopt">
                    {picks.map((i) => {
                      const o = optOf(i);
                      return <span key={i} style={{ color: o.c }}><Glyph shape={o.shape} size={11} /></span>;
                    })}
                  </span>
                  <span className="ms mono">{(a.ms / 1000).toFixed(1)}s</span>
                  <span className="pts mono">{keyShown ? (a.points ? `+${a.points}` : "0") : "—"}</span>
                </li>
              );
            })}
            {answers.length === 0 && <li className="none">No answer from this unit.</li>}
          </ul>
        </>
      ) : (
        <>
          {answers.length === 0
            ? <p className="noanswer">No answer from this unit.</p>
            : <ul className="answers">
              {answers.map((p) => (
                <li key={p.pid}>
                  <span className="who">
                    {settings.showNames ? p.name : unitOf(p.peran)} · {(p.answers[q.qid].ms / 1000).toFixed(0)}s
                  </span>
                  <p>{p.answers[q.qid].text}</p>
                </li>
              ))}
            </ul>}
          <div className="qfoot">
            <div className="dims">
              <div className="dim">
                <span className="dimlab">Quality</span>
                <div className="scorer" role="group" aria-label="Quality">
                  {SCORE_LABELS.map((l, s) => (
                    <button key={s} className={sc.score === s ? "on" : ""} title={l} aria-label={l}
                      onClick={() => onScore({ score: sc.score === s ? null : s })}>{s}</button>
                  ))}
                </div>
                <span className="scorelab">{sc.score != null ? SCORE_LABELS[sc.score] : "—"}</span>
              </div>
              <div className="dim">
                <span className="dimlab">Decision</span>
                <div className="dseg" role="group" aria-label="Decision">
                  {DECISION_OPTS.map((o) => (
                    <button key={o.k} style={{ "--c": o.color }} className={sc.decision === o.k ? "on" : ""}
                      onClick={() => onScore({ decision: sc.decision === o.k ? null : o.k })}>{o.label}</button>
                  ))}
                </div>
              </div>
            </div>
            {q.answerRaw && (
              <button className="link" onClick={toggleExpected}>
                {showExpected ? "Hide expected" : "Show expected"}
              </button>
            )}
          </div>
          {showExpected && q.answerRaw && <p className="model">{q.answerRaw}</p>}
        </>
      )}
    </div>
  );
}

/* =========================== PARTICIPANT =========================== */

function Participant() {
  const [me, setMe] = useState(null);
  const [codeIn, setCodeIn] = useState("");
  const [nameIn, setNameIn] = useState("");
  const [peek, setPeek] = useState(null);     // { peran, taken, holder, sinceMs, live }
  const [taken, setTaken] = useState(null);   // refusal from an actual join attempt
  const [deck, setDeck] = useState(null);
  const [state, setState] = useState(null);
  const [settings, setSettings] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [ticks, setTicks] = useState({});   // qid -> number[], uncommitted checkbox picks
  const [msg, setMsg] = useState("");
  const [key, setKey] = useState({});
  const [booted, setBooted] = useState(false);
  const [evicted, setEvicted] = useState(false);
  const codeRef = useRef(null);

  const onMsg = useCallback((m) => {
    if (m.t === "joined") {
      const rec = { pid: m.pid, roomId: m.roomId, peran: m.peran, name: m.me.name,
        seat: m.me.claimedAt, answers: m.me.answers || {}, total: m.me.total || 0,
        possible: m.me.possible || 0, pct: m.me.pct ?? null };
      setMe(rec); lsSet(K_ME, rec);
      setDeck(m.deck); setState(m.state); setSettings(m.settings);
      setMsg(""); setTaken(null); setEvicted(false);
    } else if (m.t === "codeok") { setPeek(m); setMsg(""); }
    else if (m.t === "seattaken") { setTaken(m); setMsg(""); }
    else if (m.t === "state") setState({ activeIdx: m.activeIdx, phase: m.phase,
      openedAt: m.openedAt, limit: m.limit, keyShown: !!m.keyShown });
    else if (m.t === "settings") setSettings(m.settings);
    else if (m.t === "ack") {
      setMe((p) => {
        const n = { ...p, answers: m.me.answers, total: m.me.total,
          possible: m.me.possible ?? p.possible, pct: m.me.pct ?? p.pct };
        lsSet(K_ME, n); return n;
      });
      setMsg("Sent."); setTimeout(() => setMsg(""), 1800);
    }
    else if (m.t === "locked") setMsg("Answers are closed.");
    else if (m.t === "timeup") setMsg("Time is up for this question.");
    else if (m.t === "nosuch") { setPeek(null); setMsg("No exercise found with that code."); }
    else if (m.t === "key") setKey(m.key || {});
    else if (m.t === "evicted") {
      lsDel(K_ME); setMe(null); setDeck(null); setState(null); setEvicted(true);
    }
    else if (m.t === "left" || m.t === "gone" || m.t === "ended") {
      lsDel(K_ME); setMe(null); setDeck(null); setState(null);
    }
  }, []);
  const { send, status, gen } = useSocket(onMsg);

  const meRoom = me?.roomId, mePid = me?.pid, meSeat = me?.seat;
  useEffect(() => {
    if (gen > 1 && meRoom && mePid) send({ t: "rejoin", roomId: meRoom, pid: mePid, seat: meSeat });
  }, [gen, meRoom, mePid, meSeat, send]);

  useEffect(() => {
    const saved = lsGet(K_ME);
    if (saved?.roomId && saved?.pid) {
      setMe(saved);
      send({ t: "rejoin", roomId: saved.roomId, pid: saved.pid, seat: saved.seat });
    }
    setBooted(true);
  }, [send]);

  const leave = () => {
    if (me?.roomId && me?.pid) send({ t: "leave", roomId: me.roomId, pid: me.pid });
    nukeAll(); setMe(null); setDeck(null); setState(null);
    setCodeIn(""); setNameIn(""); setPeek(null); setTaken(null); setKey({});
  };

  /* Derived above every early return. useExpired sat below them, so it only
     ran once a device had joined — the hook count changed between renders,
     which is React error #310. */
  const phase = state?.phase || "lobby";
  const inject = deck?.injects?.[state?.activeIdx ?? 0];
  const mine = inject?.questions || [];
  const limit = state?.limit ?? inject?.limit ?? settings?.timeLimit ?? 0;
  const timeUp = useExpired(
    state?.openedAt,
    settings?.mode === "auto" ? limit : 0,
    phase === "open" && !!me && !!deck
  );

  if (!booted) return <div className="boot">Loading</div>;

  /* ---- join: the front door for everyone but the facilitator ---- */
  if (!me || !deck) {
    const ready = codeIn.length >= 4;
    const doJoin = (takeover) =>
      send({ t: "join", code: codeIn, name: nameIn.trim(), takeover: !!takeover });
    const blocked = taken || (peek && peek.taken ? peek : null);
    return (
      <>
        <Bar left={<b className="wordmark">Tabletop exercise</b>} conn={status} />
        <main className="door">
          <div className="doorinner">
            <h1>Enter your unit's code</h1>
            <p className="lede">
              Four characters from the facilitator. The code puts this device in the right
              unit — one device per unit, so use the one your unit was given.
            </p>

            <div className="slots" onClick={() => codeRef.current?.focus()}>
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className={`slot ${codeIn[i] ? "filled" : i === codeIn.length ? "caret" : ""}`}>
                  {codeIn[i] || ""}
                </div>
              ))}
              <input ref={codeRef} className="codeghost" value={codeIn} maxLength={8}
                autoComplete="off" autoCapitalize="characters" spellCheck="false"
                aria-label="Your unit's code"
                onChange={(e) => {
                  const v = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
                  setCodeIn(v); setPeek(null); setTaken(null); setEvicted(false);
                  if (v.length >= 4) send({ t: "peek", code: v });
                }}
                onKeyDown={(e) => e.key === "Enter" && ready && !blocked && doJoin(false)} />
            </div>

            {evicted && (
              <div className="resolved taken">
                <div><small>Signed out</small><b>Another device took this unit's seat</b></div>
              </div>
            )}

            {blocked ? (
              <>
                <div className="resolved taken">
                  <Crest peran={blocked.peran} idx={0} size={34} />
                  <div><small>Seat already taken</small><b>{blocked.peran}</b></div>
                </div>
                <p className="hint">
                  {blocked.name || blocked.holder || "Another device"} has held this seat
                  for {fmtAgo(blocked.sinceMs)}
                  {blocked.live === false ? ", but is offline right now" : ""}. One unit holds one
                  seat, so this device cannot join alongside them.
                </p>
                <button className="btn wide warnbtn" onClick={() => doJoin(true)}>
                  Take over the seat
                </button>
                <p className="hint">
                  Taking over signs the other device out and keeps this unit's answers and points.
                  Use it when your unit switched device or lost the page.
                </p>
              </>
            ) : peek ? (
              <>
                <div className="resolved">
                  <Crest peran={peek.peran} idx={0} size={34} />
                  <div><small>Claiming the seat for</small><b>{peek.peran}</b></div>
                </div>
                <label className="fld">
                  <span>Who is at this device <em>optional</em></span>
                  <input value={nameIn} onChange={(e) => setNameIn(e.target.value)}
                    placeholder="Name or meeting room" autoComplete="off" />
                </label>
                <button className="btn wide" onClick={() => doJoin(false)}>Take the seat</button>
              </>
            ) : (
              <p className="resolve">
                {msg || (ready ? "Checking…" : "The facilitator reads the codes out, or they are on the projector.")}
              </p>
            )}

            <div className="doorfoot">
              {(lsGet(K_ME) || lsGet(K_HOST)) && (
                <button className="link quiet" onClick={() => { nukeAll(); location.reload(); }}>
                  Clear saved session
                </button>
              )}
              <AiNote />
            </div>
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      <Bar onExit={leave} exitLabel="Leave" conn={status}
        left={<>
          <Crest peran={me.peran} idx={0} />
          <span className="unitblock">
            <b className="unitname">{me.peran}</b>
            <small className="seatline">
              one seat{me.name && me.name !== me.peran ? ` · ${me.name}` : ""}
            </small>
          </span>
        </>}
        right={settings?.mode === "auto" && settings?.leaderboard && state?.keyShown
          ? <span className="ptsbadge mono">{(me.total || 0).toLocaleString()}</span> : null} />
      <main className="pmain">
        <div className="pinner">
          {phase === "lobby" && (
            <div className="standby">
              <span className="pulse" />
              <h2>Your unit is in</h2>
              <p className="muted">Waiting for the facilitator to begin.</p>
            </div>
          )}

          {phase !== "lobby" && inject && (
            <>
              <div className="eyebrow">{inject.siklus} · Inject {inject.id}</div>
              {inject.condition && (
                <blockquote className="condition">
                  <span className="eyebrow">Condition</span>{inject.condition}
                </blockquote>
              )}

              {phase === "briefing" && (
                <div className="standby small">
                  <span className="pulse" />
                  <p className="muted">
                    Read the scenario. Questions open shortly
                    {limit > 0 && settings?.mode === "auto" ? ` — your window will be ${fmt(limit)}` : ""}.
                  </p>
                </div>
              )}

              {phase === "open" && (mine.length === 0 ? (
                <div className="standby small">
                  <p className="muted">This inject doesn't involve your unit. Listen in.</p>
                </div>
              ) : (
                <>
                  {limit > 0 && settings?.mode === "auto" && (
                    <div className="ringwrap">
                      <Ring openedAt={state.openedAt} limit={limit} size="s150" cap="left" />
                    </div>
                  )}
                  {mine.map((q) => {
                    const sent = me.answers?.[q.qid];
                    const auto = settings.mode === "auto" && q.choices?.length;
                    const isMC = q.type === "choice" && auto;
                    const isCheck = q.type === "checkbox" && auto;
                    /* Single choice commits on tap. Checkbox collects ticks locally and
                       commits on Send, because there is no single tap that means "done". */
                    const cur = ticks[q.qid] ?? sent?.picks ?? [];
                    const toggle = (i) => setTicks((t) => ({
                      ...t,
                      [q.qid]: cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i].sort((a, b) => a - b),
                    }));
                    const dirty = JSON.stringify(cur) !== JSON.stringify(sent?.picks ?? []);
                    return (
                      <div className="pq" key={q.qid}>
                        <p className="pqtext">{q.text}</p>
                        {isMC || isCheck ? (
                          <>
                            {isCheck && (
                              <p className="multinote">
                                <span className="multibadge">Pick all that apply</span>
                                Wrong ticks cancel out right ones, so only tick what your unit stands behind.
                              </p>
                            )}
                            <div className="opts">
                              {q.choices.map((c, i) => {
                                const o = optOf(i);
                                const picked = isCheck ? cur.includes(i) : sent && sent.choice === i;
                                const dim = isCheck
                                  ? (timeUp && !picked)
                                  : ((sent || timeUp) && !picked);
                                return (
                                  <button key={i} disabled={timeUp}
                                    className={`opt ${picked ? "picked" : ""} ${dim ? "faded" : ""}`}
                                    style={{ "--c": o.c }}
                                    aria-pressed={isCheck ? picked : undefined}
                                    onClick={() => isCheck
                                      ? toggle(i)
                                      : send({ t: "answer", roomId: me.roomId, pid: me.pid, answers: { [q.qid]: i } })}>
                                    <span className="oglyph"><Glyph shape={o.shape} /></span>
                                    <span className="otxt">{c.text}</span>
                                    {isCheck
                                      ? <span className={`otick ${picked ? "on" : ""}`} aria-hidden="true">
                                        {picked && (
                                          <svg viewBox="0 0 24 24" width="11" height="11" fill="none"
                                            stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
                                            <path d="M4 12.5l5.2 5.2L20 7" />
                                          </svg>
                                        )}
                                      </span>
                                      : <span className="oltr mono">{o.ltr}</span>}
                                  </button>
                                );
                              })}
                            </div>
                            {isCheck && !timeUp && (
                              <button className="btn wide" disabled={!cur.length && !sent}
                                onClick={() => send({ t: "answer", roomId: me.roomId, pid: me.pid, answers: { [q.qid]: cur } })}>
                                {!sent ? `Send ${cur.length || "no"} answer${cur.length === 1 ? "" : "s"}`
                                  : dirty ? `Update — ${cur.length} ticked` : `Sent — ${cur.length} ticked`}
                              </button>
                            )}
                            {timeUp ? (
                              <div className="lockstamp">
                                <svg viewBox="0 0 24 24" width="17" height="17" fill="none"
                                  stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                                  <path d="M7 11V8a5 5 0 0110 0v3" />
                                  <rect x="4" y="11" width="16" height="9" rx="2.4" />
                                </svg>
                                Window closed — answer locked in
                              </div>
                            ) : sent ? (
                              <>
                                <p className="sentline">
                                  <span className="tick">
                                    <svg viewBox="0 0 24 24" width="11" height="11" fill="none"
                                      stroke="currentColor" strokeWidth="4" strokeLinecap="round">
                                      <path d="M4 12.5l5.2 5.2L20 7" />
                                    </svg>
                                  </span>
                                  Answer in{sent.rank ? ` — ${sent.rank}${ordinal(sent.rank)} unit to answer` : ""}
                                  {isCheck && dirty ? " · unsent changes" : ""}
                                </p>
                                <p className="hint">
                                  This is the whole unit's answer. {isCheck
                                    ? "Change the ticks and send again — only your last send counts, and it sets your time."
                                    : "Tap another tile to change it — only your last choice counts, and it sets your time."}
                                </p>
                              </>
                            ) : (
                              <p className="hint centre">
                                One answer for the whole unit. Decide together, then {isCheck ? "send" : "tap"}.
                              </p>
                            )}
                          </>
                        ) : (
                          <>
                            <textarea rows={5} placeholder="Type your unit's answer" disabled={timeUp}
                              value={drafts[q.qid] ?? sent?.text ?? ""}
                              onChange={(e) => setDrafts((d) => ({ ...d, [q.qid]: e.target.value }))} />
                            <button className="btn wide" disabled={timeUp}
                              onClick={() => send({ t: "answer", roomId: me.roomId, pid: me.pid, answers: { [q.qid]: drafts[q.qid] ?? "" } })}>
                              {sent ? "Update answer" : "Send answer"}
                            </button>
                            {timeUp
                              ? <div className="lockstamp">Window closed</div>
                              : sent && <p className="hint centre">Sent. You can revise until answers close.</p>}
                          </>
                        )}
                      </div>
                    );
                  })}
                  {msg && <p className="sentnote">{msg}</p>}
                </>
              ))}

              {phase === "revealed" && (
                settings?.mode === "auto" && mine.length > 0 ? (
                  <div className="myresult">
                    {mine.map((q) => {
                      const a = me.answers?.[q.qid];
                      const k = key[q.qid];
                      const keyIdx = k ? (k.is || [k.i]) : null;
                      if (!a) {
                        return (
                          <div className="rescard miss" key={q.qid}>
                            <p className="qtext small">{q.text}</p>
                            <p className="rline">No answer sent</p>
                            {keyIdx && <KeyLine idx={keyIdx} text={k.texts ? k.texts.join("; ") : k.text} mine={false} />}
                          </div>
                        );
                      }
                      const mineIdx = a.picks || (a.choice != null ? [a.choice] : []);
                      const part = a.correct === false && a.acc > 0;
                      const cls = !state?.keyShown ? "" : a.correct ? "ok" : part ? "part" : a.correct === false ? "no" : "";
                      const hits = keyIdx ? mineIdx.filter((i) => keyIdx.includes(i)).length : 0;
                      const wrong = mineIdx.length - hits;
                      return (
                        <div className={`rescard ${cls}`} key={q.qid}>
                          <div className="verdict">
                            <span className="badge">
                              {!state?.keyShown
                                ? <Glyph shape={optOf(mineIdx[0] ?? 0).shape} size={15} />
                                : a.correct
                                  ? <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
                                    strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M4 12.5l5.2 5.2L20 7" /></svg>
                                  : part
                                    ? <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
                                      strokeWidth="3.4" strokeLinecap="round"><path d="M6 12h12" /></svg>
                                    : <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
                                      strokeWidth="3.4" strokeLinecap="round">
                                      <path d="M6 6l12 12M18 6L6 18" /></svg>}
                            </span>
                            <b>{!state?.keyShown ? "Answer sent"
                              : a.correct == null ? "Not auto-scored"
                                : a.correct ? "Correct"
                                  : part ? "Partly right" : "Not the key"}</b>
                            {state?.keyShown && a.acc != null && a.acc < 1 && a.acc > 0 && (
                              <span className="accpill">{Math.round(a.acc * 100)}% of the key</span>
                            )}
                          </div>
                          <p className="qtext small">{q.text}</p>
                          {state?.keyShown && (
                            <div className="ptsbig mono">{a.points ? `+${a.points.toLocaleString()}` : "0"}</div>
                          )}
                          <div className="metarow">
                            <span>Answered in <b className="mono">{(a.ms / 1000).toFixed(1)}s</b></span>
                            {a.rank && <span><b className="mono">{a.rank}{ordinal(a.rank)}</b> to answer</span>}
                            {state?.keyShown && keyIdx && q.type === "checkbox" && (
                              <span><b className="mono">{hits}</b> of {keyIdx.length} right
                                {wrong ? <>, <b className="mono">{wrong}</b> wrong</> : null}</span>
                            )}
                          </div>
                          <KeyLine idx={mineIdx} text={a.text} mine />
                          {keyIdx && !a.correct && (
                            <KeyLine idx={keyIdx} text={k.texts ? k.texts.join("; ") : k.text} mine={false} />
                          )}
                        </div>
                      );
                    })}
                    {settings?.leaderboard && state?.keyShown && (
                      <div className="totalline">
                        <b className="mono">{me.pct == null ? `${(me.total || 0).toLocaleString()} pts` : `${Math.round(me.pct)}%`}</b>
                        <span className="mono">
                          {(me.total || 0).toLocaleString()}
                          {me.possible ? ` of ${me.possible.toLocaleString()} available to your unit` : " pts total"}
                        </span>
                      </div>
                    )}
                    <p className="hint centre">The facilitator is leading the discussion.</p>
                  </div>
                ) : (
                  <div className="standby small">
                    <h2>Answers are in</h2>
                    <p className="muted">The facilitator is leading the discussion.</p>
                  </div>
                )
              )}
            </>
          )}
        </div>
      </main>
    </>
  );
}

const KeyLine = ({ idx, text, mine }) => {
  const list = idx || [];
  if (!list.length) return null;
  const many = list.length > 1;
  const names = list.map((i) => optOf(i).name).join(", ");
  return (
    <div className="keyline">
      <span className="kglyphs">
        {list.map((i) => {
          const o = optOf(i);
          return (
            <span key={i} className="kglyph" style={{ "--c": o.c }}>
              <Glyph shape={o.shape} size={11} />
            </span>
          );
        })}
      </span>
      <span>
        {mine ? (many ? "You ticked " : "You chose the ") : (many ? "The key was " : "The key was the ")}
        <b>{names}</b>{text ? ` — ${text}` : ""}
      </span>
    </div>
  );
};

/* ============================= PROJECTOR ============================= */

/* /screen#<roomId>. Read-only: condition, question, option shapes, a clock
   you can read from the back of the room, and the join codes. Never the
   facilitator's controls, notes or unit scores. */
function Screen() {
  const [roomId] = useState(screenRoom);
  const [deck, setDeck] = useState(null);
  const [codes, setCodes] = useState({});
  const [state, setState] = useState(null);
  const [settings, setSettings] = useState(null);
  const [people, setPeople] = useState([]);
  const [key, setKey] = useState({});

  const onMsg = useCallback((m) => {
    if (m.t === "screened") {
      setDeck(m.deck); setCodes(m.codes); setState(m.state); setSettings(m.settings);
    } else if (m.t === "state") {
      setState({ activeIdx: m.activeIdx, phase: m.phase, openedAt: m.openedAt,
        limit: m.limit, keyShown: !!m.keyShown });
      if (!m.keyShown) setKey({});
    } else if (m.t === "roster") setPeople(m.people || []);
    else if (m.t === "settings") setSettings(m.settings);
    else if (m.t === "key") setKey(m.key || {});
    else if (m.t === "gone" || m.t === "ended") { setDeck(null); setState(null); }
  }, []);
  const { send, status, gen } = useSocket(onMsg);

  useEffect(() => { if (roomId) send({ t: "watch", roomId }); }, [roomId, gen, send]);

  if (!roomId) {
    return (
      <div className="crash">
        <h1>No exercise in the address</h1>
        <p className="muted">
          Open the projector view from the facilitator screen — the <b>Project</b> button —
          so it carries the exercise id.
        </p>
      </div>
    );
  }
  if (!deck || !state) {
    return (
      <div className="projwait">
        <span className="pulse" />
        <h1>Waiting for the exercise</h1>
        <p className="muted">{status === "live" ? "Connected." : "Reconnecting…"}</p>
      </div>
    );
  }

  const inject = deck.injects[state.activeIdx];
  const phase = state.phase;
  const seatOf = (peran) => people.find((p) => p.peran === peran);
  const shown = phase === "lobby" ? [] : (inject?.questions || []);

  return (
    <div className="screen">
      <div className="projtop striped">
        <BrandLogo className="big" />
        <div>
          <p className="eyebrow">{inject?.siklus}</p>
          <h1>Inject {inject?.id}</h1>
        </div>
        <span className={`projphase ${phase}`}>
          <span className="pulse" />
          {phase === "lobby" ? "Waiting"
            : phase === "briefing" ? "Read the scenario"
              : phase === "open" ? "Answering"
                : state.keyShown ? "Answer key" : "Discussing"}
        </span>
      </div>

      <div className="projbody">
        {phase === "lobby" ? (
          <div className="projlobby">
            <h2>Enter your unit's code</h2>
            <p className="muted">One device per business unit.</p>
          </div>
        ) : (
          <div className="projmid">
            <div className="projleft">
              {inject?.condition && <p className="projcond">{inject.condition}</p>}
              {shown.map((q) => {
                const k = key[q.qid];
                return (
                  <div className="projq" key={q.qid}>
                    <p className="projqtext">{q.text}</p>
                    {q.type === "checkbox" && <p className="projtype">Pick all that apply</p>}
                    {q.choices?.length > 0 && (
                      <div className="projopts">
                        {q.choices.map((c, i) => {
                          const o = optOf(i);
                          const isKey = !!k && (k.is || [k.i]).includes(i);
                          const n = phase === "revealed"
                            ? people.filter((p) => picksOf(p.answers?.[q.qid]).includes(i)).length : null;
                          return (
                            <div key={i} className={`projopt ${isKey ? "key" : ""}`} style={{ "--c": o.c }}>
                              <span className="oglyph"><Glyph shape={o.shape} size={15} /></span>
                              <span className="otxt">{c.text}</span>
                              {n != null && <span className="on mono">{n}</span>}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {phase === "open" && state.limit > 0 && settings?.mode === "auto" && (
              <Ring openedAt={state.openedAt} limit={state.limit} size="s220" cap="left" />
            )}
          </div>
        )}

        <div className="projstrip">
          <span className="lab">Join</span>
          {deck.roles.map((r, i) => {
            const code = Object.keys(codes).find((c) => codes[c] === r);
            const seat = seatOf(r);
            return (
              <span key={r} className={`jcode ${seat ? "in" : ""}`}>
                <Crest peran={r} idx={i} size={20} />
                <b className="mono">{code}</b>
                {seat && (
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
                    strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 12.5l5.2 5.2L20 7" />
                  </svg>
                )}
              </span>
            );
          })}
          {status !== "live" && <span className="offline">Reconnecting</span>}
          <AiNote />
        </div>
      </div>
    </div>
  );
}

/* ============================= REPORT ============================= */

function Report({ model, scores, notes, people, settings, roleIdx, fileName, unitOf, onBack, onEnd }) {
  const all = useMemo(() => model.injects.flatMap((i) =>
    i.questions.map((q) => ({ ...q, injectId: i.id, siklus: i.siklus }))), [model]);

  /* A unit asked ten questions can out-point a unit asked three without being
     any better at the exercise. Every comparison here is therefore a percentage
     of what that unit could have scored; raw points stay visible beside it.
     Questions with no key marked are excluded, so a sheet mistake costs nobody. */
  const possibleOf = useCallback((role) => {
    if (settings.mode !== "auto") return 0;
    const n = model.injects.flatMap((i) => i.questions).filter((q) =>
      q.peran === role && (q.type === "choice" || q.type === "checkbox") &&
      (q.choices || []).some((c) => c.correct)).length;
    return n * (Number(settings.points) || 0);
  }, [model, settings.mode, settings.points]);

  const board = useMemo(() => [...people]
    .map((p) => {
      const possible = p.possible ?? possibleOf(p.peran);
      return { ...p, possible, pct: possible ? ((p.total || 0) / possible) * 100 : null };
    })
    .sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1) || (b.total || 0) - (a.total || 0)),
  [people, possibleOf]);

  const byRole = useMemo(() => {
    const o = {};
    all.forEach((q) => {
      if (!o[q.peran]) o[q.peran] = { total: 0, scored: 0, sum: 0, correct: 0, part: 0, mc: 0, pts: 0 };
      const b = o[q.peran];
      b.total += 1;
      const sc = scores[q.qid] || {};
      if (sc.score != null) { b.scored += 1; b.sum += sc.score; }
      people.filter((p) => p.peran === q.peran && p.answers?.[q.qid]).forEach((p) => {
        const a = p.answers[q.qid];
        if (a.correct != null) { b.mc += 1; if (a.correct) b.correct += 1; if (a.acc > 0 && !a.correct) b.part += 1; }
        b.pts += a.points || 0;
      });
    });
    Object.entries(o).forEach(([role, b]) => {
      b.possible = possibleOf(role);
      b.pct = b.possible ? (b.pts / b.possible) * 100 : null;
    });
    return o;
  }, [all, scores, people, possibleOf]);

  function exportCSV() {
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const head = ["Siklus", "Inject", "Peran", "Question", "Type", "Expected", "Operator", "Answer",
      "Correct", "Accuracy", "Seconds", "Points", "Unit points", "Unit max", "Unit score %",
      "Quality", "Decision", "Answer window (s)", "Notes"];
    const lines = [head.map(esc).join(",")];
    model.injects.forEach((inj) => {
      const win = inj.window ? Math.round(Number(inj.window) * 60) : "";
      inj.questions.forEach((q) => {
        const sc = scores[q.qid] || {};
        const rs = people.filter((p) => p.peran === q.peran && p.answers?.[q.qid]);
        (rs.length ? rs : [null]).forEach((p) => {
          const a = p?.answers[q.qid];
          const poss = possibleOf(q.peran);
          lines.push([inj.siklus, inj.id, q.peran, q.text, q.type, q.answerRaw,
            p ? (settings.showNames ? p.name : unitOf(p.peran)) : "", a?.text || "",
            a?.correct == null ? "" : a.correct ? "Yes" : a.acc > 0 ? "Partly" : "No",
            a?.acc == null ? "" : Math.round(a.acc * 100) + "%",
            a ? (a.ms / 1000).toFixed(1) : "", a?.points ?? "",
            p ? p.total ?? "" : "", poss || "",
            p && poss ? Math.round(((p.total || 0) / poss) * 100) + "%" : "",
            sc.score != null ? SCORE_LABELS[sc.score] : "",
            sc.decision ? DECISION_OPTS.find((d) => d.k === sc.decision)?.label : "",
            win, notes[inj.id] || ""].map(esc).join(","));
        });
      });
    });
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `ttx-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const totalPts = people.reduce((a, p) => a + (p.total || 0), 0);
  const mcAll = Object.values(byRole).reduce((a, b) => a + b.mc, 0);
  const mcRight = Object.values(byRole).reduce((a, b) => a + b.correct, 0);
  const rated = board.filter((p) => p.pct != null);
  const avgPct = rated.length ? rated.reduce((a, p) => a + p.pct, 0) / rated.length : null;
  const uneven = new Set(Object.values(byRole).map((b) => b.possible)).size > 1;

  return (
    <>
      <Bar left={<b className="wordmark">Debrief · {fileName}</b>} onExit={onBack} exitLabel="Back" />
      <main className="report">
        <div className="repinner">
          <h1>Exercise results</h1>
          <div className="kpis">
            <div><b className="mono">{people.length}</b><span>units seated</span></div>
            <div><b className="mono">{all.length}</b><span>questions</span></div>
            <div><b className="mono good">{mcAll ? `${Math.round((mcRight / mcAll) * 100)}%` : "—"}</b><span>answered correctly</span></div>
            <div><b className="mono">{avgPct == null ? "—" : `${Math.round(avgPct)}%`}</b>
              <span>average unit score</span>
              <em className="kpisub mono">{totalPts.toLocaleString()} pts total</em></div>
          </div>

          {settings.mode === "auto" && settings.leaderboard && board.length > 0 && (
            <>
              <h3>Where the room stood</h3>
              <p className="hint boardnote">
                Ranked by each unit's percentage of its own maximum, because units are
                not asked the same number of questions.{uneven
                  ? " They were not, in this exercise — the counts differ, so raw points would have favoured whoever was asked more."
                  : ""}
              </p>
              <ol className="board">
                {board.map((p, i) => (
                  <li key={p.pid} className={i === 0 ? "first" : ""}>
                    <span className="rank mono">{String(i + 1).padStart(2, "0")}</span>
                    <Crest peran={p.peran} idx={roleIdx(p.peran)} />
                    <span className="bname">{settings.showNames ? p.name : unitOf(p.peran)}</span>
                    <span className="bbar"><i style={{
                      width: `${Math.max(0, Math.min(100, p.pct ?? 0))}%`,
                      background: UNIT_VARS[(roleIdx(p.peran) < 0 ? 0 : roleIdx(p.peran)) % 6],
                    }} /></span>
                    <span className="bscore">
                      <b className="mono">{p.pct == null ? "—" : `${Math.round(p.pct)}%`}</b>
                      <em className="mono">{(p.total || 0).toLocaleString()} / {(p.possible || 0).toLocaleString()}</em>
                    </span>
                  </li>
                ))}
              </ol>
            </>
          )}

          <h3>By Peran</h3>
          <div className="tblwrap">
            <table className="tbl">
              <thead><tr><th>Peran</th><th>Asked</th><th>Correct</th><th>Partly</th>
                <th>Points</th><th>Max</th><th>Score</th>
                {settings.mode === "manual" && <th>Quality</th>}</tr></thead>
              <tbody>
                {Object.entries(byRole).map(([role, d]) => (
                  <tr key={role}>
                    <td><Crest peran={role} idx={roleIdx(role)} /> {unitOf(role)}</td>
                    <td className="mono">{d.total}</td>
                    <td className="mono">{d.mc ? `${d.correct}/${d.mc}` : "—"}</td>
                    <td className="mono">{d.part || "—"}</td>
                    <td className="mono">{d.pts ? d.pts.toLocaleString() : "—"}</td>
                    <td className="mono dimcell">{d.possible ? d.possible.toLocaleString() : "—"}</td>
                    <td className="mono strong">{d.pct == null ? "—" : `${Math.round(d.pct)}%`}</td>
                    {settings.mode === "manual" &&
                      <td className="mono">{d.scored ? (d.sum / d.scored).toFixed(1) : "—"}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="repactions">
            <button className="btn" onClick={exportCSV}>Download CSV</button>
            <button className="btn quiet" onClick={onBack}>Back to the run</button>
            <button className="btn danger" onClick={onEnd}>End session</button>
          </div>
          <p className="hint">Ending clears the room for everyone. Download the CSV first.</p>
          <AiNote />
        </div>
      </main>
    </>
  );
}

/* ============================== CSS ============================== */

const CSS = `
/* ---------- LIGHT is the base token set ---------- */
:root{
  --ink:#F5F3EC; --ink2:#EAE7DB; --slab:#FFFFFF; --rise:#FFF8E0;
  --edge:#D8D3C2; --edge2:#EAE6D9;
  --txt:#17160F; --dim:#56534A; --faint:#85806F;
  --signal:#FFC600; --signal-ink:#1A1400; --signal-text:#8A6200; --signal-soft:#FFF1C2;
  --live:#0E8A5F;  --live-soft:#E4F4EC;  --live-edge:#A9D8C2;
  --wrong:#C8304A; --wrong-soft:#FBE8EB; --wrong-edge:#E7B3BD;
  --warn:#A96E06;  --warn-soft:#FCF0D8;  --warn-edge:#E0C489;
  --oA:#CE2743; --oB:#2456D2; --oC:#7136CE; --oD:#0C8760;
  --on-opt:#FFFFFF;
  --u1:#C93A54; --u2:#2F62D6; --u3:#A96C0C; --u4:#0E7F66; --u5:#6C45C4; --u6:#1B7A92;
  --on-unit:#FFFFFF;
  --shadow:0 20px 44px -26px rgba(30,26,10,.34);
  --disp:'Archivo',"Helvetica Neue",system-ui,sans-serif;
  --body:'Plus Jakarta Sans',system-ui,-apple-system,sans-serif;
  --mono:'JetBrains Mono',ui-monospace,"SFMono-Regular",monospace;
  color-scheme:light;
}
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]){
    --ink:#141310; --ink2:#0B0A08; --slab:#1E1C17; --rise:#2C2718;
    --edge:#3F3A2B; --edge2:#2B2820;
    --txt:#F4F2EC; --dim:#A9A597; --faint:#7C7768;
    --signal:#FFC600; --signal-ink:#1A1400; --signal-text:#FFC600; --signal-soft:#3B3208;
    --live:#2BD79A;  --live-soft:rgba(43,215,154,.13);  --live-edge:rgba(43,215,154,.42);
    --wrong:#FF5A75; --wrong-soft:rgba(255,90,117,.12); --wrong-edge:rgba(255,90,117,.42);
    --warn:#FFB43D;  --warn-soft:rgba(255,180,61,.12);  --warn-edge:rgba(255,180,61,.40);
    --oA:#F0435E; --oB:#5286FF; --oC:#A374F5; --oD:#1FC98D;
    --on-opt:#141310;
    --u1:#F0697F; --u2:#6A94FF; --u3:#E2A03F; --u4:#2FB89A; --u5:#A683F0; --u6:#4FB8D1;
    --on-unit:#141310;
    --shadow:0 28px 66px -30px rgba(0,0,0,.85);
    color-scheme:dark;
  }
}
:root[data-theme="dark"]{
  --ink:#141310; --ink2:#0B0A08; --slab:#1E1C17; --rise:#2C2718;
  --edge:#3F3A2B; --edge2:#2B2820;
  --txt:#F4F2EC; --dim:#A9A597; --faint:#7C7768;
  --signal:#FFC600; --signal-ink:#1A1400; --signal-text:#FFC600; --signal-soft:#3B3208;
  --live:#2BD79A;  --live-soft:rgba(43,215,154,.13);  --live-edge:rgba(43,215,154,.42);
  --wrong:#FF5A75; --wrong-soft:rgba(255,90,117,.12); --wrong-edge:rgba(255,90,117,.42);
  --warn:#FFB43D;  --warn-soft:rgba(255,180,61,.12);  --warn-edge:rgba(255,180,61,.40);
  --oA:#F0435E; --oB:#5286FF; --oC:#A374F5; --oD:#1FC98D;
  --on-opt:#141310;
  --u1:#F0697F; --u2:#6A94FF; --u3:#E2A03F; --u4:#2FB89A; --u5:#A683F0; --u6:#4FB8D1;
  --on-unit:#141310;
  --shadow:0 28px 66px -30px rgba(0,0,0,.85);
  color-scheme:dark;
}
html,body{background:var(--ink)}
.ttx{
  font-family:var(--body);color:var(--txt);background:var(--ink);
  min-height:100vh;font-size:15px;line-height:1.55;-webkit-font-smoothing:antialiased;
}
.ttx *{box-sizing:border-box}
.ttx button{font:inherit;cursor:pointer;border:none;background:none;color:inherit;text-align:inherit}
.ttx :focus-visible{outline:2px solid var(--signal);outline-offset:3px;border-radius:4px}
.ttx h1,.ttx h2{font-family:var(--disp);margin:0;letter-spacing:-.03em}
.ttx h1{font-size:27px;font-weight:800;margin-bottom:10px;line-height:1.12}
.ttx h2{font-size:20px;font-weight:800}
.ttx h3{font-size:12px;font-weight:800;letter-spacing:.11em;text-transform:uppercase;color:var(--faint);
  margin:30px 0 10px;font-family:var(--body)}
.ttx p{margin:0}
.ttx textarea,.ttx input[type=text],.ttx input[type=number],.ttx input[type=password],.ttx input:not([type]){
  font:inherit;color:var(--txt);width:100%;background:var(--slab);
  border:1px solid var(--edge);border-radius:11px;padding:11px 13px}
.ttx textarea{resize:vertical;line-height:1.55}
.ttx textarea:focus,.ttx input:focus{border-color:var(--signal);outline:none}
.ttx code{font-family:var(--mono);font-size:12.5px;background:var(--ink2);padding:1px 5px;border-radius:4px}
.mono{font-family:var(--mono);font-variant-numeric:tabular-nums}
.muted{color:var(--dim)}
.good{color:var(--live)}
.centre{text-align:center}
.eyebrow{font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--faint)}
.boot{padding:70px;text-align:center;color:var(--faint)}
.hint{font-size:12.5px;color:var(--faint);margin:8px 0 0;line-height:1.55;max-width:64ch}
.lede{color:var(--dim);margin:0 0 20px;max-width:58ch}
.lede b{font-weight:700}
.keys{margin-top:26px;font-size:12px;color:var(--faint)}
.ttx kbd{font-family:var(--mono);font-size:10.5px;background:var(--slab);border:1px solid var(--edge2);
  border-radius:4px;padding:1px 5px;color:var(--dim)}

/* brand motif: a short yellow stripe tab at the left of the top bar */
.striped{position:relative}
.striped::after{content:"";position:absolute;left:0;bottom:-1px;width:104px;height:3px;pointer-events:none;
  background:repeating-linear-gradient(114deg,var(--signal) 0 13px,transparent 13px 21px)}

/* ---------- buttons ---------- */
.ttx .btn{padding:9px 17px;border-radius:10px;background:var(--signal);color:var(--signal-ink);
  font-weight:700;font-size:13.5px;width:auto;transition:transform .1s,filter .14s}
.ttx .btn:hover:not(:disabled){filter:brightness(1.06)}
.ttx .btn:active:not(:disabled){transform:translateY(1px)}
.ttx .btn:disabled{opacity:.45;cursor:default}
.ttx .btn.wide{width:100%;text-align:center;padding:15px;font-size:15.5px;border-radius:14px;margin-top:16px}
.ttx .btn.quiet{background:var(--slab);color:var(--dim);box-shadow:inset 0 0 0 1px var(--edge);font-weight:600}
.ttx .btn.quiet:hover:not(:disabled){color:var(--txt);box-shadow:inset 0 0 0 1px var(--faint);filter:none}
.ttx .btn.quiet.off{opacity:.6}
.ttx .btn.pill{padding:6px 12px;font-size:12px}
.ttx .btn.danger{background:var(--wrong);color:#fff;box-shadow:none}
.ttx .btn.warnbtn{background:var(--warn);color:var(--on-opt)}
.ttx .link{color:var(--signal-text);text-decoration:underline;text-underline-offset:3px;font-size:13.5px;
  font-weight:600;width:auto}
.ttx .link.quiet{color:var(--faint);font-size:12.5px;font-weight:500}

/* ---------- header ---------- */
.bar{display:flex;align-items:center;gap:14px;padding:11px 16px;min-height:58px;background:var(--slab);
  border-bottom:1px solid var(--edge2);position:sticky;top:0;z-index:10;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:11px;font-size:14px;min-width:0}
.wordmark{font-family:var(--disp);font-weight:800;font-size:17px;letter-spacing:-.035em}
.barright{margin-left:auto;display:flex;align-items:center;gap:8px;font-size:12px;color:var(--faint);flex-wrap:wrap}
.build{font-family:var(--mono);font-size:10px;opacity:.55}
.brandlogo{height:22px;width:auto;max-width:132px;display:block;flex:none;object-fit:contain}
.brandlogo.big{height:38px;max-width:190px}
.offline{color:var(--wrong);font-weight:700;font-size:12px}
.crumb{color:var(--faint);font-size:11.5px;white-space:nowrap;text-transform:uppercase;letter-spacing:.05em;font-weight:700}
.injno{font-family:var(--disp);font-weight:800;white-space:nowrap;font-size:16px;letter-spacing:-.03em}
.unitblock{min-width:0}
.unitname{font-family:var(--disp);font-size:15px;font-weight:800;letter-spacing:-.025em;display:block;line-height:1.15}
.seatline{display:block;font-size:10.5px;color:var(--faint)}
.ptsbadge{font-size:14px;font-weight:700;color:var(--signal-text)}

/* ---------- theme switch ---------- */
.themes{display:flex;gap:2px;padding:3px;border-radius:10px;background:var(--ink2);
  box-shadow:inset 0 0 0 1px var(--edge2);flex:none}
.themes button{padding:4px 10px;border-radius:7px;font-size:12px;font-weight:700;color:var(--dim)}
.themes button:hover{color:var(--txt)}
.themes button[aria-pressed="true"]{background:var(--signal);color:var(--signal-ink)}
.themes.compact button{padding:4px 8px;font-size:11px}

/* ---------- phase stepper ---------- */
.phases{display:flex;gap:3px;flex-wrap:wrap}
.phases button{padding:5px 12px;border-radius:20px;font-size:12px;font-weight:600;color:var(--faint);white-space:nowrap}
.phases button:hover{color:var(--txt);background:var(--rise)}
.phases button.past{color:var(--dim)}
.phases button.on{background:var(--signal);color:var(--signal-ink);font-weight:700}

/* ---------- crest + chip ---------- */
.crest{width:22px;height:22px;border-radius:7px;display:inline-grid;place-items:center;flex:none;
  font-family:var(--mono);font-size:9.5px;font-weight:700;color:var(--on-unit);vertical-align:-5px}
.chip{display:inline-flex;align-items:center;gap:7px;padding:4px 12px 4px 5px;border-radius:20px;
  background:var(--rise);font-size:12.5px;font-weight:600;box-shadow:inset 0 0 0 1px var(--edge2);
  text-transform:none;letter-spacing:0;color:var(--txt)}

/* ---------- door ---------- */
.door{display:flex;justify-content:center;padding:44px 20px 80px}
.doorinner{max-width:400px;width:100%}
.slots{display:flex;gap:9px;justify-content:center;position:relative;margin-bottom:18px;cursor:text}
.slot{width:58px;height:72px;border-radius:14px;background:var(--slab);box-shadow:inset 0 0 0 1.5px var(--edge2);
  display:grid;place-items:center;font-family:var(--mono);font-size:30px;font-weight:700}
.slot.filled{box-shadow:inset 0 0 0 2px var(--signal)}
.slot.caret{box-shadow:inset 0 0 0 2px var(--signal);animation:blinkslot 1.1s step-end infinite}
@keyframes blinkslot{50%{box-shadow:inset 0 0 0 1.5px var(--edge2)}}
.ttx .codeghost{position:absolute;inset:0;opacity:0;width:100%;height:100%;padding:0;border:none;
  background:transparent;font-size:16px;cursor:text}
.resolve{min-height:22px;font-size:13.5px;color:var(--faint);text-align:center;margin-bottom:18px}
.resolved{display:flex;align-items:center;gap:11px;padding:12px 14px;border-radius:14px;
  background:var(--slab);box-shadow:inset 0 0 0 1px var(--edge);margin-bottom:6px}
.resolved.taken{background:var(--warn-soft);box-shadow:inset 0 0 0 1px var(--warn-edge)}
.resolved small{display:block;font-size:11px;color:var(--faint);letter-spacing:.08em;text-transform:uppercase;font-weight:700}
.resolved.taken small{color:var(--warn)}
.resolved b{font-family:var(--disp);font-size:16px;font-weight:800;letter-spacing:-.025em}
.doorfoot{margin-top:28px;padding-top:18px;border-top:1px solid var(--edge2);
  display:flex;flex-direction:column;gap:12px;align-items:flex-start}
/* deliberately quiet: present for anyone who looks, invisible to anyone who doesn't */
.aidisc{font-size:9.5px;line-height:1.4;color:var(--faint);opacity:.62;letter-spacing:.02em;margin-top:14px}
.projstrip .aidisc{margin:0 0 0 auto;font-size:9px}
.repinner .aidisc{margin-top:10px}

/* ---------- forms ---------- */
.load{display:flex;justify-content:center;padding:36px 20px 90px}
.loadinner{max-width:560px;width:100%}
.loadinner.wide{max-width:680px}
.drop{border:1.5px dashed var(--edge);border-radius:14px;padding:34px;text-align:center;
  background:var(--slab);display:flex;flex-direction:column;align-items:center;gap:12px}
.or{color:var(--faint);font-size:13px}
.err{margin-top:14px;padding:11px 14px;background:var(--wrong-soft);
  box-shadow:inset 0 0 0 1px var(--wrong-edge);border-radius:10px;font-size:13.5px;color:var(--wrong)}
.ttx .load .link{margin-top:18px;display:inline-block}
.fld{display:block;margin-bottom:16px}
.fld>span{display:block;font-size:12.5px;font-weight:600;color:var(--dim);margin-bottom:6px}
.fld>span em{font-style:normal;color:var(--faint);font-weight:400;margin-left:6px}
.warn{font-size:12.5px;background:var(--warn-soft);box-shadow:inset 0 0 0 1px var(--warn-edge);
  border-radius:10px;padding:11px 14px;margin-bottom:20px;color:var(--warn)}
.warn summary{cursor:pointer;font-weight:700}
.warn ul{margin:9px 0 0;padding-left:16px;line-height:1.55}
.warnhint{color:var(--warn)}
.setgrid{display:grid;grid-template-columns:1fr 1fr;gap:15px}
.span2{grid-column:1/-1}
.seg2{display:flex;gap:4px}
.seg2 button{flex:1;padding:10px 12px;border-radius:10px;font-size:13.5px;color:var(--dim);
  background:var(--slab);box-shadow:inset 0 0 0 1px var(--edge);text-align:center;font-weight:600}
.seg2 button.on{background:var(--signal);color:var(--signal-ink);box-shadow:none;font-weight:700}
.chk{display:flex;gap:10px;align-items:flex-start;cursor:pointer;margin-bottom:12px}
.chk input{width:16px;height:16px;margin-top:3px;flex:none;accent-color:var(--signal)}
.chk b{display:block;font-size:14px;font-weight:600}
.chk em{display:block;font-style:normal;font-size:12.5px;color:var(--faint);margin-top:2px;line-height:1.45}
.codelist{list-style:none;margin:10px 0 0;padding:0;background:var(--slab);
  box-shadow:inset 0 0 0 1px var(--edge2);border-radius:14px;overflow:hidden}
.codelist li{display:flex;align-items:center;gap:10px;padding:11px 15px;border-bottom:1px solid var(--edge2);flex-wrap:wrap}
.codelist li:last-child{border-bottom:none}
.cname{flex:1;font-size:14px;font-weight:600;min-width:120px}
.cinput{width:112px;font-family:var(--mono);text-align:center;letter-spacing:.1em;text-transform:uppercase;padding:7px}
.cinput.narrow{width:78px;letter-spacing:0}
.unit{color:var(--faint);font-size:12.5px}
.bigcode{font-size:17px;font-weight:700;letter-spacing:.12em;color:var(--signal-text)}

/* ---------- run shell ---------- */
.run{display:grid;grid-template-columns:222px minmax(0,1fr);align-items:start}
.rail{position:sticky;top:58px;height:calc(100vh - 58px);display:flex;flex-direction:column;
  border-right:1px solid var(--edge2);background:var(--ink2)}
.tl{list-style:none;margin:0;padding:12px 0;overflow-y:auto;flex:1}
.tlhead{font-size:10px;font-weight:800;color:var(--faint);padding:14px 16px 6px;letter-spacing:.13em;text-transform:uppercase}
.tlrow button{width:100%;display:grid;grid-template-columns:14px 20px 1fr;align-items:center;
  gap:9px;padding:8px 16px;font-size:12.5px;color:var(--faint)}
.tlrow button:hover{background:var(--slab)}
.tldot{width:9px;height:9px;border-radius:50%;box-shadow:inset 0 0 0 1.5px var(--edge);margin-left:2px}
.tlrow.done .tldot{background:var(--faint);box-shadow:none}
.tlrow.now button{background:var(--rise);color:var(--txt);font-weight:600}
.tlrow.now .tldot{background:var(--signal);box-shadow:0 0 0 3px var(--signal-soft)}
.tlno{font-family:var(--mono);font-size:11px}
.tltext{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left}
.tlfoot{border-top:1px solid var(--edge2);padding:11px 16px;display:flex;align-items:center;gap:10px;
  font-size:11.5px;color:var(--faint)}
.tlprog{flex:1;height:3px;background:var(--edge2);border-radius:2px;overflow:hidden}
.tlprog i{display:block;height:100%;background:var(--signal);transition:width .3s}

/* ---------- stage ---------- */
.stage{padding:26px 30px 90px;max-width:900px}
.scenario{font-size:17.5px;line-height:1.62;margin:0 0 20px;padding:20px 22px;background:var(--slab);
  box-shadow:inset 0 0 0 1px var(--edge2);border-radius:18px;max-width:62ch}
.scenario .eyebrow,.condition .eyebrow{display:block;margin-bottom:9px}
.empty{color:var(--faint);font-style:italic;margin-bottom:20px}
.callon{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:18px;
  font-size:11.5px;color:var(--faint);font-weight:700;letter-spacing:.06em;text-transform:uppercase}
.actbar{display:flex;align-items:center;gap:16px;padding:14px 18px;background:var(--rise);
  box-shadow:inset 0 0 0 1px var(--edge);border-radius:16px;margin-bottom:22px;flex-wrap:wrap}
.actbar .msg{font-size:13.5px;color:var(--dim)}
.actbar .btn{margin-left:auto}
.inlinetime{display:flex;align-items:center;gap:6px}
.inlinetime input{width:74px;font-family:var(--mono);text-align:center;padding:6px}

/* ---------- ring ---------- */
.ring{position:relative;flex:none;display:grid;place-items:center}
.ring svg{transform:rotate(-90deg);display:block;overflow:visible}
.ring .rtrack{fill:none;stroke:var(--edge2);stroke-width:9}
.ring .rfill{fill:none;stroke:var(--live);stroke-width:9;stroke-linecap:round;transition:stroke .4s}
.ring .rnum{position:absolute;font-family:var(--mono);font-weight:700;font-variant-numeric:tabular-nums;
  letter-spacing:-.03em;color:var(--txt)}
.ring .rcap{position:absolute;bottom:-2px;font-size:9px;letter-spacing:.12em;text-transform:uppercase;
  color:var(--faint);font-weight:700}
.ring.warn .rfill{stroke:var(--warn)} .ring.warn .rnum{color:var(--warn)}
.ring.urgent .rfill{stroke:var(--wrong)} .ring.urgent .rnum{color:var(--wrong)}
.ring.urgent{animation:tense 1s ease-in-out infinite}
.ring.done .rnum{color:var(--wrong)}
@keyframes tense{0%,100%{transform:scale(1)}50%{transform:scale(1.04)}}
.ring.s72 svg{width:72px;height:72px} .ring.s72 .rnum{font-size:17px}
.ring.s150 svg{width:150px;height:150px} .ring.s150 .rnum{font-size:38px;margin-bottom:6px}
.ring.s150 .rtrack,.ring.s150 .rfill{stroke-width:7}
.ring.s220 svg{width:220px;height:220px} .ring.s220 .rnum{font-size:58px;margin-bottom:8px}
.ring.s220 .rtrack,.ring.s220 .rfill{stroke-width:6}
.ringwrap{display:flex;justify-content:center;margin-bottom:6px}

/* ---------- lobby ---------- */
.lobby{max-width:760px}
.lobbytop{display:flex;align-items:flex-start;gap:22px;flex-wrap:wrap;margin-bottom:20px}
.lobbytop p{max-width:56ch;font-size:13.5px;margin-top:4px}
.dial{margin-left:auto;text-align:right;flex:none}
.dial b{display:block;font-size:34px;font-weight:700;line-height:1;letter-spacing:-.04em}
.dial span{font-size:11px;color:var(--faint);letter-spacing:.1em;text-transform:uppercase;font-weight:700}
.codegrid{list-style:none;margin:0;padding:0;display:grid;
  grid-template-columns:repeat(auto-fill,minmax(212px,1fr));gap:11px}
.codegrid li{background:var(--slab);box-shadow:inset 0 0 0 1px var(--edge2);border-radius:16px;
  padding:16px 17px;display:flex;flex-direction:column;gap:10px;position:relative;overflow:hidden}
.codegrid li::before{content:"";position:absolute;inset:0 0 auto 0;height:3px;background:var(--c)}
.codegrid li.in{background:var(--rise);box-shadow:inset 0 0 0 1px var(--edge)}
.cghead{display:flex;align-items:center;gap:9px}
.cghead b{font-size:13.5px;font-weight:700;line-height:1.3}
.seatopen{margin-left:auto;font-size:9.5px;font-weight:800;letter-spacing:.11em;text-transform:uppercase;
  color:var(--warn);background:var(--warn-soft);box-shadow:inset 0 0 0 1px var(--warn-edge);
  border-radius:20px;padding:2px 7px;flex:none}
.cgcode{display:block;font-family:var(--mono);font-size:29px;font-weight:700;letter-spacing:.13em;
  color:var(--c);line-height:1}
.cgwho{display:block;font-size:11.5px;color:var(--faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.codegrid li.in .cgwho{color:var(--live)}

/* ---------- tracker ---------- */
.tracker{background:var(--slab);box-shadow:inset 0 0 0 1px var(--edge2);border-radius:16px;
  overflow:hidden;margin-bottom:22px}
.trow{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--edge2);font-size:13.5px}
.trow:last-child{border-bottom:none}
.trow.in{background:var(--live-soft)}
.tname{font-weight:600;min-width:140px}
.tbar{flex:1;height:7px;background:var(--edge2);border-radius:4px;overflow:hidden;max-width:260px}
.tbar i{display:block;height:100%;background:var(--c);border-radius:4px;transition:width .4s}
.tcount{font-size:12px;color:var(--faint)}
.tmiss{color:var(--faint);font-size:12.5px}
.tin{color:var(--live);font-size:12.5px;font-weight:600}
.tdone{font-size:12px;color:var(--live);min-width:46px;text-align:right;font-weight:700}

/* ---------- question cards ---------- */
.rolegroup{margin-bottom:26px}
.rolerule{display:flex;align-items:center;gap:9px;font-size:13px;font-weight:700;color:var(--c);
  padding-bottom:8px;border-bottom:2px solid var(--c);margin-bottom:13px}
.qcard{background:var(--slab);box-shadow:inset 0 0 0 1px var(--edge2);border-radius:18px;
  padding:17px 19px;margin-bottom:10px}
.qtext{margin:0 0 14px;font-family:var(--disp);font-size:16.5px;line-height:1.36;font-weight:800;letter-spacing:-.025em}
.qtext.small{font-size:14.5px;font-weight:700;margin-bottom:0}
.votes{list-style:none;margin:0 0 14px;padding:0;display:flex;flex-direction:column;gap:9px}
.vrow{display:grid;grid-template-columns:30px 1fr 62px;gap:12px;align-items:center}
.vglyph{width:30px;height:30px;border-radius:9px;background:var(--c);display:grid;place-items:center;
  color:var(--on-opt);flex:none}
.vtrack{position:relative;height:40px;border-radius:11px;background:var(--ink);
  box-shadow:inset 0 0 0 1px var(--edge2);overflow:hidden;display:flex;align-items:center}
.vfill{position:absolute;inset:0 auto 0 0;background:var(--c);opacity:.22;transition:width .5s}
.vlabel{position:relative;padding-inline:13px;font-size:13.5px;line-height:1.35;z-index:1}
.vrow.correct .vtrack{box-shadow:inset 0 0 0 2px var(--live)}
.vrow.correct .vlabel{color:var(--live);font-weight:600}
.vrow.correct .vn{color:var(--live)}
.vn{font-size:15px;font-weight:700;text-align:right;color:var(--dim);line-height:1.15}
.vn em{display:block;font-style:normal;font-family:var(--body);font-size:9px;font-weight:700;
  letter-spacing:.08em;text-transform:uppercase;color:var(--faint)}
.who-list{list-style:none;margin:0;padding:12px 0 0;border-top:1px solid var(--edge2);
  display:flex;flex-direction:column;gap:7px}
.who-list li{display:flex;align-items:center;gap:10px;font-size:13px}
.who-list .wname{flex:1}
.who-list li.ok .wname{color:var(--live);font-weight:600}
.who-list li.no .wname{color:var(--wrong)}
.who-list li.part .wname{color:var(--warn);font-weight:600}
.wopt{display:flex;align-items:center;gap:4px}
.rk{font-size:10.5px;color:var(--faint);width:16px;flex:none}
.who-list .ms{font-size:12px;color:var(--faint)}
.who-list .pts{font-size:12.5px;font-weight:700;min-width:56px;text-align:right}
.who-list .none{color:var(--faint);font-style:italic}
.answers{list-style:none;margin:0 0 13px;padding:0;display:flex;flex-direction:column;gap:8px}
.answers li{background:var(--ink);border-radius:12px;padding:11px 13px}
.answers .who{font-size:11px;font-weight:700;color:var(--faint);display:block;margin-bottom:4px}
.answers p{margin:0;font-size:14.5px;line-height:1.55}
.noanswer{margin:0 0 12px;color:var(--wrong);font-size:13.5px;font-style:italic}
.qfoot{display:flex;align-items:flex-end;justify-content:space-between;gap:14px;flex-wrap:wrap}
.dims{display:flex;gap:22px;flex-wrap:wrap}
.dim{display:flex;align-items:center;gap:7px}
.dimlab{font-size:11px;color:var(--faint);font-weight:700}
.scorer{display:flex;gap:3px}
.scorer button{width:28px;height:28px;border-radius:8px;font-family:var(--mono);font-size:13px;
  color:var(--dim);box-shadow:inset 0 0 0 1px var(--edge)}
.scorer button.on{background:var(--signal);color:var(--signal-ink);box-shadow:none;font-weight:700}
.scorelab{font-size:12.5px;color:var(--faint);min-width:76px}
.dseg{display:flex;gap:3px;flex-wrap:wrap}
.dseg button{padding:6px 11px;border-radius:8px;font-size:12.5px;color:var(--dim);
  box-shadow:inset 0 0 0 1px var(--edge);white-space:nowrap}
.dseg button.on{background:var(--c);color:#fff;font-weight:700;box-shadow:none}
.model{margin:13px 0 0;padding-top:13px;border-top:1px solid var(--edge2);white-space:pre-line;
  font-size:14.5px;line-height:1.6;color:var(--dim)}
.notes{margin-top:26px}
.notes label{display:block;font-size:12.5px;font-weight:600;color:var(--dim);margin-bottom:7px}
.nav{display:flex;justify-content:space-between;gap:12px;margin-top:26px;padding-top:22px;
  border-top:1px solid var(--edge2);flex-wrap:wrap}
.confirm{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.confirm .msg{font-size:13px;color:var(--dim)}

/* ---------- seats panel ---------- */
.scrim{position:fixed;inset:0;background:rgba(10,9,6,.44);z-index:30;display:flex;justify-content:flex-end}
.panel{background:var(--ink);width:min(480px,100%);height:100%;overflow-y:auto;padding:22px 24px 44px;
  border-left:1px solid var(--edge2);box-shadow:var(--shadow)}
.phead{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}

/* ---------- participant ---------- */
.pmain{display:flex;justify-content:center;padding:20px 16px 80px}
.pinner{max-width:560px;width:100%;display:flex;flex-direction:column;gap:16px}
.condition{margin:0;border-radius:16px;background:var(--slab);padding:18px;
  box-shadow:inset 0 0 0 1px var(--edge2);font-size:15.5px;line-height:1.6}
.standby{text-align:center;padding:56px 20px}
.standby.small{padding:26px 20px}
.pulse{display:inline-block;width:11px;height:11px;border-radius:50%;background:var(--live);
  margin-bottom:14px;animation:beat 2.2s ease-in-out infinite;flex:none}
@keyframes beat{0%,100%{opacity:.3}50%{opacity:1}}
.pq{display:flex;flex-direction:column;gap:13px}
.pqtext{margin:0;font-family:var(--disp);font-size:21px;line-height:1.28;font-weight:800;letter-spacing:-.03em}
.opts{display:grid;grid-template-columns:1fr 1fr;gap:11px}
.ttx .opt{position:relative;display:flex;flex-direction:column;gap:11px;padding:15px 15px 14px;
  border-radius:18px;background:var(--slab);box-shadow:inset 0 0 0 1.5px var(--edge2);text-align:left;
  transition:transform .12s,box-shadow .16s,opacity .2s,background .16s}
.ttx .opt:hover:not(:disabled){transform:translateY(-2px);box-shadow:inset 0 0 0 1.5px var(--c)}
.ttx .opt:active:not(:disabled){transform:translateY(0)}
.ttx .opt:disabled{cursor:default}
.oglyph{width:34px;height:34px;border-radius:10px;background:var(--c);display:grid;place-items:center;
  flex:none;color:var(--on-opt)}
.otxt{font-size:14.5px;font-weight:500;line-height:1.4}
.oltr{position:absolute;top:15px;right:15px;font-size:11px;font-weight:700;color:var(--faint)}
/* checkbox: a real tick box, so "several may be right" is legible before anyone taps */
.otick{position:absolute;top:14px;right:14px;width:19px;height:19px;border-radius:6px;
  display:grid;place-items:center;box-shadow:inset 0 0 0 1.5px var(--edge);color:transparent}
.otick.on{background:var(--slab);color:var(--c);box-shadow:inset 0 0 0 1.5px var(--slab)}
.ttx .opt.picked .otick{box-shadow:inset 0 0 0 1.5px var(--slab)}
.multinote{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;font-size:12.5px;
  color:var(--faint);line-height:1.5;margin:0}
.multibadge{font-size:9.5px;font-weight:800;letter-spacing:.11em;text-transform:uppercase;
  color:var(--signal-ink);background:var(--signal);border-radius:20px;padding:3px 9px;flex:none}
.typetag{font-size:9.5px;font-weight:800;letter-spacing:.11em;text-transform:uppercase;
  color:var(--dim);background:var(--ink);box-shadow:inset 0 0 0 1px var(--edge2);
  border-radius:20px;padding:3px 9px;margin-left:9px;vertical-align:3px;font-family:var(--body)}
.projtype{font-size:13px;font-weight:800;letter-spacing:.11em;text-transform:uppercase;color:var(--signal-text);margin-top:-8px}
.ttx .opt.picked{background:var(--c);box-shadow:inset 0 0 0 1.5px var(--c)}
.ttx .opt.picked .otxt{color:var(--on-opt);font-weight:600}
.ttx .opt.picked .oglyph{background:var(--slab);color:var(--c)}
.ttx .opt.picked .oltr{color:var(--on-opt);opacity:.65}
.ttx .opt.faded{opacity:.42}
.lockstamp{display:flex;align-items:center;justify-content:center;gap:10px;padding:13px;border-radius:14px;
  background:var(--wrong-soft);box-shadow:inset 0 0 0 1.5px var(--wrong-edge);
  font-family:var(--disp);font-weight:800;color:var(--wrong);font-size:14.5px}
.sentline{display:flex;align-items:center;gap:9px;font-size:13px;color:var(--live);font-weight:700;margin:0}
.sentline .tick{width:18px;height:18px;border-radius:50%;background:var(--live);display:grid;
  place-items:center;flex:none;color:var(--on-opt)}
.sentnote{text-align:center;font-size:13px;color:var(--live);font-weight:600}
.myresult{display:flex;flex-direction:column;gap:11px}
.rescard{background:var(--slab);box-shadow:inset 0 0 0 1.5px var(--edge2);border-radius:18px;
  padding:17px;display:flex;flex-direction:column;gap:11px}
.rescard.ok{background:var(--live-soft);box-shadow:inset 0 0 0 1.5px var(--live-edge)}
.rescard.no{background:var(--wrong-soft);box-shadow:inset 0 0 0 1.5px var(--wrong-edge)}
.rescard.part{background:var(--warn-soft);box-shadow:inset 0 0 0 1.5px var(--warn-edge)}
.rescard.part .badge{background:var(--warn)}
.accpill{margin-left:auto;font-size:10.5px;font-weight:800;letter-spacing:.06em;color:var(--warn);
  background:var(--warn-soft);box-shadow:inset 0 0 0 1px var(--warn-edge);border-radius:20px;padding:3px 9px}
.kglyphs{display:flex;gap:4px;flex:none;margin-top:1px}
.rescard.miss{opacity:.7}
.verdict{display:flex;align-items:center;gap:11px}
.verdict .badge{width:30px;height:30px;border-radius:10px;display:grid;place-items:center;flex:none;
  background:var(--dim);color:var(--on-opt)}
.rescard.ok .badge{background:var(--live)}
.rescard.no .badge{background:var(--wrong)}
.verdict b{font-family:var(--disp);font-size:18px;font-weight:800;letter-spacing:-.025em}
.ptsbig{font-size:40px;font-weight:700;letter-spacing:-.04em;line-height:1;color:var(--signal-text)}
.metarow{display:flex;gap:16px;flex-wrap:wrap;font-size:12.5px;color:var(--dim)}
.metarow b{color:var(--txt);font-weight:700}
.keyline{display:flex;gap:9px;align-items:flex-start;font-size:13.5px;color:var(--dim);line-height:1.5}
.keyline b{color:var(--txt);font-weight:700}
.kglyph{width:22px;height:22px;border-radius:7px;display:grid;place-items:center;flex:none;
  color:var(--on-opt);background:var(--c);margin-top:1px}
.rline{margin:0;font-size:12.5px;color:var(--faint)}
.totalline{display:flex;flex-direction:column;align-items:center;gap:3px;padding:6px 0}
.totalline b{font-size:34px;font-weight:700;color:var(--signal-text);letter-spacing:-.04em;line-height:1}
.totalline span{font-size:12px;color:var(--faint)}

/* ---------- projector ---------- */
.screen{min-height:100vh;display:flex;flex-direction:column;background:var(--ink)}
.projwait{text-align:center;padding:22vh 20px}
.projtop{display:flex;align-items:center;gap:20px;padding:22px 34px;background:var(--slab);
  border-bottom:1px solid var(--edge2)}
.projtop h1{font-size:26px;margin:2px 0 0}
.projphase{margin-left:auto;display:flex;align-items:center;gap:10px;font-size:13px;font-weight:800;
  letter-spacing:.14em;text-transform:uppercase;color:var(--live)}
.projphase .pulse{margin:0;width:12px;height:12px}
.projphase.revealed{color:var(--signal-text)}
.projbody{flex:1;display:flex;flex-direction:column;gap:24px;padding:30px 38px 24px}
.projlobby{text-align:center;padding:8vh 0}
.projlobby h2{font-size:40px}
.projmid{display:flex;gap:36px;align-items:flex-start;flex:1}
.projleft{flex:1;display:flex;flex-direction:column;gap:22px;min-width:0}
.projcond{font-size:19px;line-height:1.55;color:var(--dim);max-width:62ch;
  border-left:3px solid var(--signal);padding-left:16px}
.projq{display:flex;flex-direction:column;gap:16px}
.projqtext{font-family:var(--disp);font-size:32px;font-weight:800;line-height:1.16;
  letter-spacing:-.035em;max-width:28ch}
.projopts{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.projopt{display:flex;align-items:center;gap:13px;padding:14px 16px;border-radius:14px;
  background:var(--slab);box-shadow:inset 0 0 0 1.5px var(--edge2);font-size:17px}
.projopt.key{box-shadow:inset 0 0 0 2.5px var(--live)}
.projopt .oglyph{width:32px;height:32px}
.projopt .otxt{font-size:17px}
.projopt .on{margin-left:auto;font-size:19px;font-weight:700;color:var(--dim)}
.projopt.key .on{color:var(--live)}
.projstrip{display:flex;gap:9px;flex-wrap:wrap;align-items:center;border-top:1px solid var(--edge2);
  padding-top:18px;margin-top:auto}
.projstrip .lab{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);font-weight:800}
.projtop .brandlogo{margin-right:4px}
.jcode{display:inline-flex;align-items:center;gap:8px;padding:6px 12px 6px 6px;border-radius:11px;
  background:var(--slab);box-shadow:inset 0 0 0 1px var(--edge2)}
.jcode b{font-size:16px;font-weight:700;letter-spacing:.1em}
.jcode.in{background:var(--live-soft);box-shadow:inset 0 0 0 1px var(--live-edge);color:var(--live)}

/* ---------- report ---------- */
.report{display:flex;justify-content:center;padding:30px 22px 96px}
.repinner{max-width:820px;width:100%}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:11px;margin:18px 0 6px}
.kpis>div{background:var(--slab);box-shadow:inset 0 0 0 1px var(--edge2);border-radius:14px;padding:15px 17px}
.kpis b{display:block;font-size:26px;font-weight:700;letter-spacing:-.035em;line-height:1.1}
.kpis span{font-size:10.5px;color:var(--faint);display:block;margin-top:6px;letter-spacing:.09em;
  text-transform:uppercase;font-weight:700}
.kpisub{display:block;font-style:normal;font-size:11px;color:var(--faint);margin-top:5px;opacity:.8}
.boardnote{margin:0 0 10px;max-width:74ch}
.board{list-style:none;margin:0;padding:0;background:var(--slab);box-shadow:inset 0 0 0 1px var(--edge2);
  border-radius:14px;overflow:hidden}
.board li{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--edge2);font-size:14px}
.board li:last-child{border-bottom:none}
.board li.first{background:var(--rise)}
.rank{font-size:12px;color:var(--faint);width:24px}
.bname{flex:1;font-weight:600;min-width:100px}
.bbar{flex:1;height:7px;background:var(--edge2);border-radius:4px;overflow:hidden;max-width:200px}
.bbar i{display:block;height:100%;border-radius:4px;transition:width .4s}
.bscore{min-width:104px;text-align:right;flex:none}
.bscore b{display:block;font-weight:700;font-size:16px;letter-spacing:-.02em}
.bscore em{display:block;font-style:normal;font-size:10.5px;color:var(--faint);margin-top:1px}
.tbl .dimcell{color:var(--faint)}
.tbl .strong{font-weight:700}
.tblwrap{overflow-x:auto;background:var(--slab);box-shadow:inset 0 0 0 1px var(--edge2);border-radius:14px}
.tbl{width:100%;border-collapse:collapse;font-size:14px}
.tbl th{text-align:left;font-size:10.5px;font-weight:800;letter-spacing:.11em;text-transform:uppercase;
  color:var(--faint);padding:13px 15px 9px}
.tbl td{padding:11px 15px;border-top:1px solid var(--edge2)}
.repactions{display:flex;gap:12px;margin-top:30px;flex-wrap:wrap}
.crash{max-width:500px;margin:70px auto;padding:0 24px;text-align:center}
.crash pre{text-align:left;background:var(--slab);box-shadow:inset 0 0 0 1px var(--edge2);border-radius:10px;
  padding:13px;font-size:12px;overflow:auto;margin:18px 0;color:var(--wrong)}

@media (max-width:900px){
  .run{grid-template-columns:1fr}
  .rail{position:static;height:auto;border-right:none;border-bottom:1px solid var(--edge2)}
  .tl{display:flex;overflow-x:auto;padding:10px;gap:7px}
  .tlhead{display:none}
  .tlrow button{grid-template-columns:auto auto;border-radius:9px;padding:8px 12px;background:var(--slab);
    box-shadow:inset 0 0 0 1px var(--edge2);width:auto}
  .tltext{display:none}
  .stage{padding:22px 16px 80px}
  .setgrid{grid-template-columns:1fr}
  .actbar .btn{width:100%;margin-left:0}
  .projmid{flex-direction:column}
  .projopts{grid-template-columns:1fr}
  .projqtext{font-size:24px}
  .projtop,.projbody{padding-inline:18px}
}
@media (max-width:420px){
  .brandlogo{height:18px;max-width:96px}
  .opts{grid-template-columns:1fr}
  .slot{width:52px;height:66px;font-size:26px}
}
@media (prefers-reduced-motion:reduce){.ttx *{animation:none!important;transition:none!important}}
`;
