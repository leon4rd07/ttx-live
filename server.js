/* ------------------------------------------------------------------ *
 * TTX server
 *
 * One exercise, many join codes. Each business unit gets its own code,
 * so entering JEXN puts you in Risk Management without picking from a
 * dropdown you could get wrong.
 *
 * Timing and scoring are computed here, not on the client. The clock
 * starts when the facilitator opens the inject, so a slow phone doesn't
 * change anyone's score.
 * ------------------------------------------------------------------ */

import express from "express";
import { WebSocketServer } from "ws";
import { createServer } from "http";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const SNAPSHOT = process.env.SNAPSHOT_PATH || join(__dirname, "rooms.json");
const ROOM_TTL_MS = 12 * 60 * 60 * 1000;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I, O, 0, 1

/* Optional facilitator passcode. Unset means anyone reaching /host can run an
   exercise — fine for a dry run, not for one with real content. */
const HOST_KEY = (process.env.HOST_KEY || "").trim();

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

app.use(express.static(join(__dirname, "dist")));
app.get("/healthz", (_, res) => res.send("ok"));

/* ------------------------------ state ------------------------------ */

const rooms = new Map();      // roomId -> room
const codeIndex = new Map();  // JOIN CODE -> { roomId, peran }
const hostCodeIndex = new Map(); // CO-HOST CODE -> roomId
const sockets = new Map();    // ws -> { roomId, pid, isHost, role }

const DEFAULTS = {
  mode: "auto",       // auto = multiple choice, scored. manual = facilitator scores
  timeLimit: 60,      // seconds to answer, 0 for none
  essayLimit: 300,    // seconds for essay questions, 0 for none, "" to follow timeLimit
  points: 1000,
  speedBonus: true,
  autoReveal: true,
  showNames: true,
  showUnits: true,
  leaderboard: true,
};

/* Answer time for an inject: its own override, else the global default. */
const limitFor = (room, injId) => {
  const v = room.times?.[injId];
  return v === "" || v == null ? room.settings.timeLimit : Number(v);
};

/* An essay takes longer to write than a tile takes to tap, so essays carry a
   window of their own: the inject's essay override, else the global essay
   default, else the ordinary window. */
const essayLimitFor = (room, injId) => {
  const v = room.etimes?.[injId];
  if (v !== "" && v != null) return Number(v);
  const g = room.settings?.essayLimit;
  return g === "" || g == null ? limitFor(room, injId) : Number(g);
};
const limitForQ = (room, injId, q) =>
  (q?.type === "open" ? essayLimitFor(room, injId) : limitFor(room, injId));

/* The inject is done when its slowest question is done. Zero anywhere means
   somebody has no limit at all, so nothing closes on its own. */
function longestLimit(room, inj) {
  const a = limitFor(room, inj?.id);
  if (!(inj?.questions || []).some((q) => q.type === "open")) return a;
  const b = essayLimitFor(room, inj?.id);
  if (!a || !b) return 0;
  return Math.max(a, b);
}

/* Who may do what. The facilitator who opened the room owns it and hands out
   co-host codes, each carrying the role that code grants. */
const ROLE_RANK = { owner: 3, full: 2, grader: 1, viewer: 0 };
const ROLES = Object.keys(ROLE_RANK);
const rankOf = (ws) => {
  const st = sockets.get(ws);
  return st?.isHost ? (ROLE_RANK[st.role] ?? 0) : -1;
};
const canDrive = (ws) => rankOf(ws) >= 2;   // fase, reveal, kunci, pengaturan, kursi
const canGrade = (ws) => rankOf(ws) >= 1;   // menilai esai
const isOwner = (ws) => rankOf(ws) >= 3;

/* Which facilitators are connected right now, for the owner's panel. */
const hostsOf = (room) => {
  const out = [];
  for (const st of sockets.values()) {
    if (st.roomId !== room.id || !st.isHost) continue;
    out.push({ role: st.role, name: st.hostName || "", code: st.hostCode || "" });
  }
  return out;
};
const pushHosts = (room) => toRoom(room.id, { t: "hosts", hosts: hostsOf(room) }, true);

