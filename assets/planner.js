/* ===========================================================================
   planner.js - team capacity planning.

   Every estimate already carries a month-by-month effort curve. Placed on the
   calendar from its start month and added up across projects, those curves
   say how many DPMs the whole portfolio needs each month - and, split across
   the people assigned, who is overbooked when.

   Rules, kept deliberately simple so the numbers can be explained:
     - one estimate per project and type: the most recent calculation wins
       (earlier ones are history, not extra work);
     - inactive projects are left out unless asked for;
     - demand in a month = that month's man-days / the capacity the estimate
       was calculated with, i.e. the FTE the month consumes;
     - a project's demand is shared equally between its assigned DPMs.

   Pure functions, no DOM.
   =========================================================================== */
(function (global) {
  'use strict';

  var MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var EPS = 1e-9;

  /* ------------------------------------------------------------ months --- */

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  /** 'YYYY-MM' from 'YYYY-MM' or 'YYYY-MM-DD'; null when unusable. */
  function toMonthKey(v) {
    var m = /^(\d{4})-(\d{1,2})/.exec(String(v || ''));
    if (!m) return null;
    var y = +m[1], mo = +m[2];
    if (mo < 1 || mo > 12 || y < 1990 || y > 2200) return null;
    return y + '-' + pad(mo);
  }

  function monthIndex(key) { return (+key.slice(0, 4)) * 12 + (+key.slice(5, 7) - 1); }

  function fromIndex(idx) { return Math.floor(idx / 12) + '-' + pad((idx % 12) + 1); }

  function addMonths(key, n) { return fromIndex(monthIndex(key) + n); }

  function monthLabel(key) {
    if (!key) return '—';
    return MONTH_NAMES[+key.slice(5, 7) - 1] + ' ' + key.slice(0, 4);
  }

  function currentMonthKey(now) {
    var d = now || new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1);
  }

  /* ---------------------------------------------------------- projects --- */

  function isShaped(r) { return !!(r && (r.usingBell || r.usingSchedule)); }

  /* Start month: the planned start typed on the estimate, or - for a date
     driven duration - the month of its start date. Anything else has not
     been scheduled yet. */
  function startMonthOf(rec) {
    var i = (rec && rec.inputs) || {};
    return toMonthKey(i.startMonth) || (i.durationSource === 'dates' ? toMonthKey(i.startDate) : null);
  }

  /* A project is identified by its name, per type. Codes cannot be trusted
     for this: before version 2.1 each page load minted a fresh code, so one
     project may carry several, and a re-estimate would then count twice.
     Untitled estimates fall back to their code so they never merge. */
  function projectKey(rec) {
    var name = String(rec.projectName || '').trim().toLowerCase().replace(/\s+/g, ' ');
    var id = (!name || /^untitled (wan|lan) project$/.test(name))
      ? 'code:' + (rec.projectCode || rec.id)
      : 'name:' + name;
    return id + '|' + rec.type;
  }

  function usable(rec) {
    return rec && rec.id && rec.results && rec.inputs && Array.isArray(rec.results.monthly);
  }

  /** Newest estimate per project and type, plus how many older ones were set aside. */
  function latestPerProject(records) {
    var byKey = {}, superseded = 0;
    (records || []).forEach(function (r) {
      if (!usable(r)) return;
      var k = projectKey(r);
      var cur = byKey[k];
      if (!cur) { byKey[k] = r; return; }
      superseded++;
      if ((r.savedAt || '') > (cur.savedAt || '')) byKey[k] = r;
    });
    return { list: Object.keys(byKey).map(function (k) { return byKey[k]; }), superseded: superseded };
  }

  function personKey(d) {
    return String(d.email || d.name || '').trim().toLowerCase();
  }

  /* The same person listed twice (an email in two letter cases) must still
     take the whole share, not leave half of it counted against nobody. */
  function uniquePeople(list) {
    var seen = {};
    return (list || []).filter(function (d) {
      var k = d ? personKey(d) : '';
      if (!k || seen[k]) return false;
      seen[k] = true;
      return true;
    });
  }

  /* ----------------------------------------------------------- compute --- */

  /**
   * opts: { start: 'YYYY-MM', horizon: months, capacity: FTE,
   *         includeInactive: bool, directory: [{name, email}] }
   */
  function compute(records, opts) {
    opts = opts || {};
    var horizon = Math.max(1, Math.min(60, Math.round(opts.horizon || 12)));
    var start = toMonthKey(opts.start) || currentMonthKey();
    var startIdx = monthIndex(start);
    var capacity = opts.capacity > 0 ? Number(opts.capacity) : 0;

    var months = [];
    for (var m = 0; m < horizon; m++) months.push(addMonths(start, m));

    function zeros() { return months.map(function () { return 0; }); }

    var latest = latestPerProject(records);
    var projects = [], inactiveExcluded = 0;

    latest.list.forEach(function (rec) {
      var active = (rec.status || 'Active') !== 'Inactive';
      if (!active && !opts.includeInactive) { inactiveExcluded++; return; }

      var r = rec.results, i = rec.inputs;
      var cap = Number(i.capacityMdPerMonth) > 0 ? Number(i.capacityMdPerMonth) : 18;
      var monthly = r.monthly || [];
      var startKey = startMonthOf(rec);
      var series = zeros();
      var state = 'unscheduled', endKey = null;

      if (startKey) {
        var offset = monthIndex(startKey) - startIdx;
        monthly.forEach(function (bucket, n) {
          var idx = offset + ((bucket.month || (n + 1)) - 1);
          if (idx >= 0 && idx < horizon) series[idx] += (Number(bucket.md) || 0) / cap;
        });
        var span = Math.max(1, monthly.length);
        endKey = addMonths(startKey, span - 1);
        if (offset + span - 1 < 0) state = 'ended';
        else if (offset >= horizon) state = 'later';
        else state = 'current';
      }

      var windowMd = series.reduce(function (t, v) { return t + v; }, 0) * cap;
      projects.push({
        id: rec.id,
        record: rec,
        key: projectKey(rec),
        name: rec.projectName || 'Untitled',
        code: rec.projectCode || '',
        type: rec.type,
        status: rec.status || 'Active',
        active: active,
        start: startKey,
        end: endKey,
        state: state,
        months: Number(i.months) || monthly.length,
        distribution: isShaped(r) ? 'bell' : 'flat',
        totalMd: Number(r.totalMd) || 0,
        fte: Number(r.fte) || 0,
        peakFte: isShaped(r) ? (Number(r.peakFte) || 0) : (Number(r.fte) || 0),
        capacityMd: cap,
        dpms: uniquePeople(rec.dpms),
        savedAt: rec.savedAt,
        series: series,
        windowMd: windowMd,
        windowPeak: series.reduce(function (mx, v) { return Math.max(mx, v); }, 0)
      });
    });

    /* ---- totals ---- */
    var demand = zeros(), unassigned = zeros();
    projects.forEach(function (p) {
      p.series.forEach(function (v, idx) {
        demand[idx] += v;
        if (!p.dpms.length) unassigned[idx] += v;
      });
    });

    var peakIdx = 0;
    demand.forEach(function (v, idx) { if (v > demand[peakIdx] + EPS) peakIdx = idx; });
    var overbooked = capacity > 0
      ? demand.map(function (v) { return v > capacity + EPS; })
      : demand.map(function () { return false; });
    var avgDemand = demand.reduce(function (t, v) { return t + v; }, 0) / horizon;

    /* ---- people ---- */
    var people = {}, peopleOrder = [];
    function person(d, inDirectory) {
      var k = personKey(d);
      if (!k) return null;
      if (!people[k]) {
        people[k] = { key: k, name: d.name || d.email, email: d.email || '', inDirectory: !!inDirectory,
                      load: zeros(), projects: [] };
        peopleOrder.push(k);
      } else if (inDirectory) {
        people[k].inDirectory = true;
      }
      return people[k];
    }
    (opts.directory || []).forEach(function (d) { person(d, true); });

    projects.forEach(function (p) {
      if (!p.dpms.length) return;
      var share = 1 / p.dpms.length;   // already de-duplicated
      p.dpms.forEach(function (d) {
        var who = person(d, false);
        if (!who) return;
        p.series.forEach(function (v, idx) { who.load[idx] += v * share; });
        who.projects.push({ name: p.name, type: p.type, code: p.code, share: share, role: d.role || 'DPM',
                            inWindow: p.windowMd > EPS });
      });
    });

    var peopleList = peopleOrder.map(function (k) {
      var pr = people[k];
      pr.peak = pr.load.reduce(function (mx, v) { return Math.max(mx, v); }, 0);
      pr.total = pr.load.reduce(function (t, v) { return t + v; }, 0);
      pr.overMonths = pr.load.filter(function (v) { return v > 1 + EPS; }).length;
      return pr;
    });
    peopleList.sort(function (a, b) { return b.peak - a.peak || a.name.localeCompare(b.name); });

    var stateOrder = { unscheduled: 0, current: 1, later: 2, ended: 3 };
    projects.sort(function (a, b) {
      return (stateOrder[a.state] - stateOrder[b.state]) ||
             String(a.start || '').localeCompare(String(b.start || '')) ||
             a.name.localeCompare(b.name);
    });

    return {
      start: start,
      horizon: horizon,
      months: months,
      labels: months.map(monthLabel),
      capacity: capacity,
      projects: projects,
      demand: demand,
      unassigned: unassigned,
      overbooked: overbooked,
      overbookedCount: overbooked.filter(Boolean).length,
      peak: { index: peakIdx, month: months[peakIdx], fte: demand[peakIdx] },
      avgDemand: avgDemand,
      avgLoadPct: capacity > 0 ? (avgDemand / capacity) * 100 : null,
      people: peopleList,
      counts: {
        estimates: (records || []).filter(usable).length,
        projects: projects.length,
        inWindow: projects.filter(function (p) { return p.windowMd > EPS; }).length,
        unscheduled: projects.filter(function (p) { return p.state === 'unscheduled'; }).length,
        superseded: latest.superseded,
        inactiveExcluded: inactiveExcluded,
        overbookedPeople: peopleList.filter(function (p) { return p.overMonths > 0; }).length
      }
    };
  }

  global.FTEPlanner = {
    compute: compute,
    toMonthKey: toMonthKey,
    addMonths: addMonths,
    monthLabel: monthLabel,
    currentMonthKey: currentMonthKey,
    startMonthOf: startMonthOf,
    latestPerProject: latestPerProject
  };
})(window);
