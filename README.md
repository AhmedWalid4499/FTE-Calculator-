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

Every press of **Calculate** writes a new record, so the folder is a full
history of how an estimate developed. The only fields ever changed on a saved
record afterwards are its notes and its planned start month — neither affects
the calculation.

---

## Sharing one data folder with the team

On its own, each person's app only sees their own estimates. To plan across the
whole team, everyone points the app at **one shared folder** — a SharePoint or
Teams document library synced to each PC through OneDrive:

1. In Teams, open the channel's **Files** tab and choose **Sync** (or *Add
   shortcut to My files*). Create a folder in it, e.g. `FTE Data`.
2. In the app, **Settings → Where your data is saved → Shared team folder**,
   paste that folder's path (for example
   `C:\Users\you\Orange\DPM Team - Documents\FTE Data`) and press
   **Use this folder**. Tick *copy my existing estimates* to bring your own work
   along — nothing already in the shared folder is overwritten.
3. Each person does this once on their own PC. The choice is remembered in
   `config.json` next to the app (per machine, git-ignored).

From then on every estimate anyone saves lands in the shared folder, and the
Records and Team capacity pages read everyone's. **Back to my own data folder**
switches back at any time; the shared folder is left untouched.

On the published GitHub Pages site the same works by connecting the synced
folder with **Settings → Connect a folder** (Chrome or Edge).

Deleting a record, or **Delete all FTE records**, in a shared folder removes it
for everyone — the confirmation says so.

---

## Team capacity

The **Team capacity** page adds every active estimate onto one calendar:

- Each project is placed from its **planned start** month (set on the WAN / LAN
  page, or taken from the start date when the duration is entered as dates).
- Only the **latest** estimate of each project counts; older ones are history.
  Estimates with the same project name (and type) are treated as the same
  project, so re-running an estimate never counts it twice. Inactive projects
  are left out unless you choose to include them.
- Monthly demand = that month's man-days ÷ the DPM capacity the estimate used,
  summed across projects and compared with the **team capacity** (defaults to
  the number of people in the DPM Directory; set your own figure on the page).
- Each project's demand is shared equally between its assigned DPMs, giving a
  month-by-month **load per person** — above 1.00 means overbooked.

Change a project's start month directly in the table to move it on the
calendar; the change is saved onto the estimate so everyone sharing the folder
sees the same plan. **Export to Excel** produces the plan, the projects with
their monthly FTE, the DPM load table and the chart.

---

## Importing the site list from Excel

Instead of typing allocation rows, press **Import from Excel** on the WAN or
LAN page and choose an `.xlsx` or `.csv` site list:

- One line per site, or one line per group of sites with a *Sites* count.
- **WAN** needs a product and a connectivity mode per line; **LAN** needs a
  device count or a tier (the tier wins when both are given).
- Optional columns: complexity %, override MD per site, site name.

The importer finds the heading row, matches the columns, recognises common
spellings (`SD WAN`, `BVPN Corp`, `dual vedge`, `Medium`…), groups identical
sites into allocation rows and shows a preview — including every skipped line
and why — before anything changes. Named sites are listed on a **Site list**
tab in the Excel export. **Template** downloads a ready-made sheet with
drop-downs of the exact rate-card names.

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

### Effort distribution: flat or bell curve

**Flat** spreads the man-days evenly across the months — the simple baseline.
**Bell curve (normal)** spreads them as a normal distribution: effort ramps up
to a peak in the middle of the project and back down, which is closer to how a
real rollout behaves. The bell curve reports the **peak FTE** — the larger team
the busiest mid-project month needs, which is what you staff to. The total
effort and the average FTE are the same either way; the bell only reveals the
peak and lets you picture the project shape. Available on both WAN and LAN.

### Email the result

The **Email result** button opens a ready-to-review email with a table of the
project name, man-days and FTE. Started with the launcher it opens an Outlook
draft directly (with a formatted table); otherwise it opens your default mail
app with a plain-text version. The recipients (CC defaults to
`karim.elzarka.ext@orange.com`) and the subject are set in **Settings → Email**
and can be changed any time. The email is never sent automatically — you review
and send it.

### Fields that do not affect the result

`Project Type`, `ABACOS`, `FLAN`, `DPM acting as PM` and `Project Status` are
stored with the estimate and appear in exports, but they do **not** change any
calculated figure. They are badged throughout the interface so this is never a
surprise. `Project Status`, the planned start and the assigned DPMs are used by
the Team capacity page, but never by the estimate itself.

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
  import.js                site-list import (Excel / CSV)
  planner.js               team capacity plan (pure functions)
  app.js                   page controllers
lib/                       Chart.js and ExcelJS, stored locally
Start FTE Calculator.cmd   local launcher
server/serve.ps1           local host and JSON API
build/Make-Portable.ps1    builds the single-file version
data/                      your saved work — git-ignored, never published
config.json                this PC's shared-folder choice — git-ignored
```

The local host only answers requests addressed to `127.0.0.1` / `localhost`
on its own port, refuses writes from other web pages, and never serves
`config.json` or anything under `data/`.

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

**"That folder does not exist" when choosing a shared folder.**
The path must be the local, synced copy (under `C:\Users\…`), not a SharePoint
web address. Sync the library first, then copy the path from File Explorer's
address bar.

**A colleague's estimate is missing from Team capacity.**
Press **Refresh**. OneDrive may still be syncing their file; files that cannot
be read yet are counted in the note at the top of the page.

**Charts or Excel export missing.**
Check `lib/` still contains both `.js` files. Settings reports whether each
library loaded.