function restore() {
  if (!existsSync(SNAPSHOT)) return;
  try {
    const saved = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
    const now = Date.now();
    for (const r of saved) {
      if (now - r.touched > ROOM_TTL_MS) continue;
      rooms.set(r.id, r);
      for (const [code, peran] of Object.entries(r.codes || {})) {
        codeIndex.set(code, { roomId: r.id, peran });
      }
      for (const code of Object.keys(r.hostCodes || {})) hostCodeIndex.set(code, r.id);
    }
    console.log(`restored ${rooms.size} room(s)`);
  } catch (e) {
    console.warn("restore failed:", e.message);
  }
}

let snapPending = false;
const markSnapshot = () => { snapPending = true; };
function snapshot() {
  try { writeFileSync(SNAPSHOT, JSON.stringify([...rooms.values()])); }
  catch (e) { console.warn("snapshot failed:", e.message); }
}

function dropRoom(room) {
  for (const code of Object.keys(room.codes || {})) codeIndex.delete(code);
  for (const code of Object.keys(room.hostCodes || {})) hostCodeIndex.delete(code);
  rooms.delete(room.id);
}

function sweep() {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    if (now - room.touched > ROOM_TTL_MS) dropRoom(room);
  }
}

function newCode() {
  let c;
  do { c = Array.from({ length: 4 }, () => ALPHABET[Math.floor(Math.random() * 32)]).join(""); }
  while (codeIndex.has(c) || hostCodeIndex.has(c));
  return c;
}

const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };

const revealTimers = new Map(); // roomId -> timeout
function clearReveal(roomId) {
  const t = revealTimers.get(roomId);
  if (t) { clearTimeout(t); revealTimers.delete(roomId); }
}
function armReveal(room) {
  clearReveal(room.id);
  const inj = room.deck.injects[room.state.activeIdx];
  const limit = longestLimit(room, inj);
  if (!room.settings.autoReveal || !limit) return;
  const fireIn = limit * 1000 + 1200; // small grace for in-flight answers
  revealTimers.set(room.id, setTimeout(() => {
    const r = rooms.get(room.id);
    if (!r || r.state.phase !== "open") return;
    r.state = { ...r.state, phase: "revealed", keyShown: false };
    toRoom(r.id, { t: "state", ...r.state });
    toRoom(r.id, { t: "roster", people: roster(r) }, true);
    markSnapshot();
  }, fireIn));
}

/* staffOnly covers the facilitator and the projector view: both need the roster,
   participants must never see it. */
function toRoom(roomId, msg, staffOnly = false) {
  const raw = JSON.stringify(msg);
  for (const [ws, s] of sockets) {
    if (s.roomId !== roomId) continue;
    if (staffOnly && !s.isHost && !s.isScreen) continue;
    if (ws.readyState === 1) ws.send(raw);
  }
}

/* A unit's seat is held while some socket is bound to its pid. */
const seatHolder = (room, peran) => Object.values(room.people).find((p) => p.peran === peran);
const pidLive = (pid) => { for (const s of sockets.values()) if (s.pid === pid) return true; return false; };

/* Roster as the facilitator and projector see it: one entry per unit, with
   whether that unit's device is actually connected right now. */
const roster = (room) => Object.values(room.people).map((p) => ({ ...p, live: pidLive(p.pid) }));

/* Coalesce roster pushes: a burst of answers becomes one update. */
const dirty = new Set();
setInterval(() => {
  for (const id of dirty) {
    const room = rooms.get(id);
    if (room) toRoom(id, { t: "roster", people: roster(room) }, true);
  }
  dirty.clear();
}, 1200);
const markDirty = (id) => dirty.add(id);

