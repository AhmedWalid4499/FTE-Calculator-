/* ===========================================================================
   data.js - domain reference data and all user-facing explanatory copy.
   No DOM access, no side effects. Everything here is the "rate card".
   =========================================================================== */
(function (global) {
  'use strict';

  /* The version lives in release-notes.js, loaded just before this file. */
  var RELEASES = global.FTE_RELEASES || { version: '0.0.0', releases: [] };
  var APP_VERSION = RELEASES.version;
  /* The oldest version allowed to write into a data folder this one writes to. */
  var FOLDER_MIN_VERSION = RELEASES.folderMinVersion || APP_VERSION;

  /** -1, 0 or 1, comparing "2.10.0" with "2.9.1" part by part as numbers. */
  function compareVersions(a, b) {
    var pa = String(a || '0').split('.'), pb = String(b || '0').split('.');
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var x = parseInt(pa[i], 10) || 0, y = parseInt(pb[i], 10) || 0;
      if (x !== y) return x > y ? 1 : -1;
    }
    return 0;
  }

  /* --------------------------------------------------------------- WAN --- */

  var PRODUCTS = [
    'SD-WAN', 'BVPN Corporate', 'IEL', 'BVPN Small',
    'Internet Essential', 'Internet Platinum', 'Flexible SD-Branch'
  ];

  var CONNECTIVITY_MODES = [
    'Access only', '1 CPE / No Continuity', '2 CPEs / With Continuity',
    'Single vEdge CPE', 'Dual vEdge CPE', 'Dual', 'Air Backup', 'Always-On'
  ];

  /* Base effort in man-days per site, keyed [connectivity mode][product].
     A missing key means the combination is not offered - never zero effort. */
  var BASE_MD = {
    'Access only': {
      'SD-WAN': 0.25, 'BVPN Corporate': 0.25, 'IEL': 0.25, 'BVPN Small': 0.25,
      'Internet Essential': 0.25, 'Internet Platinum': 0.25, 'Flexible SD-Branch': 0.25
    },
    '1 CPE / No Continuity': {
      'SD-WAN': 1.125, 'BVPN Corporate': 1.25, 'IEL': 1.25, 'BVPN Small': 1.25,
      'Internet Essential': 1.25, 'Internet Platinum': 1.25
    },
    '2 CPEs / With Continuity': {
      'SD-WAN': 2.25, 'BVPN Corporate': 2.5, 'IEL': 2.5, 'BVPN Small': 2.5,
      'Internet Essential': 2.5, 'Internet Platinum': 2.5
    },
    'Single vEdge CPE': {
      'SD-WAN': 1.125, 'BVPN Corporate': 1.125, 'IEL': 1.125, 'BVPN Small': 1.125,
      'Internet Essential': 1.125, 'Internet Platinum': 1.125, 'Flexible SD-Branch': 1.125
    },
    'Dual vEdge CPE': {
      'SD-WAN': 2.25, 'BVPN Corporate': 2.25, 'IEL': 2.25, 'BVPN Small': 2.25,
      'Internet Essential': 2.25, 'Internet Platinum': 2.25, 'Flexible SD-Branch': 2.25
    },
    'Dual': {
      'BVPN Corporate': 2.5, 'IEL': 2.5, 'BVPN Small': 2.5,
      'Internet Essential': 2.5, 'Internet Platinum': 2.5
    },
    'Air Backup': { 'BVPN Corporate': 1.25, 'IEL': 1.25 },
    'Always-On': { 'BVPN Corporate': 1.25, 'IEL': 1.25 }
  };

  /** Base man-days per site, or null when the pairing is not offered. */
  function lookupBaseMd(mode, product) {
    var row = BASE_MD[mode];
    if (!row) return null;
    var v = row[product];
    return (typeof v === 'number') ? v : null;
  }

  /* --------------------------------------------------------------- LAN --- */

  var LAN_TIERS = [
    { key: 'OD_XS',  name: 'OD/XS',  range: '< 3 devices',       min: 0,   max: 2,        loe: 2.4 },
    { key: 'S',      name: 'S',      range: '3 - 10 devices',    min: 3,   max: 10,       loe: 3.3 },
    { key: 'M',      name: 'M',      range: '11 - 50 devices',   min: 11,  max: 50,       loe: 5.3 },
    { key: 'Large',  name: 'Large',  range: '51 - 100 devices',  min: 51,  max: 100,      loe: 9.4 },
    { key: 'XL',     name: 'XL',     range: '101 - 500 devices', min: 101, max: 500,      loe: 17.3 },
    { key: 'Campus', name: 'Campus', range: '> 500 devices',     min: 501, max: Infinity, loe: 33.3 }
  ];

  var LAN_TIER_LABELS = LAN_TIERS.map(function (t) { return t.name + ' (' + t.range + ')'; });

  function tierByLabel(label) {
    for (var i = 0; i < LAN_TIERS.length; i++) {
      if (LAN_TIER_LABELS[i] === label) return LAN_TIERS[i];
    }
    return null;
  }

  function tierByName(name) {
    for (var i = 0; i < LAN_TIERS.length; i++) {
      if (LAN_TIERS[i].name === name) return LAN_TIERS[i];
    }
    return null;
  }

  /** Pick the tier a given device count falls into. */
  function tierForDeviceCount(devices) {
    var n = Number(devices) || 0;
    for (var i = 0; i < LAN_TIERS.length; i++) {
      if (n >= LAN_TIERS[i].min && n <= LAN_TIERS[i].max) return LAN_TIERS[i];
    }
    return LAN_TIERS[0];
  }

  /* Stage effort in HOURS per site, keyed [stage][activity][tier key]. */
  var STAGE_HOURS = {
    'Design': {
      'Service implementation set-up':        { OD_XS: 2,   S: 2,   M: 2,   Large: 2,   XL: 2,   Campus: 2 },
      'Kick-off / scoping workshop(s)':       { OD_XS: 2,   S: 2,   M: 3,   Large: 3,   XL: 4,   Campus: 8 },
      'Awareness':                            { OD_XS: 1,   S: 1,   M: 1,   Large: 1.5, XL: 2,   Campus: 4 },
      'Customer communications (local site)': { OD_XS: 0.5, S: 0.5, M: 1,   Large: 1.5, XL: 2,   Campus: 2 },
      'Validate solution design':             { OD_XS: 0.5, S: 0.5, M: 0.5, Large: 1,   XL: 1.5, Campus: 2 }
    },
    'Planning': {
      'Site surveys and/or data gathering':   { OD_XS: 1,    S: 2,    M: 4,    Large: 8,   XL: 16, Campus: 32 },
      'Operational engagement':               { OD_XS: 0.5,  S: 0.5,  M: 0.5,  Large: 0.5, XL: 0.5, Campus: 0.5 },
      'Transformation plan':                  { OD_XS: 0.5,  S: 0.5,  M: 0.5,  Large: 1,   XL: 1,   Campus: 1 },
      'Migration plan(s)':                    { OD_XS: 0.5,  S: 0.5,  M: 0.5,  Large: 1,   XL: 1,   Campus: 1 },
      'Communication towards the site':       { OD_XS: 0.25, S: 0.25, M: 0.25, Large: 0.5, XL: 1,   Campus: 2 }
    },
    'Implement': {
      'Site deployment coordination': { OD_XS: 0.25, S: 0.25, M: 0.5, Large: 1,  XL: 2,  Campus: 4 },
      'Staging':                      { OD_XS: 0.5,  S: 0.5,  M: 1,   Large: 2,  XL: 4,  Campus: 8 },
      'Operational change control':   { OD_XS: 0.5,  S: 0.5,  M: 0.5, Large: 1,  XL: 2,  Campus: 4 },
      'Site migrations':              { OD_XS: 4,    S: 8,    M: 16,  Large: 32, XL: 64, Campus: 128 },
      'HOTO mandatory tasks':         { OD_XS: 2,    S: 4,    M: 8,   Large: 16, XL: 32, Campus: 64 }
    },
    'Closing': {
      'Success notification': { OD_XS: 0.5, S: 0.5, M: 0.5, Large: 1,   XL: 1,   Campus: 1 },
      'Site closure':         { OD_XS: 0.5, S: 0.5, M: 0.5, Large: 0.5, XL: 0.5, Campus: 0.5 }
    },
    'Controls': {
      'Weekly internal transformation update call & report': { OD_XS: 1, S: 1, M: 1, Large: 1, XL: 1, Campus: 1 },
      'Weekly customer transformation progress call':        { OD_XS: 1, S: 1, M: 1, Large: 1, XL: 1, Campus: 1 }
    }
  };

  var STAGE_NAMES = Object.keys(STAGE_HOURS);
  var HOURS_PER_DAY = 8;

  /** Sum stage hours for a tier and convert to man-days per site. */
  function stageMdPerSite(tierKey, stages) {
    var hours = 0;
    (stages || []).forEach(function (stage) {
      var activities = STAGE_HOURS[stage];
      if (!activities) return;
      Object.keys(activities).forEach(function (act) {
        var v = activities[act][tierKey];
        if (typeof v === 'number') hours += v;
      });
    });
    return hours / HOURS_PER_DAY;
  }

  /** Per-activity breakdown, for the "show your working" panel. */
  function stageBreakdown(tierKey, stages) {
    var out = [];
    (stages || []).forEach(function (stage) {
      var activities = STAGE_HOURS[stage];
      if (!activities) return;
      Object.keys(activities).forEach(function (act) {
        var v = activities[act][tierKey];
        if (typeof v === 'number' && v > 0) out.push({ stage: stage, activity: act, hours: v });
      });
    });
    return out;
  }

  /* ------------------------------------------------------------ people --- */

  /* The directory is seeded from assets/dpm-directory.js and then owned by the
     database, so it can be managed from the DPM Directory page without editing
     code. FTEDb replaces this array once it has loaded the stored list. */
  var DPMS = (global.FTE_DPM_SEED || []).map(function (d) {
    return { name: d.name, email: d.email };
  });

  var DPM_ROLES = ['DPM', 'Lead DPM', 'DPM + PM'];

  /* Languages a project may need the DPM/PM to speak. Recorded on the estimate
     for staffing; selecting none means "no specific requirement". */
  var LANGUAGES = [
    'English', 'French', 'Arabic', 'Spanish', 'German', 'Italian',
    'Dutch', 'Portuguese', 'Polish', 'Russian', 'Mandarin', 'Turkish'
  ];

  /* Country list (code/name/lat/lon) for the Country field and the Map tab,
     loaded from assets/countries.js just before this file. */
  var COUNTRIES = (global.FTE_COUNTRIES || []).slice();
  var COUNTRY_BY_CODE = {};
  COUNTRIES.forEach(function (c) { COUNTRY_BY_CODE[c.code] = c; });
  function countryName(code) { var c = COUNTRY_BY_CODE[code]; return c ? c.name : (code || ''); }
  function country(code) { return COUNTRY_BY_CODE[code] || null; }

  /* --------------------------------------------------------- defaults --- */

  var DEFAULT_SETTINGS = {
    capacityMdPerMonth: 18,   // productive man-days one full-time DPM delivers per month
    defaultComplexity: 100,   // percent
    migrationMdPerSite: 0.5,  // uplift applied per site when WAN migration support is in scope
    oobhUpliftPct: 15,        // % added to the effort when out-of-business-hours work is in scope
    dateDaysPerMonth: 30.44,  // average calendar month, used to convert a date range to months
    emailTo: '',              // default recipient for the result email (blank = fill in Outlook)
    emailCc: 'karim.elzarka.ext@orange.com',
    emailSubject: 'DPM FTE Estimate - {project}',  // {project} is replaced with the project name
    teamCapacityFte: null,    // DPMs available for the team plan (null = size of the DPM Directory)
    userName: '',             // who is using this browser - stamped as "created by" on estimates
    userEmail: '',
    identityAsked: false      // the one-time "who are you?" question has been shown
  };

  /* ------------------------------------------------------- team folder --- */

  /* The SharePoint folder the whole team saves into. Everyone's app links to
     its synced copy on their own PC, and OneDrive uploads each estimate. The
     link opens only for people the folder is shared with. */
  var TEAM_FOLDER = {
    name: 'FTE - Website',
    url: 'https://orange0-my.sharepoint.com/:f:/r/personal/ahmed_elbourgy_ext_orange_com/Documents/FTE%20-%20Website?d=w2cc15d09b7054e0f9191e741d90e0c3f&csf=1&web=1&e=aJtbL9',
    owner: 'Ahmed Elbourgy'
  };

  /* The folder's plain SharePoint address (no sharing wrapper), which is how
     OneDrive identifies the synced copy on each PC:
     https://host/:f:/r/personal/x/Documents/FTE%20-%20Website?...
       -> https://host/personal/x/Documents/FTE%20-%20Website */
  function teamFolderWebPath() {
    var m = /^(https:\/\/[^/]+)(?:\/:[a-z]:\/[a-z])?(\/[^?#]*)/i.exec(TEAM_FOLDER.url);
    return m ? m[1] + m[2] : '';
  }

  /* ---------------------------------------------------- project folders --- */

  /* Every estimate is filed in a folder named after its project, next to an
     Excel workbook named "<project> - <who did it>.xlsx". These two functions
     are the only place those names are decided; the launcher only checks them.
     Characters Windows forbids become spaces, runs of spaces collapse, and a
     name Windows reserves ("CON", "NUL"...) or one the app uses for its own
     folders gets a suffix, so any project name maps to one valid folder. */
  var APP_FOLDERS = ['records', 'projects'];

  function safeItemName(s, fallback, max) {
    var out = String(s === null || s === undefined ? '' : s)
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ').trim();
    if (out.length > max) out = out.slice(0, max).trim();
    out = out.replace(/[. ]+$/, '');
    if (!out) out = fallback;
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(out)) out += ' (1)';
    return out;
  }

  function projectFolderName(projectName) {
    var name = safeItemName(projectName, 'Untitled project', 80);
    if (APP_FOLDERS.indexOf(name.toLowerCase()) >= 0) name += ' (project)';
    return name;
  }

  /** "Cairo WAN Rollout - Ahmed Elbourgy.xlsx" */
  function projectWorkbookName(projectName, person) {
    var who = person ? (person.name || person.email) : '';
    return safeItemName(projectFolderName(projectName) + ' - ' + safeItemName(who, 'Unknown', 60), 'Estimate', 140) + '.xlsx';
  }

  /* "ahmed.elbourgy.ext@orange.com" -> "Ahmed Elbourgy", for anyone who is
     not in the DPM Directory. */
  function nameFromEmail(email) {
    var local = String(email || '').split('@')[0].replace(/[._-](ext|external|adm)$/i, '');
    return local.split(/[._-]+/).filter(Boolean).map(function (w) {
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    }).join(' ');
  }

  /* ------------------------------------------- explanatory copy (help) --- */

  /* Tooltip text keyed by a short id, rendered by ui.js next to labels and
     table headers. Written for someone who has never seen the model before. */
  var HELP = {
    projectName:  'Free text label for this estimate. Appears on the dashboard, in the records list and at the top of every export.',
    projectCode:  'Automatically generated identifier, e.g. DPM-QWER-8F2A. It is created once and never changes, so every calculation and export for this project can be traced back to it.',
    status:       'Active or Inactive. It never changes the calculated effort, but it decides whether the project counts on the Team capacity plan: inactive projects are left out unless you choose to include them.',
    startMonth:   'The month the project starts. It does not change the FTE - it places the project on the Team capacity plan, so its month-by-month effort lands in the right calendar months. With a start/end date, the start date is used instead.',
    importSites:  'Build the allocation rows from a spreadsheet instead of typing them. Upload an .xlsx or .csv with one row per site (or per group of sites with a count). WAN needs a product and a connectivity mode per row; LAN needs a device count or a tier. You map the columns and see a preview before anything changes. Download the template for the expected layout.',
    teamCapacity: 'How many full-time DPMs are available for these projects. Monthly demand above this line means the team is overbooked that month. Leave it blank to use the number of people in the DPM Directory.',
    sharedFolder: 'Point everyone at the same folder - a SharePoint or Teams document library synced to each PC through OneDrive - and every estimate saved by anyone lands in one place. The Team capacity page then plans across the whole team, not just your own estimates. Each person sets this once on their own PC.',
    teamFolder:   'The SharePoint folder the team saves into. First sync it to your PC: open the link and choose "Add shortcut to My files". With Start FTE Calculator.cmd the app then finds it and links it by itself; in Chrome or Edge press "Connect the team folder" and pick it; other browsers cannot save into it. OneDrive uploads every estimate to SharePoint within seconds, and everyone who has the folder sees the same estimates and the same Team capacity plan.',
    you:          'Your name and email are stamped on every estimate you create, as "Created by", so the team can see whose estimate is whose. With the launcher they are read from your OneDrive work account; otherwise set them here once.',
    createdBy:    'The person who created this estimate. Later changes to its notes or start month record who made them, too.',
    pmRole:       'Records whether the DPM is also acting as Project Manager. Recorded only - it does not change the calculated effort.',
    duration:     'How long the project runs, in months. Total effort is spread evenly across this period, so a longer duration lowers the FTE requirement for the same amount of work.',
    durationDates:'Choose a start and end date and the duration is derived from it, using an average month of 30.44 days. Fractional months are kept - they are not rounded away.',
    distribution:'How the man-days are spread across the months. Flat spreads them evenly - the simple baseline. Bell curve spreads them as a normal distribution: effort ramps up to a peak in the middle of the project and back down, which is closer to how a real rollout behaves. The total effort and the average FTE are the same either way; the bell curve adds the PEAK FTE - the larger team the busiest mid-project month needs - and lets you picture the project shape.',
    notes:'Free text for anything worth recording alongside the estimate - assumptions made, scope caveats, a message to the reviewer. You can type or change them before or after calculating. They are saved with the record and appear in the Excel export and the email, but they never change any calculated figure.',
    emailResult:'Opens a ready-to-review email in Outlook with a table of the project name, man-days and FTE. When the app is started with the launcher it uses Outlook directly (with a formatted table); otherwise it opens your default mail app with a plain-text version. Recipients and subject come from Settings. The email is never sent automatically - you review and send it.',
    compareScenarios:'Snapshots the current form as a scenario and adds it to the side-by-side comparison below, without saving anything to the data folder. Change a condition - complexity, mode, flat or bell curve, migration, duration, capacity, the allocation - and add another to see how the effort and FTE differ. When one is right, use its Save button to file it as the estimate.',
    totalSites:   'The number of sites in the whole project. Your allocation rows must add up to exactly this number before the estimate will run - that check is what stops sites being double-counted or forgotten.',
    projectType:  'Overlay, Underlay or Both. Recorded for reporting only - it does not change the calculated effort.',
    migration:    'When migration support is in scope, an extra 0.5 man-days per site is added on top of the product effort, covering cut-over coordination and rollback readiness.',
    outOfHours:   'Whether the work must happen outside normal business hours (nights/weekends). "Yes" adds an effort uplift (set in Settings, default 15%) on top of the base effort, for the extra coordination and unsocial-hours overhead. "No" and "Not known" add nothing.',
    oobhUplift:   'The percentage added to an estimate when "Out of business hours" is set to Yes. Applied to the base effort (plus any WAN migration uplift). Set to 0 to record out-of-hours work without changing the effort.',
    country:      'The country where the project HQ is. Recorded on the estimate and used to place it on the Project map. It does not change the calculated effort.',
    languages:    'Languages the assigned DPM or PM needs to speak for this project. Recorded for staffing and shown in exports and on the map; it does not change the effort. Select none for no specific requirement.',
    abacos:       'Records whether ABACOS applies. Recorded only - it does not change the calculated effort.',
    flan:         'Records whether FLAN is used. Recorded only - it does not change the calculated effort.',
    routers:      'Device count used only when you have not entered any tier rows. It selects a single fallback tier for the whole project. If you add tier rows, this value is ignored.',
    calcMode:     'Standard uses the published rate card. Non-standard replaces the rate with a value you type per row, for work the rate card does not cover. By Stage (LAN only) builds the rate from the delivery stages you select.',
    stages:       'Select the delivery stages in scope. The effort for a site becomes the sum of the hours of every activity in the selected stages, divided by 8 to convert hours to man-days.',
    complexity:   'A percentage multiplier on the base rate. 100% means the standard rate. Use above 100% for sites that are harder than typical (difficult access, language, out-of-hours work), below 100% for simpler ones.',
    override:     'Replaces the rate card figure for this row with your own man-days per site. Only available in Non-standard mode.',
    baseRate:     'Man-days of DPM effort for one site, taken from the rate card for the chosen product and connectivity mode.',
    sitesRow:     'How many sites of the whole project this row covers.',
    rowMd:        'Effort for this row: base rate x complexity x sites.',
    pctOfTotal:   'This row as a share of the total project effort.',
    capacity:     'Productive man-days one full-time DPM delivers in a month, after leave, training, public holidays and non-project overhead. This single number scales the whole FTE result - raising it lowers the FTE needed.',
    totalMd:      'Total man-days of DPM effort for the entire project.',
    mdPerMonth:   'Total man-days divided by the project duration - the sustained monthly workload.',
    fte:          'Full-Time Equivalent: monthly workload divided by one DPM\'s monthly capacity. 2.34 FTE means the work needs about two and a third full-time people.',
    headcount:    'FTE rounded up to a whole number of people, because you cannot staff a third of a person.',
    utilisation:  'FTE divided by headcount. Low utilisation means the last person is only partly loaded and may have spare capacity for other work.',
    peakFte:      'The FTE needed in the busiest month, rather than the average. This is the realistic staffing level - you have to cover the peak, not the average. Only shown when the bell-curve distribution is used.',
    peakHeadcount:'The busiest month\'s FTE rounded up to whole people. The maximum team size the bell curve demands at its mid-project peak.',
    dpmAssign:    'Who is assigned to the project. Recorded on the estimate and included in exports - it does not change the calculated effort. On the Team capacity page the project\'s monthly demand is shared equally between the people assigned, which is how overbooked DPMs are spotted.'
  };

  /* Terms that appear in the interface and in exports. */
  var GLOSSARY = [
    { term: 'MD - Man-Day',     meaning: 'One person working for one full day. The unit all effort in this tool is expressed in.' },
    { term: 'FTE',             meaning: 'Full-Time Equivalent. The number of full-time people needed to carry the monthly workload. Calculated as man-days per month divided by monthly capacity.' },
    { term: 'HC - Headcount',   meaning: 'FTE rounded up to whole people. 2.34 FTE means 3 headcount.' },
    { term: 'Utilisation',      meaning: 'FTE divided by headcount, as a percentage. Shows how fully the rounded-up team is loaded.' },
    { term: 'LoE - Level of Effort', meaning: 'The base man-days per site published in the rate card for a given product, connectivity mode or LAN tier.' },
    { term: 'Complexity %',     meaning: 'A multiplier on the base rate for a group of sites. 100% is standard; 150% means those sites take half as long again.' },
    { term: 'Capacity',         meaning: 'Productive man-days one DPM delivers per month after leave, training and overhead. Default 18.' },
    { term: 'Tier',             meaning: 'LAN sites are grouped by device count into OD/XS, S, M, Large, XL and Campus. Each tier carries its own base effort.' },
    { term: 'Overlay',          meaning: 'Deploying the new network service on top of the existing infrastructure.' },
    { term: 'Underlay',         meaning: 'Work on the underlying transport or physical connectivity beneath the service.' },
    { term: 'CPE',              meaning: 'Customer Premises Equipment - the router or appliance installed at the site.' },
    { term: 'vEdge',            meaning: 'The SD-WAN edge appliance. Single vEdge means one device; Dual vEdge means a resilient pair.' },
    { term: 'Continuity',       meaning: 'A resilient design with a second CPE or link so the site stays connected if one path fails.' },
    { term: 'Air Backup',       meaning: 'A wireless (cellular) backup path used when the primary access fails.' },
    { term: 'Always-On',        meaning: 'A backup path kept permanently active rather than standing by.' },
    { term: 'ABACOS',           meaning: 'Ordering and provisioning system flag. Recorded on the estimate; it does not change the calculated effort.' },
    { term: 'FLAN',             meaning: 'Flexible LAN offer flag. Recorded on the estimate; it does not change the calculated effort.' },
    { term: 'HOTO',             meaning: 'Hand-Over To Operations - the mandatory tasks that transfer a delivered site to the run teams.' },
    { term: 'Staging',          meaning: 'Preparing and pre-configuring equipment before it ships to the site.' },
    { term: 'Migration support', meaning: 'Cut-over coordination and rollback readiness when moving a site from an old service to the new one. Adds 0.5 MD per site.' }
  ];

  /* Fields deliberately recorded but excluded from the arithmetic, so the
     interface can badge them consistently rather than silently ignoring them. */
  var INFORMATIONAL_FIELDS = ['Project Type', 'ABACOS', 'FLAN', 'DPM acting as PM', 'Project Status'];

  /* Called by FTEDb once the stored directory is available. Everything reads
     FTEData.DPMS, so swapping the contents in place keeps every existing
     reference valid without a reload. */
  function setDpms(list) {
    DPMS.length = 0;
    (list || []).forEach(function (d) { DPMS.push({ name: d.name, email: d.email }); });
    DPMS.sort(function (a, b) { return a.name.localeCompare(b.name); });
    return DPMS;
  }

  function seedDpms() {
    return (global.FTE_DPM_SEED || []).map(function (d) {
      return { name: d.name, email: d.email };
    });
  }

  global.FTEData = {
    APP_VERSION: APP_VERSION,
    RELEASES: RELEASES,
    FOLDER_MIN_VERSION: FOLDER_MIN_VERSION,
    compareVersions: compareVersions,
    setDpms: setDpms,
    seedDpms: seedDpms,
    PRODUCTS: PRODUCTS,
    CONNECTIVITY_MODES: CONNECTIVITY_MODES,
    BASE_MD: BASE_MD,
    lookupBaseMd: lookupBaseMd,
    LAN_TIERS: LAN_TIERS,
    LAN_TIER_LABELS: LAN_TIER_LABELS,
    tierByLabel: tierByLabel,
    tierByName: tierByName,
    tierForDeviceCount: tierForDeviceCount,
    STAGE_HOURS: STAGE_HOURS,
    STAGE_NAMES: STAGE_NAMES,
    HOURS_PER_DAY: HOURS_PER_DAY,
    stageMdPerSite: stageMdPerSite,
    stageBreakdown: stageBreakdown,
    DPMS: DPMS,
    DPM_ROLES: DPM_ROLES,
    LANGUAGES: LANGUAGES,
    COUNTRIES: COUNTRIES,
    countryName: countryName,
    country: country,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    TEAM_FOLDER: TEAM_FOLDER,
    teamFolderWebPath: teamFolderWebPath,
    nameFromEmail: nameFromEmail,
    projectFolderName: projectFolderName,
    projectWorkbookName: projectWorkbookName,
    HELP: HELP,
    GLOSSARY: GLOSSARY,
    INFORMATIONAL_FIELDS: INFORMATIONAL_FIELDS
  };
})(window);
