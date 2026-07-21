/* ===========================================================================
   data.js - domain reference data and all user-facing explanatory copy.
   No DOM access, no side effects. Everything here is the "rate card".
   =========================================================================== */
(function (global) {
  'use strict';

  var APP_VERSION = '2.0.0';

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

  /* --------------------------------------------------------- defaults --- */

  var DEFAULT_SETTINGS = {
    capacityMdPerMonth: 18,   // productive man-days one full-time DPM delivers per month
    defaultComplexity: 100,   // percent
    migrationMdPerSite: 0.5,  // uplift applied per site when WAN migration support is in scope
    dateDaysPerMonth: 30.44   // average calendar month, used to convert a date range to months
  };

  /* ------------------------------------------- explanatory copy (help) --- */

  /* Tooltip text keyed by a short id, rendered by ui.js next to labels and
     table headers. Written for someone who has never seen the model before. */
  var HELP = {
    projectName:  'Free text label for this estimate. Appears on the dashboard, in the records list and at the top of every export.',
    projectCode:  'Automatically generated identifier, e.g. DPM-QWER-8F2A. It is created once and never changes, so every calculation and export for this project can be traced back to it.',
    status:       'Active or Inactive. Recorded for reporting and filtering only - it does not change the calculated effort.',
    pmRole:       'Records whether the DPM is also acting as Project Manager. Recorded only - it does not change the calculated effort.',
    duration:     'How long the project runs, in months. Total effort is spread evenly across this period, so a longer duration lowers the FTE requirement for the same amount of work.',
    durationDates:'Choose a start and end date and the duration is derived from it, using an average month of 30.44 days. Fractional months are kept - they are not rounded away.',
    totalSites:   'The number of sites in the whole project. Your allocation rows must add up to exactly this number before the estimate will run - that check is what stops sites being double-counted or forgotten.',
    projectType:  'Overlay, Underlay or Both. Recorded for reporting only - it does not change the calculated effort.',
    migration:    'When migration support is in scope, an extra 0.5 man-days per site is added on top of the product effort, covering cut-over coordination and rollback readiness.',
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
    dpmAssign:    'Who is assigned to the project. Recorded on the estimate and included in exports - it does not change the calculated effort.'
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
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    HELP: HELP,
    GLOSSARY: GLOSSARY,
    INFORMATIONAL_FIELDS: INFORMATIONAL_FIELDS
  };
})(window);
