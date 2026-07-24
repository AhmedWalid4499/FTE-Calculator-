# DPM FTE Calculator

Estimates DPM effort and headcount for WAN and LAN network rollout projects.
Enter the sites, the products or device tiers and the duration; it returns the
man-days, the FTE and the headcount — and shows its full working, so every
number can be checked by hand.

**▶ Use it here: <https://ahmedwalid4499.github.io/FTE-Calculator-/>**

No installation, no account, no server. Everything runs in your browser and
your data never leaves your machine.

---

## Where your work is saved

The app always keeps your work in the browser's own database, which survives
refreshes and restarts. On top of that it can write each calculation to disk as
a `.json` file. Which of those you get depends on how you opened it:

| How you opened it | Saved in browser | Written to disk as JSON |
|---|---|---|
| The link above, in **Chrome or Edge** | yes | yes — into a folder you pick |
| The link above, in **Firefox or Safari** | yes | via **Download full backup** |
| **`Start FTE Calculator.cmd`** locally | yes | yes — into `data/` automatically |
| `index.html` double-clicked | yes | no (browsers forbid it) |

### Saving to a folder (Chrome / Edge)

Go to **Settings → Connect a folder** and choose where you want the files. From
then on every calculation is written there automatically, as
`records/FTE-<date>-<id>.json`, with saved projects in `projects/`.

Browsers deliberately drop folder permission when you close the tab, so on your
next visit Settings will show **Reconnect folder** — one click, and anything
saved meanwhile is written out immediately. Nothing is lost in between.

### Everyone can, in every browser

- **Export to Excel** — a formatted workbook per estimate: a summary with the
  FTE up front, the full allocation as a sortable table with totals, a
  month-by-month distribution tab with two graphs (effort with a cumulative
  curve, and FTE per month against the average), and the exact rate card the
  figures were priced from.
- **Download full backup** — one JSON file with every record, project, DPM and
  setting. Restore it in another browser or on another machine.
- **Import / export the DPM directory** as JSON or CSV.
- **Save and reload projects.**

---

## Running it locally

Clone or download the repo and double-click **`Start FTE Calculator.cmd`**.

A console window opens and your browser goes to `http://127.0.0.1:8080`. Leave
it open while you work — it is what writes calculations straight into `data/`
with no folder prompt at all. Nothing needs installing; it uses PowerShell,
which is already part of Windows.

There are two different things the app stores, and they are not the same:

| | What it holds | Where |
|---|---|---|
| **FTE Record** | A finished calculation — the inputs *and* the result, frozen | `data/records/` |
| **Project** | Just the settings you typed, to pick up again later | `data/projects/` |

Every press of **Calculate** writes a new record. Nothing is ever overwritten,
so the folder is a full history of how an estimate developed.

---

## Managing the DPM directory

The published list is only a starting point. On the **DPM Directory** page you
can add people, edit them, remove them, import a list (JSON or a two-column
CSV), or export the current one.

Your changes live in your browser and never affect anyone else's copy.
**Restore published list** puts it back to what the app shipped with.

---

## How an estimate is calculated

```
row effort   = base rate (MD per site) x complexity % x number of sites
total effort = sum of all rows + migration uplift (WAN, if in scope)
per month    = total effort / duration in months
FTE          = per month / DPM monthly capacity          (default 18 MD)
headcount    = FTE rounded up to whole people
utilisation  = FTE / headcount
```

The **Rates & Method** page lists every published rate, a worked example and a
glossary. Every result also shows its own arithmetic, step by step.

### Delivery schedule (ramp-up / ramp-down)

By default the effort is spread evenly across every month, which assumes the
same number of sites is delivered each month — rarely true in practice. Fill in
**Sites delivered per month** (one number per month, e.g. `10, 20, 30, 25, 15`)
and the tool phases the effort to match and reports the **peak FTE**: the team
size the busiest month actually needs, which is what you staff to. The total
effort and the average FTE are unchanged — the schedule only reveals the peak.
Leave it empty for the even spread. Available on both WAN and LAN.

### Fields that do not affect the result

`Project Type`, `ABACOS`, `FLAN`, `DPM acting as PM` and `Project Status` are
stored with the estimate and appear in exports, but they do **not** change any
calculated figure. They are badged `recorded only` throughout the interface so
this is never a surprise.

### Changing the assumptions

**Settings** lets you change the DPM monthly capacity, the migration uplift and
the default complexity. Changes apply to *new* calculations only — every saved
record keeps the values that were in force when it ran, so old results stay
reproducible.

---

## Sending it to someone without a link

```
powershell -ExecutionPolicy Bypass -File build\Make-Portable.ps1
```

Produces `DPM-FTE-Calculator-portable.html`, a single ~1.3 MB file with
everything folded in. It can be emailed and opened by double-clicking, and
loads nothing from the internet.

---

## Files

```
index.html                 the application
assets/
  app.css                  styles
  dpm-directory.js         the published starting list of DPMs (a seed only)
  data.js                  rate tables, glossary, help text
  calc.js                  the estimation engine (pure functions)
  db.js                    browser database plus the three disk backends
  ui.js                    dialogs, toasts, tables, charts
  export.js                Excel workbooks
  app.js                   page controllers
lib/                       Chart.js and ExcelJS, stored locally
Start FTE Calculator.cmd   local launcher
server/serve.ps1           local host and JSON API
build/Make-Portable.ps1    builds the single-file version
data/                      your saved work — git-ignored, never published
```

`lib/` holds local copies of Chart.js and ExcelJS rather than loading them from
a CDN, so the app works offline and cannot be broken by a blocked CDN or a
library update.

---

## Privacy

Nothing is uploaded anywhere. There is no analytics, no tracking and no backend
— GitHub Pages serves static files and never sees your data. Your estimates
live in your own browser and in whatever folder you chose.

---

## Troubleshooting

**Settings says "Reconnect folder".**
Normal after closing the tab — browsers drop folder permission deliberately.
Click it and anything held in the browser is written out.

**"This browser cannot write to a folder".**
Folder saving needs Chrome or Edge. In Firefox or Safari everything else works;
use **Download full backup** to keep a copy.

**The local console window closes immediately, or the port is busy.**
Ports 8080–8090 are tried in order. If all are taken, run
`server\serve.ps1 -Port 9000` from PowerShell.

**Charts or Excel export missing.**
Check `lib/` still contains both `.js` files. Settings reports whether each
library loaded.
