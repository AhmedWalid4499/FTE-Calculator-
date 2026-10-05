# DPM FTE Calculator

Estimates DPM effort and headcount for WAN and LAN network rollout projects.
Enter the sites, the products or device tiers and the duration; it returns the
man-days, the FTE and the headcount — and shows its full working, so every
number can be checked by hand.

**▶ Use it here: <https://ahmedwalid4499.github.io/FTE-Calculator-/>**

No installation, no account, no server. Everything runs in your browser; the
team's estimates are shared through a SharePoint folder that OneDrive keeps in
sync on each PC (see below).

---

## Where your work is saved

The app always keeps your work in the browser's own database, which survives
refreshes and restarts. On top of that it can write each calculation to disk as
a `.json` file. Which of those you get depends on how you opened it:

| How you opened it | Saved in browser | Written to disk as JSON |
|---|---|---|
| The link above, in **Chrome or Edge** | yes | yes — into a folder you pick |
| The link above, in **Firefox or Safari** | yes | via **Download full backup** |
| **`Start FTE Calculator.cmd`** locally | yes | yes — into the SharePoint team folder once it is synced, until then `data/` |
| `index.html` double-clicked | yes | no (browsers forbid it) |

### Saving to a folder (Chrome / Edge)

Go to **Settings → Connect a folder** and choose where you want the files. From
then on every calculation is written there automatically, into a folder per
project together with its Excel workbook (see *How the data folder is
organised* below), with saved configurations in `projects/`.

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
it open while you work — it is what writes calculations to disk with no folder
prompt at all: into the SharePoint team folder once OneDrive has synced it (see
below), and into `data/` next to the app until then, or if you choose
**Use my own folder instead**. Nothing needs installing; it uses PowerShell,
which is already part of Windows.

There are two different things the app stores, and they are not the same:

| | What it holds | Where |
|---|---|---|
| **FTE Record** | A finished calculation — the inputs *and* the result, frozen | the project's own folder |
| **Project** | Just the settings you typed, to pick up again later | `projects/` in the data folder |

Every press of **Calculate** writes a new record, so the folder is a full
history of how an estimate developed. The only fields ever changed on a saved
record afterwards are its notes and its planned start month — neither affects
the calculation.

### How the data folder is organised

```
FTE - Website/                                   (or data/ on this PC)
  Cairo WAN Rollout/
    Cairo WAN Rollout - Ahmed Elbourgy.xlsx      the Excel workbook
    FTE-20260929-101500-ABCD.json                one file per calculation
    FTE-20261002-093000-QRST.json
  projects/                                      saved configurations
```

- Each project gets a folder named after it; every calculation's JSON goes in.
- Beside them sits one Excel workbook per person who estimated the project,
  named **`<project> - <who did it>.xlsx`**. It is rebuilt automatically after
  every calculation or change, from that person's latest estimate — when they
  have estimated the project as both WAN and LAN, both are in the one workbook,
  with an overview sheet first. Deleting their last estimate removes it. (Two
  people with the same display name get their email name added.)
- The workbook uses the same sheets as **Export to Excel**; the difference is
  that Export gives the one estimate you are looking at, while the saved
  workbook always holds the person's latest WAN and/or LAN estimate.
- If the workbook is open in Excel when it needs updating, the app says so;
  close it and it is rewritten on the next change, or use **Settings →
  Maintenance → Rebuild Excel workbooks**. Rebuild also removes workbooks whose
  estimates have all been deleted.
- Earlier versions kept every estimate in one `records/` folder. Those are
  still read and move into their project folder the next time they are saved;
  **Rebuild Excel workbooks** moves them all at once and creates their
  workbooks. Older versions of the app only look in `records/`, so make sure
  everyone has updated first — reload the website, or download the launcher
  again — or moved estimates disappear from their lists.

---

## The SharePoint team folder

Every estimate is saved into one SharePoint folder, **FTE - Website**, which
OneDrive keeps in sync on each person's PC:

<https://orange0-my.sharepoint.com/:f:/r/personal/ahmed_elbourgy_ext_orange_com/Documents/FTE%20-%20Website?d=w2cc15d09b7054e0f9191e741d90e0c3f&csf=1&web=1&e=aJtbL9>

The link only opens for people the folder has been shared with.

**Owner (once):** share the folder with the team with *Can edit* rights.

**Everyone else (once per PC):**

