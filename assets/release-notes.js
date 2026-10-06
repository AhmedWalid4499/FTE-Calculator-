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
  "version": "2.4.0",
  "folderMinVersion": "2.2.0",
  "releases": [
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