/* Participants get only their own unit's questions — no peeking. */
function deckFor(room, peran) {
  return {
    roles: room.deck.roles,
    injects: room.deck.injects.map((i) => ({
      id: i.id, siklus: i.siklus, condition: i.condition, window: i.window,
      limit: limitFor(room, i.id), elimit: essayLimitFor(room, i.id),
      questions: i.questions
        .filter((q) => q.peran === peran)
        .map((q) => ({
          qid: q.qid, peran: q.peran, text: q.text, type: q.type, weighted: !!q.weighted,
          // never send which option is correct, nor what any option is worth
          choices: (q.choices || []).map((c) => ({ text: c.text })),
        })),
    })),
  };
}

/* The projector gets every unit's questions but never the correct flags —
   the key reaches it through sendKey, at the same moment as the phones. */
function screenDeck(room) {
  return {
    roles: room.deck.roles,
    injects: room.deck.injects.map((i) => ({
      id: i.id, siklus: i.siklus, condition: i.condition, roles: i.roles,
      limit: limitFor(room, i.id), elimit: essayLimitFor(room, i.id),
      questions: i.questions.map((q) => ({
        qid: q.qid, peran: q.peran, text: q.text, type: q.type, weighted: !!q.weighted,
        choices: (q.choices || []).map((c) => ({ text: c.text })),
      })),
    })),
  };
}

