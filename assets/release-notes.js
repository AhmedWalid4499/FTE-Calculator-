/* ===========================================================================
   release-notes.js - the app's version, and what each release added.

   This is the single source of the version number: the page, the launcher
   and the update check all read it. The part between the JSON and END
   markers must stay valid JSON - the launcher and the update check parse it
   as JSON, not as JavaScript.

   To release a new version: add an entry at the top of "releases", set
   "version" to it, then commit and push. Everyone's app notices within a few
   minutes. Raise "folderMinVersion" only when older versions must stop
   writing into the shared folder (for example after a change of layout) -
   and only in a commit that is pushed: the first published copy to open the
   folder raises it for everyone, and it is never lowered again.
   =========================================================================== */
window.FTE_RELEASES = /*JSON*/{
  "version": "2.11.0",
  "folderMinVersion": "2.2.0",
  "releases": [
    {
      "version": "2.11.0",
      "date": "2026-10-12",
      "title": "A map by country and by cluster; simpler WAN/LAN",
      "features": [
        "The Project map now has two views you can switch between: By country HQ (a circle per project HQ country) and By cluster (a circle per sales cluster - SE, NWE, Benelux, GEA, Swiss, MEA, AMER, APAC - placed at its region).",
        "HQ country and Sales cluster are no longer 'recorded only' - both now place your projects on the map. Set them on the WAN or LAN page and they show up straight away.",
        "Circles are sized by number of projects or total FTE (your choice), and the filters for type, status and cluster work in both views.",
        "Removed the 'Out of business hours' option from the WAN and LAN pages. New estimates no longer add an out-of-hours uplift; estimates saved earlier keep the figures they were saved with."
      ]
    },
    {
      "version": "2.10.0",
      "date": "2026-10-12",
      "title": "Insights & the map now include every saved project",
      "features": [
        "Insights and the Project map now draw on your saved projects automatically - including ones saved before the last release. Nothing to re-save: each project's result is recomputed on the fly, so the moment a project is in the Projects tab it counts.",
        "Each project is counted once. A project that was saved more than once (or kept as both a saved estimate and an older configuration) no longer double-counts in the totals or on the map.",
        "The Projects tab now shows the man-days and FTE for older configurations too, and whether each has a WAN side, a LAN side, or both - the same figures that feed Insights.",
        "Saving and reloading a project now keeps its Sales cluster (it was previously dropped on reload).",
        "A half-finished configuration - a site count with no tier allocation - is no longer counted as an estimate, so the totals reflect only real estimates."
      ]
    },
    {
      "version": "2.9.0",
      "date": "2026-10-12",
      "title": "Projects, Insights & the map, from saved estimates",
      "features": [
        "💾 Save now creates a reloadable project: it appears in the Projects tab (shared with the team when you Save to SharePoint), where one click loads it back - inputs, result, author and all - to tweak or recalculate.",
        "FTE Records is now a plain history: every Calculate is logged automatically, so you keep the full trail even when the same project is estimated more than once.",
        "Insights has its own tab, and it counts each project once (from your saved projects, not the raw history) - so repeated calculations no longer inflate the totals.",
        "The Project map now reads the same saved projects, so the map and the Insights tab always agree.",
        "New 'Sales cluster' field next to the HQ country (SE, NWE, Benelux, GEA, Swiss, MEA, AMER, APAC) records where a deal came from; filter the map by it and see it on each project.",
        "Older input-only projects from before this release still appear, under 'Older saved configurations', and load as before."
      ]
    },
    {
      "version": "2.8.0",
      "date": "2026-10-12",
      "title": "Clearer saving — this device, or SharePoint",
      "features": [
        "Calculating no longer saves by itself. Press Calculate to see the result, then choose whether and where to keep it — no more wondering what got saved.",
        "Two clear save buttons on the WAN and LAN pages: 💾 Save keeps the estimate on this device, and ☁ Save to SharePoint publishes it to the shared team folder so everyone can see it.",
        "Choose who did it: a new 'Calculated by' picker (defaults to you, or pick a colleague from the DPM Directory) stamps the author on every saved estimate, so FTE Records clearly shows who did what.",
        "FTE Records now shows where each estimate lives — 'this device', 'SharePoint', or 'not shared' — next to who calculated it.",
        "Saving the same estimate to this device and then to SharePoint updates the one record rather than creating a duplicate."
      ]
    },
    {
      "version": "2.7.0",
      "date": "2026-10-07",
      "title": "Project map, country & out-of-hours",
      "features": [
        "New Project map tab: every saved estimate shown on a world map by its HQ country, with a circle per country sized by how many estimates (or total FTE) are there, and filters for type and status. Needs an internet connection; it degrades gracefully offline.",
        "New project details on WAN and LAN estimates: the project HQ country, whether the work is out of business hours (Yes / No / Not known), and the language(s) the DPM/PM needs to speak.",
        "Out-of-hours uplift: setting 'Out of business hours' to Yes adds a configurable percentage to the effort (default 15%, changeable in Settings) for the extra unsocial-hours coordination.",
        "The new details are saved with each estimate, restored when you load a project, and shown in the record view and the Excel export - the country also places it on the map."
      ]
    },
    {
      "version": "2.6.0",
      "date": "2026-10-06",
      "title": "See the whole team's estimates",
      "features": [
        "New Insights tab on the FTE Records page: a dashboard over every saved estimate, not just your own.",
        "See who estimated what - charts of estimates by DPM and total FTE by DPM, plus a per-person leaderboard with estimates, sites, man-days and average FTE.",
        "Totals at a glance: estimates (WAN vs LAN), total FTE, total man-days and sites, and how many people have contributed.",
        "Trends: estimates over time by month, and a WAN-vs-LAN split by man-days.",
        "Everyone sharing the team folder sees the same estimates, so the Insights tab is a single team-wide picture - no setup needed beyond connecting the shared folder."
      ]
    },
    {
      "version": "2.5.0",
      "date": "2026-10-06",
      "title": "A clearer, roomier Assistant",
      "features": [
        "The Assistant's answers now read properly: tables are real tables, with lists, headings and code laid out instead of one long line - so comparisons and breakdowns are easy to scan.",
        "Make it bigger: enlarge the Assistant with one click, or drag its left edge to any width. Your choice is remembered.",
        "Its own tab in the sidebar: open the Assistant as a full page next to your estimates, not just the slide-out panel.",
        "Open it in its own window too: a focused, full-window chat you can keep beside the calculator - click the window icon in the Assistant's header.",
        "Reliability: fixed a case where the Assistant could show an error right after filling in an estimate on its own."
      ]
    },
    {
      "version": "2.4.0",
      "date": "2026-10-06",
      "title": "AI assistant",
      "features": [
        "An AI assistant (the ✨ Assistant button, top right): ask it about an estimate, how to set one up, or whether the numbers look right.",
        "Auto-fill from a file: upload a spreadsheet, PDF or photo of a site list, BOM or scope document and it fills the WAN or LAN form - sites, devices, products, tiers, duration - and lists anything it had to assume.",
        "It can do the whole estimate on its own: describe a project in the chat (or attach a file) and the assistant fills the form AND runs the calculation, then reports the man-days and FTE.",
        "AI opinion: a short, candid review of a calculated estimate - is it reasonable, what to double-check, one suggestion.",
        "Works on the website too: click the key icon and paste an Anthropic API key once (kept only in your browser, never shared or uploaded). With the launcher, one shared key set in the team folder serves everyone.",
        "Also recently added: a downloadable illustrated User Guide (PDF), linked from the sidebar and the Dashboard."
      ]
    },
    {
      "version": "2.3.0",
      "date": "2026-10-01",
      "title": "Compare scenarios side by side",
      "features": [
        "Compare scenarios: run several estimates of the same project side by side under different conditions - complexity, mode, flat or bell curve, migration, duration, capacity, the allocation - and see how the man-days and FTE change, with the differences highlighted and the change against the first scenario shown.",
        "Add a scenario with one click on the WAN or LAN page. Nothing is written to the data folder while you experiment; load any scenario back to tweak it.",
        "Save the one you want as the estimate, or save the whole comparison in your browser to reopen later."
      ]
    },
    {
      "version": "2.2.0",
      "date": "2026-09-29",
      "title": "Updates and what's new",
      "features": [
        "This panel: the new features of every update, right on the Dashboard.",
        "Check for updates at any time - the app also checks by itself when it starts.",
        "With the launcher, one click downloads and installs an update and restarts the app. Your estimates and settings are kept.",
        "The website tells you when a newer version has been published and asks you to reload.",
        "The SharePoint folder now records the oldest version allowed to save into it. From this version on, a copy that is too old says so and asks to be updated instead of saving the old way."
      ]
    },
    {
      "version": "2.1.0",
      "date": "2026-09-29",
      "title": "Team planning and SharePoint",
      "features": [
        "Team capacity: every active estimate on one calendar, compared with the size of the team, with each DPM's load month by month.",
        "Import the site list from Excel or CSV instead of typing the allocation rows, with a ready-made template.",
        "Estimates are saved into the SharePoint team folder \"FTE - Website\" automatically, stamped with who created them.",
        "Every project has its own folder holding its estimates and an Excel workbook named \"<project> - <who did it>\"."
      ]
    },
    {
      "version": "2.0.0",
      "date": "2026-09-27",
      "title": "The rebuilt calculator",
      "features": [
        "Every calculation saved as an FTE record, with projects and a DPM directory you can edit.",
        "Excel exports with real tables, the FTE up front, and month-by-month graphs.",
        "Flat or bell-curve effort distribution, with the peak FTE the busiest month needs.",
        "Email the result as a formatted Outlook draft, and add notes to any estimate."
      ]
    }
  ]
}/*END*/;