1. Open the link above and choose **Add shortcut to My files** in the bar at the
   top. OneDrive syncs the folder to your PC within a minute or so.
2. Start the app with **`Start FTE Calculator.cmd`**. It finds the synced
   folder by itself — OneDrive records every synced SharePoint location with
   its web address, so the app checks it really is the shared folder, not just
   a folder with the same name — and links it. Your own earlier estimates and
   projects are copied in (never anyone else's); nothing already in the folder
   is overwritten. A folder that only has the right name, such as a private
   copy, is shown in Settings with a warning instead of being linked.

From then on every estimate anyone calculates is written into the folder and
OneDrive uploads it to SharePoint automatically. The Records and Team capacity
pages read everyone's estimates.

In the published web version (Chrome or Edge), use **Settings → SharePoint team
folder → Connect the team folder** and pick `FTE - Website` inside your
`OneDrive - orange.com` folder.

**Settings → Use my own folder instead** stops saving to SharePoint on that PC
(remembered in `config.json`, so the app does not re-link by itself);
**Link the team folder** goes back. Deleting a record, or **Delete all FTE
records**, while linked removes it for everyone — the confirmation says so.

### Who created each estimate

Every estimate is stamped **Created by** with the name and email of the person
who calculated it. With the launcher this comes from the OneDrive work account
signed in on the PC (named from the DPM Directory); in the web version the app
asks once, and it can be changed under **Settings → You**. Changes made later
to an estimate's notes or planned start record who made them. Records can be
filtered by creator, and the name appears in the Excel exports and on the Team
capacity page.

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

## Comparing scenarios

To weigh the same project under different conditions, use **➕ Add to
comparison** on the WAN or LAN page instead of (or as well as) **Calculate**.
It snapshots the current form — complexity, mode, flat or bell curve,
migration, duration, capacity and the allocation — as a *scenario* and lists
them side by side in the **Compare scenarios** panel.

- Change a condition and add another scenario to see the effect. The
  conditions that differ from the first (baseline) scenario are highlighted,
  and each result shows its change against the baseline (for example `+30%`).
- **Nothing is written to the data folder while you experiment.** A scenario
  is only a what-if until you act on it.
- **Load** puts a scenario back on the form so you can tweak it; **✎** renames
  it; **✕** removes it from the comparison.
- **Save** (on a scenario) files that one as the real estimate — exactly like
  pressing Calculate, so it lands in the data folder and the project workbook.
- **Save comparison** keeps the whole set to reopen later with **Open saved**.
  Saved comparisons live in your browser on this PC; they are kept separate
  from Records and the Team-capacity plan so neither is cluttered by what-ifs.

---

## Updates

The top of the **Dashboard** shows what the current version added, and
whether a newer one has been published. **Check for updates** asks straight
away; the app also checks by itself when it starts, every 30 minutes, and when
you come back to it. When an update is available, a chip appears in the top
bar on every page.

| How you opened it | What **Update now** does |
|---|---|
| `Start FTE Calculator.cmd` | Downloads the new version from GitHub, installs it and restarts on the same address. Your estimates, settings, DPM directory and data folder are not touched; the version you had is kept in `backup/` next to the app. |
| The website | Reloads the page with fresh files — the website itself is already updated. |
| A git working copy | Runs `git pull`, only if the copy has no local changes. The previous version stays in git's history. |
| The single file | Opens the website — a single file cannot replace itself. |

**One version for everyone.** The data folder holds a small file,
`fte-folder.json`, naming the oldest version of the app allowed to save
there. An older copy refuses to save and asks to be updated, instead of
writing the folder the old way — your work stays in the browser until it can
be saved. A page left open while the launcher was updated likewise asks to be
reloaded, and a launcher window left running after its files were replaced
(say, by a second window) asks to be restarted. Versions before 2.2.0 cannot
read this file, so everyone should update to 2.2.0 once; from then on the
check covers every later release.

### Releasing a new version (for the maintainer)

1. Make the changes.
2. In `assets/release-notes.js`, add an entry at the top of `releases` —
   version, date, a title and the features in plain words — and set
   `"version"` to it. That file is the only place the version number lives.
3. Raise `"folderMinVersion"` as well only when older versions must stop
   saving into the shared folder, for example after changing its layout.
   The first *published* copy to open the folder raises the marker for
   everyone and it is never lowered — so raise it only in a commit you push
   straight away. (A git working copy never raises it, so testing a release
   locally cannot lock the team out.)
4. Commit and push. Everyone's app offers the update within a few minutes.

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

## AI assistant (optional)

With a key set up, an **✨ Assistant** appears in the top bar and three AI
features light up:

- **Auto-fill from a file** — upload a spreadsheet, PDF or photo of a site
  list / BOM / scope document and the assistant reads it and fills the WAN or
  LAN form (sites, devices, products, tiers, duration…), listing anything it
  had to assume. You check it and press Calculate.
- **AI opinion** — a short, candid review of a calculated estimate: is the FTE
  reasonable, what to double-check, one suggestion.
- **Chat** — ask how to set an estimate up, sanity-check numbers, or get an
  explanation. The assistant sees the estimate currently on screen.

### How the key is kept safe

This repository is **public**, so the Anthropic API key is **never** in the
app's files or sent to the browser. Instead the **launcher** holds the key and
makes the Claude calls; the browser only ever talks to the launcher. The AI
features therefore work only when the app is started with
**Start FTE Calculator.cmd** (the website and the single-file build show them
as unavailable).

### Setting the key (once, for the whole team)

Put the key in the shared team folder so every teammate's launcher picks it
up:

```
FTE - Website\.config\anthropic-key.txt     ← one line: the API key
```

That folder is private to the team (not the public repo). The launcher also
reads, in order of priority: the `ANTHROPIC_API_KEY` environment variable, then
`%LOCALAPPDATA%\DPM-FTE-Calculator\anthropic-key.txt`, then the shared file
above.

Use a **workspace-scoped** API key (created against a workspace in the
Anthropic console) — then nothing else is needed. If you use an
organisation/user key that is *not* tied to a workspace, Anthropic also needs a
workspace id; provide it with an `ANTHROPIC_WORKSPACE_ID` environment variable
or in `FTE - Website\.config\ai.json`:

```json
{ "workspaceId": "wrkspc_...", "model": "claude-opus-5-5" }
```

`model` is optional (defaults to `claude-opus-5-5`; use `claude-sonnet-5-5`
for a cheaper, faster option). The key files live outside this repository and
are also git-ignored defensively, so they can never be committed.

---

## Sending it to someone without a link

```
powershell -ExecutionPolicy Bypass -File build\Make-Portable.ps1
```

Produces `DPM-FTE-Calculator-portable.html`, a single ~1.6 MB file with
everything folded in. It can be emailed and opened by double-clicking. It
needs nothing from the internet to work; the only things it fetches are the
release notes on GitHub (to say when a newer version exists) and the user
guide PDF (opened from its “User guide” links, which point to the published
copy since the PDF is not folded into the single file).

---

## The user guide (PDF)

`DPM-FTE-Calculator-Guide.pdf` at the repository root is an illustrated manual
for end users. It is linked from the sidebar (**User guide (PDF)**) and the
Dashboard, served by the launcher and the website, and published on GitHub
Pages so anyone can download it.

The source is `build/guide/guide.html` with its screenshots in
`build/guide/img/`. To regenerate the PDF after editing the text — or after
refreshing the screenshots (recapture them into `build/guide/img/` under the
same file names) — run:

```
powershell -ExecutionPolicy Bypass -File build\Make-Guide.ps1
```

It renders the HTML to the PDF with headless Microsoft Edge, so there is
nothing extra to install. The screenshots were taken from sample data, so the
guide shows no real projects, people or machine paths.

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

The app itself sends your data nowhere. There is no analytics, no tracking and
no backend — GitHub Pages serves static files and never sees your data. Your
estimates are files in your browser and in the folder you save to; when that is
the SharePoint team folder, OneDrive syncs them to Orange's SharePoint like any
other file, visible only to the people the folder is shared with.

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

**The team folder is not linked.**
Open **Settings → SharePoint team folder**. If it says the folder is not synced,
add the shortcut (step 1 above), wait for OneDrive to finish, and press **Look
again**. If you chose your own folder earlier, press **Link the team folder**.

**"That folder does not exist" when choosing a different folder.**
The path must be the local, synced copy (under `C:\Users\…`), not a SharePoint
web address. Sync the library first, then copy the path from File Explorer's
address bar.

**A colleague's estimate is missing from Team capacity.**
Press **Refresh**. OneDrive may still be syncing their file; files that cannot
be read yet are counted in the note at the top of the page.

**Charts or Excel export missing.**
Check `lib/` still contains both `.js` files. Settings reports whether each
library loaded.