/* Participants only learn the key once answering has closed. */
function sendKey(room) {
  const inj = room.deck.injects[room.state.activeIdx];
  if (!inj) return;
  const key = {};
  inj.questions.forEach((q) => {
    const idx = (q.choices || []).map((c, i) => (c.correct ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) return;
    /* `i`/`text` stay for single choice; `is`/`texts` carry every key for checkbox */
    key[q.qid] = { i: idx[0], text: q.choices[idx[0]].text,
      is: idx, texts: idx.map((i) => q.choices[i].text) };
  });
  toRoom(room.id, { t: "key", injectId: inj.id, key });
}

/* Accuracy first, then speed. A fully correct answer earns half the points
   outright and up to half again for answering early; a partly correct checkbox
   scales the whole thing by how much of the key it got.

   Checkbox is scored (hits − misses) / keys, floored at zero: ticking every box
   earns nothing, so "select all to be safe" is not a strategy. */
function scoreAnswer(room, q, val, elapsedMs, limit) {
  const s = room.settings;
  const isChoice = q.type === "choice", isCheck = q.type === "checkbox";
  if (s.mode !== "auto" || (!isChoice && !isCheck)) return { correct: null, points: 0, acc: null };

  const keys = (q.choices || []).map((c, i) => (c.correct ? i : -1)).filter((i) => i >= 0);
  if (!keys.length) return { correct: null, points: 0, acc: null };  // no key marked in the sheet

  let acc, correct;
  if (isCheck) {
    const picked = Array.isArray(val) ? val : [];
    const hit = picked.filter((i) => keys.includes(i)).length;
    const miss = picked.length - hit;
    acc = Math.max(0, (hit - miss) / keys.length);
    correct = hit === keys.length && miss === 0;
  } else if (q.weighted) {
    /* Tiered single choice: the option's own normalised weight is the accuracy,
       so a workable-but-slower answer scores something and only the top tier
       scores in full. */
    acc = Math.max(0, Math.min(1, Number((q.choices || [])[val]?.w) || 0));
    correct = acc >= 1;
  } else {
    correct = val === keys[0];
    acc = correct ? 1 : 0;
  }
  if (acc <= 0) return { correct: false, points: 0, acc: 0 };

  const speed = s.speedBonus && limit ? Math.max(0, 1 - elapsedMs / (limit * 1000)) : null;
  const mult = speed == null ? 1 : 0.5 + 0.5 * speed;
  return { correct, partial: !correct, acc: Math.round(acc * 1000) / 1000,
    points: Math.round(s.points * acc * mult) };
}

/* Which inject a question belongs to — needed to find its answering window
   when an essay is graded, long after the answer arrived. */
function injectOfQid(room, qid) {
  for (const inj of room.deck.injects) {
    if (inj.questions.some((q) => q.qid === qid)) return inj;
  }
  return null;
}

/* An essay is scored the same shape as everything else: the facilitator's 1-10
   judgement plays the part accuracy plays for a multiple choice, and speed still
   earns up to half. Grade 7 answered instantly beats grade 7 answered at the
   buzzer, and a grade of 1 is worth something while 0 is not offered. */
function gradeToPoints(room, a, limit, quality) {
  const s = room.settings;
  const acc = Math.max(0, Math.min(10, Number(quality) || 0)) / 10;
  if (!acc) return 0;
  const speed = s.speedBonus && limit ? Math.max(0, 1 - (a.ms || 0) / (limit * 1000)) : null;
  const mult = speed == null ? 1 : 0.5 + 0.5 * speed;
  return Math.round((Number(s.points) || 0) * acc * mult);
}

/* Points per question or the speed-bonus switch moved: every grade already given
   has to be recomputed, or the graded essays keep their old arithmetic. */
function regradeAll(room) {
  for (const p of Object.values(room.people)) {
    for (const [qid, a] of Object.entries(p.answers)) {
      if (a.quality == null) continue;
      const inj = injectOfQid(room, qid);
      a.points = gradeToPoints(room, a, essayLimitFor(room, inj?.id), a.quality);
    }
    retally(room, p);
  }
}

/* Units are not asked the same number of questions — one may get ten across the
   exercise and another three — so raw points cannot be compared. Every unit also
   carries what it could possibly have scored, and the percentage of it earned.
   Questions with no key marked in the sheet are left out of the denominator, so a
   spreadsheet mistake never counts against a unit. */
function possibleFor(room, peran) {
  if (room.settings.mode !== "auto") return 0;
  let n = 0;
  for (const inj of room.deck.injects) {
    for (const q of inj.questions) {
      if (q.peran !== peran) continue;
      if (q.type === "open") { n += 1; continue; }        // graded 1-10 after the discussion
      if (q.type !== "choice" && q.type !== "checkbox") continue;
      if (!(q.choices || []).some((c) => c.correct)) continue;  // no key: costs nobody
      n += 1;
    }
  }
  return n * (Number(room.settings.points) || 0);
}
function retally(room, p) {
  p.total = Object.values(p.answers).reduce((a, b) => a + (b.points || 0), 0);
  p.possible = possibleFor(room, p.peran);
  p.pct = p.possible ? Math.round((p.total / p.possible) * 1000) / 10 : null;
  return p;
}

/* --------------------------- connections --------------------------- */

wss.on("connection", (ws) => {
  sockets.set(ws, {});
  send(ws, { t: "hello", keyRequired: !!HOST_KEY });
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }

    const byId = m.roomId ? rooms.get(m.roomId) : null;
    if (byId) byId.touched = Date.now();

    switch (m.t) {
      /* ---- facilitator opens an exercise ---- */
      case "host": {
        if (HOST_KEY && String(m.key || "") !== HOST_KEY) return send(ws, { t: "denied" });
        const id = newCode() + newCode();
        const settings = { ...DEFAULTS, ...(m.settings || {}) };
        const codes = {};
        for (const [peran, wanted] of Object.entries(m.codes || {})) {
          let c = String(wanted || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
          if (!c || codeIndex.has(c) || codes[c]) c = newCode();
          codes[c] = peran;
        }
        for (const peran of m.deck.roles) {
          if (!Object.values(codes).includes(peran)) codes[newCode()] = peran;
        }
        const room = { id, deck: m.deck, settings, codes, people: {},
          times: m.times || {}, etimes: m.etimes || {},
          hostCodes: {}, ownerKey: newCode() + newCode(),
          state: { activeIdx: 0, phase: "lobby", openedAt: null, limit: null, elimit: null },
          touched: Date.now() };
        rooms.set(id, room);
        for (const [c, p] of Object.entries(codes)) codeIndex.set(c, { roomId: id, peran: p });
        sockets.set(ws, { roomId: id, isHost: true, role: "owner", hostName: (m.hostName || "").trim() });
        send(ws, { t: "hosted", roomId: id, codes, settings, times: room.times,
          etimes: room.etimes, state: room.state, role: "owner",
          ownerKey: room.ownerKey, hostCodes: room.hostCodes });
        pushHosts(room);
        markSnapshot();
        break;
      }

      /* ---- facilitator returns after a refresh ---- */
      case "rehost": {
        if (!byId) return send(ws, { t: "gone" });
        /* Rooms opened before co-hosts existed carry no ownerKey; those still
           let their facilitator back in. Newer rooms want the key. */
        if (byId.ownerKey && String(m.ownerKey || "") !== byId.ownerKey) return send(ws, { t: "denied" });
        sockets.set(ws, { roomId: byId.id, isHost: true, role: "owner", hostName: (m.hostName || "").trim() });
        send(ws, { t: "hosted", roomId: byId.id, codes: byId.codes,
          settings: byId.settings, times: byId.times || {}, etimes: byId.etimes || {},
          state: byId.state, role: "owner", ownerKey: byId.ownerKey,
          hostCodes: byId.hostCodes || {} });
        send(ws, { t: "roster", people: roster(byId) });
        pushHosts(byId);
        break;
      }

      /* ---- the owner mints a code for another facilitator ---- */
      case "cohost_add": {
        if (!byId || !isOwner(ws)) return;
        const role = ROLES.includes(m.role) && m.role !== "owner" ? m.role : "viewer";
        const code = newCode();
        byId.hostCodes = byId.hostCodes || {};
        byId.hostCodes[code] = { role, label: String(m.label || "").trim().slice(0, 40), addedAt: Date.now() };
        hostCodeIndex.set(code, byId.id);
        toRoom(byId.id, { t: "hostcodes", hostCodes: byId.hostCodes }, true);
        markSnapshot();
        break;
      }

      /* ---- the owner withdraws a code, and whoever came in on it ---- */
      case "cohost_remove": {
        if (!byId || !isOwner(ws)) return;
        const code = String(m.code || "").toUpperCase();
        if (!byId.hostCodes?.[code]) return;
        delete byId.hostCodes[code];
        hostCodeIndex.delete(code);
        for (const [sock, st] of sockets) {
          if (st.roomId === byId.id && st.hostCode === code) {
            send(sock, { t: "hostgone" });
            sockets.set(sock, {});
          }
        }
        toRoom(byId.id, { t: "hostcodes", hostCodes: byId.hostCodes }, true);
        pushHosts(byId);
        markSnapshot();
        break;
      }

      /* ---- another facilitator joins with a co-host code ---- */
      case "cohost": {
        const code = String(m.code || "").toUpperCase();
        const roomId = hostCodeIndex.get(code);
        const room = roomId && rooms.get(roomId);
        const entry = room?.hostCodes?.[code];
        if (!room || !entry) return send(ws, { t: "nosuchhost" });
        room.touched = Date.now();
        sockets.set(ws, { roomId: room.id, isHost: true, role: entry.role,
          hostCode: code, hostName: (m.name || entry.label || "").trim() });
        send(ws, { t: "cohosted", roomId: room.id, role: entry.role,
          deck: room.deck, codes: room.codes, settings: room.settings,
          times: room.times || {}, etimes: room.etimes || {}, state: room.state });
        send(ws, { t: "roster", people: roster(room) });
        if (room.state.keyShown) sendKey(room);
        pushHosts(room);
        break;
      }

      case "settings": {
        if (!byId || !canDrive(ws)) return;
        if (m.settings) byId.settings = { ...byId.settings, ...m.settings };
        if (m.times) byId.times = { ...byId.times, ...m.times };
        if (m.etimes) byId.etimes = { ...byId.etimes, ...m.etimes };
        /* points-per-question or the mode may have moved — ceilings shift and every
           grade already given has to be recomputed against the new numbers, then
           pushed, or the host and the phones keep showing the old arithmetic */
        regradeAll(byId);
        toRoom(byId.id, { t: "roster", people: roster(byId) }, true);
        for (const [sk, st] of sockets) {
          if (st.roomId !== byId.id || !st.pid) continue;
          const pp = byId.people[st.pid];
          if (pp) send(sk, { t: "ack", me: pp });
        }
        toRoom(byId.id, { t: "settings", settings: byId.settings, times: byId.times,
          etimes: byId.etimes || {} });
        /* The window for the inject on screen may have just moved. Push the new
           limit to every device and re-arm the auto-reveal against it, otherwise
           the phones keep counting to the old number. */
        const cur = byId.deck.injects[byId.state.activeIdx];
        if (cur) {
          byId.state = { ...byId.state, limit: limitFor(byId, cur.id),
            elimit: essayLimitFor(byId, cur.id) };
          toRoom(byId.id, { t: "state", ...byId.state });
          if (byId.state.phase === "open") armReveal(byId);
        }
        markSnapshot();
        break;
      }

      /* ---- clock offset ----
         Every countdown is (now - openedAt), and openedAt is server time. A client
         whose own clock is off by ten seconds therefore drew a countdown ten seconds
         off — which is exactly the host-versus-phone gap. The client measures the
         offset against these replies and counts in server time instead. */
      case "time": {
        send(ws, { t: "time", c: m.c, s: Date.now() });
        break;
      }

      /* ---- a code tells us the room, the unit, and whether its seat is free ---- */
      case "peek": {
        const hit = codeIndex.get(String(m.code || "").toUpperCase());
        const room = hit && rooms.get(hit.roomId);
        if (!room) return send(ws, { t: "nosuch" });
        const held = seatHolder(room, hit.peran);
        send(ws, { t: "codeok", peran: hit.peran,
          taken: !!held,
          holder: held ? held.name : "",
          sinceMs: held ? Date.now() - (held.claimedAt || 0) : 0,
          live: held ? pidLive(held.pid) : false });
        break;
      }

      /* ---- one seat per business unit ----
         The code is a seat, not a password. The first device to use it holds
         the unit; a second device is refused rather than quietly added, and
         can take the seat over — which is how a unit that refreshed, dropped
         its socket or swapped device gets back in with its answers intact. */
      case "join": {
        const code = String(m.code || "").toUpperCase();
        const hit = codeIndex.get(code);
        const room = hit && rooms.get(hit.roomId);
        if (!room) return send(ws, { t: "nosuch" });
        room.touched = Date.now();

        const held = seatHolder(room, hit.peran);
        if (held && !m.takeover) {
          return send(ws, { t: "seattaken", peran: hit.peran, name: held.name,
            sinceMs: Date.now() - (held.claimedAt || 0), live: pidLive(held.pid) });
        }

        let pid;
        if (held) {
          pid = held.pid;                       // same seat, same answers, same points
          for (const [sock, s] of sockets) {
            if (s.pid === pid && sock !== ws) { send(sock, { t: "evicted" }); sockets.set(sock, {}); }
          }
          held.name = (m.name || "").trim() || held.name;
          held.claimedAt = Date.now();
        } else {
          pid = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
          room.people[pid] = { pid, code, peran: hit.peran,
            name: (m.name || "").trim() || hit.peran,
            answers: {}, total: 0, claimedAt: Date.now() };
        }
        retally(room, room.people[pid]);

        sockets.set(ws, { roomId: room.id, pid });
        send(ws, { t: "joined", pid, roomId: room.id, peran: hit.peran,
          deck: deckFor(room, hit.peran), state: room.state,
          settings: room.settings, times: room.times || {}, etimes: room.etimes || {},
          me: room.people[pid] });
        if (room.state.keyShown) sendKey(room); // joined after the key went out
        markDirty(room.id);
        markSnapshot();
        break;
      }

      case "rejoin": {
        const room = byId;
        const me = room?.people[m.pid];
        if (!room || !me) return send(ws, { t: "gone" });
        /* Someone took this seat over while we were away. Don't let the old
           device silently reappear alongside the new one. */
        if (m.seat && me.claimedAt && Number(m.seat) !== me.claimedAt) return send(ws, { t: "evicted" });
        sockets.set(ws, { roomId: room.id, pid: m.pid });
        send(ws, { t: "joined", pid: m.pid, roomId: room.id, peran: me.peran,
          deck: deckFor(room, me.peran), state: room.state,
          settings: room.settings, times: room.times || {}, etimes: room.etimes || {}, me });
        if (room.state.keyShown) sendKey(room);
        markDirty(room.id);
        break;
      }

      /* ---- the projector view attaches read-only ---- */
      case "watch": {
        if (!byId) return send(ws, { t: "gone" });
        sockets.set(ws, { roomId: byId.id, isScreen: true });
        send(ws, { t: "screened", roomId: byId.id, deck: screenDeck(byId),
          settings: byId.settings, times: byId.times || {}, etimes: byId.etimes || {},
          state: byId.state, codes: byId.codes });
        send(ws, { t: "roster", people: roster(byId) });
        if (byId.state.keyShown) sendKey(byId);
        break;
      }

      /* ---- facilitator grades one essay answer, 1-10 ---- */
      case "grade": {
        if (!byId || !canGrade(ws)) return;
        const p = byId.people[m.pid];
        const a = p?.answers[m.qid];
        if (!a) return;
        if (m.quality == null) { a.quality = null; a.points = 0; }
        else {
          a.quality = Math.max(1, Math.min(10, Math.round(Number(m.quality)) || 1));
          const inj = injectOfQid(byId, m.qid);
          a.points = gradeToPoints(byId, a, essayLimitFor(byId, inj?.id), a.quality);
        }
        a.correct = null;   // an essay is never right or wrong, only better or worse
        retally(byId, p);
        toRoom(byId.id, { t: "roster", people: roster(byId) }, true);
        /* the unit sees its own number as soon as the key is released */
        for (const [sock, st] of sockets) if (st.pid === p.pid) send(sock, { t: "ack", me: p });
        markSnapshot();
        break;
      }

      /* ---- facilitator frees a unit's seat ---- */
      case "release": {
        if (!byId || !canDrive(ws)) return;
        const held = seatHolder(byId, m.peran);
        if (!held) return;
        for (const [sock, s] of sockets) {
          if (s.pid === held.pid) { send(sock, { t: "evicted" }); sockets.set(sock, {}); }
        }
        delete byId.people[held.pid];
        toRoom(byId.id, { t: "roster", people: roster(byId) }, true);
        markSnapshot();
        break;
      }

      /* ---- phase changes; the answer clock starts here ---- */
      case "state": {
        if (!byId || !canDrive(ws)) return;
        const openedAt = m.phase === "open" ? Date.now() : byId.state.openedAt;
        const inj0 = byId.deck.injects[m.activeIdx];
        byId.state = { activeIdx: m.activeIdx, phase: m.phase, openedAt,
          keyShown: false,
          limit: inj0 ? limitFor(byId, inj0.id) : byId.settings.timeLimit,
          elimit: inj0 ? essayLimitFor(byId, inj0.id) : byId.settings.essayLimit };
        toRoom(byId.id, { t: "state", ...byId.state });
        if (m.phase === "open") armReveal(byId); else clearReveal(byId.id);
        markDirty(byId.id);
        markSnapshot();
        break;
      }

      case "answer": {
        const room = byId;
        if (!room) return;
        const p = room.people[m.pid];
        if (!p) return;
        if (room.state.phase !== "open") return send(ws, { t: "locked" });

        const inj = room.deck.injects[room.state.activeIdx];
        const elapsed = room.state.openedAt ? Date.now() - room.state.openedAt : 0;
        /* Each question closes on its own clock, so an essay can still be
           arriving after the tiles have locked. */
        let applied = 0, expired = 0;
        for (const [qid, val] of Object.entries(m.answers || {})) {
          const q = inj?.questions.find((x) => x.qid === qid);
          if (!q || q.peran !== p.peran) continue;
          const limit = limitForQ(room, inj?.id, q);
          if (limit && elapsed > limit * 1000 + 800) { expired += 1; continue; }
          applied += 1;
          if (q.type === "checkbox" && room.settings.mode === "auto") {
            const n = (q.choices || []).length;
            const picks = [...new Set((Array.isArray(val) ? val : [val]).map(Number))]
              .filter((i) => Number.isInteger(i) && i >= 0 && i < n).sort((a, b) => a - b);
            const sc = scoreAnswer(room, q, picks, elapsed, limit);
            const prev = p.answers[qid];
            p.answers[qid] = { picks, choice: picks[0] ?? null,
              text: picks.map((i) => q.choices[i]?.text).filter(Boolean).join("; "),
              ms: elapsed, changed: (prev?.changed || 0) + (prev ? 1 : 0), ...sc };
          } else if (q.type === "choice" && room.settings.mode === "auto") {
            const idx = Number(val);
            const sc = scoreAnswer(room, q, idx, elapsed, limit);
            const prev = p.answers[qid];
            p.answers[qid] = { choice: idx, text: q.choices[idx]?.text || "",
              ms: elapsed, changed: (prev?.changed || 0) + (prev ? 1 : 0), ...sc };
          } else {
            const text = String(val).trim();
            if (!text) continue;
            p.answers[qid] = { text, ms: elapsed, correct: null, points: 0, locked: false };
          }
        }
        if (!applied) return send(ws, expired ? { t: "timeup" } : { t: "ack", me: p });
        for (const qid of Object.keys(m.answers || {})) {
          if (!p.answers[qid]) continue;
          const earlier = Object.values(room.people)
            .filter((o) => o.pid !== p.pid && o.answers[qid] && o.answers[qid].ms < p.answers[qid].ms).length;
          p.answers[qid].rank = earlier + 1;
        }
        retally(room, p);
        send(ws, { t: "ack", me: p });
        markDirty(room.id);
        markSnapshot();
        break;
      }

      case "showkey": {
        if (!byId || !canDrive(ws)) return;
        byId.state = { ...byId.state, keyShown: true };
        toRoom(byId.id, { t: "state", ...byId.state });
        sendKey(byId);
        markSnapshot();
        break;
      }

      case "leave": {
        const room = byId;
        if (!room) return send(ws, { t: "left" });
        delete room.people[m.pid];
        sockets.set(ws, {});
        send(ws, { t: "left" });
        markDirty(room.id);
        markSnapshot();
        break;
      }

      case "end": {
        if (!byId || !canDrive(ws)) return;
        toRoom(byId.id, { t: "ended" });
        clearReveal(byId.id);
        dropRoom(byId);
        snapshot();
        break;
      }
    }
  });

  ws.on("close", () => {
    const st = sockets.get(ws);
    sockets.delete(ws);
    if (st?.isHost && st.roomId) {
      const room = rooms.get(st.roomId);
      if (room) pushHosts(room);
    }
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); sockets.delete(ws); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

setInterval(() => { if (snapPending) { snapshot(); snapPending = false; } }, 8000);
setInterval(() => { sweep(); snapshot(); }, 60000);

app.get("*", (_, res) => res.sendFile(join(__dirname, "dist", "index.html")));

restore();
server.listen(PORT, () => console.log(`TTX server on :${PORT}`));
