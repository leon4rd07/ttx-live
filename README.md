# TTX Live

A facilitator-led tabletop exercise tool. Each unit answers privately on their
own device; the facilitator then reveals every answer at once so the room works
through them together.

One Node process serves the app and handles the live connections. No database.

---

## Run it locally

```bash
npm install
npm run build
npm start
```

Open http://localhost:3000

For UI work, `npm run dev` gives hot reload on port 5173 with the socket
proxied to 3000. Keep `npm start` running in a second terminal.

---

## Deploy it

Any host that runs a long-lived Node process works. **Netlify and Vercel will
not** — their functions are serverless and cannot hold a WebSocket open.

Render, Railway, and Fly.io all work. Render, as an example:

1. Push this folder to a GitHub repo
2. Render → New → Web Service → connect the repo
3. Build command: `npm install && npm run build`
4. Start command: `npm start`
5. Deploy

You get `your-app.onrender.com`. Add a custom domain in the dashboard if you
want the URL to look like it belongs to you.

**Before a real exercise:** Render's free tier sleeps after inactivity and takes
about a minute to wake. Either use a paid instance or load the page ten minutes
before people arrive.

---

## Running an exercise

**Facilitator** — open `/host`, load your inject sheet, check the settings, press
*Open the room*. Each business unit gets its own four-character code.

**A code is a seat.** One business unit sends one person on one device. The first
device to use a code holds that unit's seat; a second device on the same code is
refused rather than quietly added. If a unit refreshes, drops its connection or
swaps device, it re-enters its own code and takes the seat back — its answers and
points come with it. You can also release a seat from the *Seats* panel if a unit
needs to start clean.

**Projector** — press *Project* (or `P`) to open `/screen` in a second tab and put
that on the room's display. It shows the condition, the question, the option
shapes, a clock readable from the back of the room, and the join codes. It never
shows your controls, your notes or anyone's score.

Each inject moves through four phases, and every device follows:

| Phase | What happens |
|---|---|
| Waiting | Join codes on screen, seats filling |
| Brief | Scenario on all devices, read aloud, no questions yet |
| Answer | Questions unlock for the targeted units only, clock running |
| Discuss | Answers revealed; the key stays hidden until you press for it |

Revealing answers and revealing the key are two separate presses. Nothing about
the key is sent to any device until the second one, so it can't be found by
inspecting the page.

Scores and notes never leave your machine. They're kept in your browser's local
storage and go into the CSV at the end.

**Keyboard** — `Space` advances the phase, `R` reveals, `K` releases the key,
`←`/`→` move between injects, `C` opens the seats panel, `P` opens the projector.

**Participants** — open the root URL and enter the unit's code. The code decides
the unit, so nobody can pick the wrong one. Optionally name whoever is at the
device. Answers can be changed until the window closes.

**Answer shapes** — every option carries one of four shapes and colours, the same
on the phone, your screen and the projector. You can ask *"siapa yang pilih
segitiga?"* out loud and the whole room knows which option you mean.

**Themes** — light and dark, switchable in the header on every surface, remembered
per device. Dark is the sensible choice for a dim room with a projector.

**Your logo** — drop the official Maybank asset at `public/brand/logo.svg`, and
optionally a reversed version at `public/brand/logo-dark.svg` for the dark theme.
It appears in the header on every surface and on the projector. With the folder
empty the app renders no logo and the wordmark stands alone, so nothing breaks.
Use the approved file from whoever owns the brand — not a redrawn copy.

---

## The inject sheet

One row per question. First row must be the headers.

| Column | Required | Notes |
|---|---|---|
| Inject No. | yes | Groups rows into one inject |
| Condition | | Scenario text, read aloud |
| Peran | yes | The unit(s) asked. Several in one cell, or one per row — both work |
| Siklus | | Groups injects into phases |
| Question | yes | |
| Tipe | | `pg`, `checkbox` or `esai`. Blank or absent = guessed from the Answer cell |
| Answer | | Options one per line, or a model answer for an essay |
| Window | | Answering time for that inject, in minutes |

Indonesian header names are recognised too (Kondisi, Pertanyaan, Jawaban,
Tahap, Waktu).

Blank cells in Inject No., Condition, Siklus and Window carry down from the row
above, so merged-looking sheets import correctly.

### Question types

| Type | `Tipe` value | Answer cell |
|---|---|---|
| Single choice | `pg`, `pilihan`, `choice`, `mc` | Options one per line, **one** marked `*` |
| Tick all that apply | `checkbox`, `centang`, `multi` | Options one per line, **two or more** marked `*` |
| Essay | `esai`, `uraian`, `open` | Free text — scored by you after the discussion |

The `Tipe` column is optional and wins when present. With it blank or absent the
Answer cell decides: two or more lines starting `A.` or `1)` are choices, and if
more than one of them is starred it becomes a checkbox question. Anything else is
an essay. Sheets written before b20 import exactly as they did.

Note that `multiple choice` maps to **single** choice, because that is what people
mean by it. Use `checkbox` for tick-all-that-apply.

### How answers score

Single choice is right or wrong. Checkbox gets partial credit with a penalty:
`(right ticks − wrong ticks) ÷ number of keys`, floored at zero — so ticking every
box earns nothing and "select all to be safe" is not a strategy. Accuracy scales
the points; the speed bonus then works exactly as it does for single choice.

**Units are not asked the same number of questions.** One unit may get ten across
the exercise and another three, so raw points cannot be compared. Every unit
carries what it could have scored, and the leaderboard and the By Peran table rank
on the percentage of that maximum — with raw points shown beside it. Questions with
no key marked in the sheet are excluded from the maximum, so a spreadsheet mistake
never counts against a unit. The importer warns you before the run if the counts
are uneven.

---

## Operational notes

- **Rooms are in memory**, snapshotted to `rooms.json` every 30s and restored on
  restart. They expire 12 hours after last activity.
- **A refresh is safe** on both sides. The facilitator resumes from local
  storage; a unit's device rejoins its own seat with its answers intact.
- **A dropped connection** shows "Reconnecting" in the header and retries with
  backoff. It doesn't fail silently.
- **Set `SNAPSHOT_PATH`** to a mounted volume if your host has ephemeral disk
  and you want snapshots to survive a redeploy.

## Before you use real content

There's no authentication. Anyone with the URL and a four-character code can
join and read the scenario and every answer.

One seat per unit narrows this — only the first guesser gets in — but it does
not close it. That first guesser still reads the scenario and every answer.

That's fine for an internal exercise on a URL you haven't published. It is not
fine if the injects name real systems and the answers document where controls
fail — which is exactly what a useful TTX produces.

If it needs to be locked down, the two smallest additions are a shared password
on the join screen, or hosting it inside the corporate network instead of on a
public PaaS. Worth deciding before the first real run, not after.
