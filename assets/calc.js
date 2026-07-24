/* ===========================================================================
   calc.js - the estimation engine.

   Pure functions: no DOM, no storage, no globals mutated. Everything the
   result depends on arrives as an argument, and everything needed to explain
   or reproduce the result comes back inside the returned object. That is what
   lets exports read from the snapshot instead of re-reading live form fields.
   =========================================================================== */
(function (global) {
  'use strict';

  var D = global.FTEData;

  /* --------------------------------------------------------- utilities --- */

  function num(v, fallback) {
    var n = parseFloat(v);
    return isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
  }

  function round(n, dp) {
    var f = Math.pow(10, dp === undefined ? 3 : dp);
    return Math.round((n + Number.EPSILON) * f) / f;
  }

  /* Parse a delivery schedule typed by the user: how many sites are done in
     each month. Accepts commas, spaces, semicolons or newlines as separators.
     Returns an array of numbers (NaN entries are kept so the caller can reject
     non-numeric input rather than silently dropping it). */
  function parseSchedule(raw) {
    var parts;
    if (Array.isArray(raw)) {
      parts = raw;
    } else if (typeof raw === 'string') {
      var t = raw.trim();
      if (!t) return [];
      parts = t.split(/[\s,;]+/).filter(function (x) { return x !== ''; });
    } else {
      return [];
    }
    return parts.map(function (x) { return num(x, NaN); });
  }

  /* Effort spread across the calendar.

     With no schedule the effort is level: the duration may be fractional
     (6.4 months from a date range), so we allocate one bucket per started month
     and give the final partial month only its fractional share, which keeps the
     buckets summing back to the total.

     With a schedule the effort is phased in proportion to the sites delivered
     each month - the realistic ramp-up/ramp-down the user asked for. Each entry
     is one whole month; total effort is unchanged, only its shape. */
  function distributeMonthly(totalMd, months, capacity, schedule) {
    if (schedule && schedule.length) {
      var sum = 0;
      schedule.forEach(function (s) { if (s > 0) sum += s; });
      if (sum > 0) {
        return schedule.map(function (sites, i) {
          var s = sites > 0 ? sites : 0;
          var md = totalMd * (s / sum);
          return {
            month: i + 1,
            sites: s,
            span: 1,
            md: round(md, 3),
            fte: round(md / capacity, 3),
            partial: false,
            scheduled: true
          };
        });
      }
    }

    var buckets = Math.max(1, Math.ceil(months - 1e-9));
    var ratePerMonth = totalMd / months;
    var out = [];
    var remaining = months;
    for (var i = 0; i < buckets; i++) {
      var span = Math.min(1, remaining);
      out.push({
        month: i + 1,
        span: round(span, 3),
        md: round(ratePerMonth * span, 3),
        fte: round((ratePerMonth * span) / (span * capacity), 3),
        partial: span < 0.999,
        scheduled: false
      });
      remaining -= span;
    }
    return out;
  }

  /** Duration in months between two ISO dates, keeping the fraction. */
  function monthsBetween(startIso, endIso, daysPerMonth) {
    if (!startIso || !endIso) return null;
    var a = new Date(startIso), b = new Date(endIso);
    if (isNaN(a) || isNaN(b)) return null;
    var ms = b - a;
    if (ms <= 0) return null;
    return ms / (1000 * 60 * 60 * 24 * (daysPerMonth || 30.44));
  }

  /* Stable identifiers.

     The old build regenerated the project code from Date.now() on every save
     and again on every export, so a project's "identifier" changed each time
     it was written and never matched between a saved file and its workbook.
     These are generated once by the caller and then stored on the record. */
  function makeProjectCode(name) {
    var initials = String(name || 'PROJ').trim().split(/\s+/)
      .map(function (w) { return (w[0] || '').toUpperCase(); })
      .join('').replace(/[^A-Z0-9]/g, '').slice(0, 4) || 'PROJ';
    var suffix = '';
    for (var i = 0; i < 4; i++) {
      suffix += 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)];
    }
    return 'DPM-' + initials + '-' + suffix;
  }

  function makeRecordId(date) {
    var d = date || new Date();
    function p(n, w) { return String(n).padStart(w || 2, '0'); }
    var stamp = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
                p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    var rand = '';
    for (var i = 0; i < 4; i++) {
      rand += 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)];
    }
    return 'FTE-' + stamp + '-' + rand;
  }

  /* Soft checks on a delivery schedule. These never block the estimate - the
     schedule is a planning aid, not a correctness constraint - but the user
     should be told when it does not line up with the project. Returns false
     only when the schedule carries no sites at all, in which case the level
     spread is used instead. */
  function validateSchedule(schedule, totalSites, months, warnings) {
    var sum = schedule.reduce(function (t, n) { return t + (n > 0 ? n : 0); }, 0);
    if (sum <= 0) return false;
    if (Math.abs(sum - totalSites) > 1e-9) {
      warnings.push('The delivery schedule adds up to ' + round(sum, 2) + ' sites but the project has ' +
        round(totalSites, 2) + '. Effort was phased using the schedule’s proportions.');
    }
    var expected = Math.max(1, Math.round(months));
    if (schedule.length !== expected) {
      warnings.push('The delivery schedule covers ' + schedule.length + ' month(s), while the duration is ' +
        round(months, 2) + ' month(s). The schedule was used for the monthly phasing.');
    }
    return true;
  }

  /* ------------------------------------------------- shared final maths --- */

  /* Everything downstream of "we know the total man-days" is identical for
     WAN and LAN, so it lives in one place and is explained in one place.

     The headline FTE stays the *average* - total effort levelled across the
     duration - and never changes just because a delivery schedule was entered.
     A schedule adds a second, separate figure: the PEAK FTE, the team size the
     busiest month actually needs. With no schedule the peak equals the average,
     so the extra figure only appears when it tells you something new. */
  function finalise(totalMd, months, capacity, steps, opts) {
    opts = opts || {};
    var monthly = distributeMonthly(totalMd, months, capacity, opts.schedule);
    var usingSchedule = monthly.length > 0 && monthly[0].scheduled === true;

    var mdPerMonth = totalMd / months;
    var fte = mdPerMonth / capacity;
    var headcount = Math.ceil(fte - 1e-9);
    var utilisation = headcount > 0 ? (fte / headcount) * 100 : 0;

    /* Sustained load of the busiest month (md / span normalises the final
       partial month of the level case, so the flat peak equals the average). */
    var peakMd = 0, peakMonth = 1;
    monthly.forEach(function (m) {
      var sustained = m.md / (m.span || 1);
      if (sustained > peakMd + 1e-9) { peakMd = sustained; peakMonth = m.month; }
    });
    var peakFte = peakMd / capacity;
    var peakHeadcount = Math.ceil(peakFte - 1e-9);
    var peakUtil = peakHeadcount > 0 ? (peakFte / peakHeadcount) * 100 : 0;

    steps.push({
      label: usingSchedule ? 'Average across the duration' : 'Spread across the duration',
      formula: round(totalMd, 3) + ' MD / ' + round(months, 2) + ' months',
      value: round(mdPerMonth, 3) + ' MD per month'
    });
    steps.push({
      label: 'Convert to full-time people',
      formula: round(mdPerMonth, 3) + ' MD per month / ' + capacity + ' MD capacity per DPM per month',
      value: round(fte, 3) + ' FTE'
    });
    steps.push({
      label: 'Round up to whole people',
      formula: 'ceil(' + round(fte, 3) + ')',
      value: headcount + ' headcount'
    });
    steps.push({
      label: 'Resulting utilisation',
      formula: round(fte, 3) + ' FTE / ' + headcount + ' headcount',
      value: round(utilisation, 1) + '%'
    });

    if (usingSchedule) {
      steps.push({
        label: 'Busiest month (from the delivery schedule)',
        formula: 'peak monthly effort, in month ' + peakMonth,
        value: round(peakMd, 3) + ' MD'
      });
      steps.push({
        label: 'Peak FTE to staff the busiest month',
        formula: round(peakMd, 3) + ' MD / ' + capacity + ' MD capacity per DPM per month',
        value: round(peakFte, 3) + ' FTE (' + peakHeadcount + ' headcount)'
      });
    }

    return {
      totalMd: round(totalMd, 3),
      mdPerMonth: round(mdPerMonth, 3),
      fte: round(fte, 3),
      headcount: headcount,
      utilisationPct: round(utilisation, 1),
      monthly: monthly,
      usingSchedule: usingSchedule,
      peakMd: round(peakMd, 3),
      peakFte: round(peakFte, 3),
      peakHeadcount: peakHeadcount,
      peakUtilisationPct: round(peakUtil, 1),
      peakMonth: peakMonth
    };
  }

  function withShares(rows, totalMd) {
    rows.forEach(function (r) {
      r.pctOfTotal = totalMd > 0 ? round((r.md / totalMd) * 100, 1) : 0;
    });
    return rows;
  }

  /* ------------------------------------------------------------- WAN ----- */

  function calculateWan(input, settings) {
    var s = Object.assign({}, D.DEFAULT_SETTINGS, settings || {});
    var errors = [], warnings = [], steps = [];

    var months     = num(input.months);
    var totalSites = num(input.totalSites);
    var capacity   = num(s.capacityMdPerMonth, 18);
    var mode       = input.mode || 'Standard';
    var migration  = input.migration === 'Yes';
    var allocation = input.allocation || [];
    var schedule   = parseSchedule(input.schedule);
    var useSchedule = schedule.length > 0;

    if (!(months > 0))     errors.push({ field: 'w-months', message: 'Enter a project duration greater than zero.' });
    if (!(totalSites > 0)) errors.push({ field: 'w-sites',  message: 'Total sites must be greater than zero.' });
    if (!(capacity > 0))   errors.push({ field: 'set-capacity', message: 'Monthly capacity must be greater than zero.' });
    if (!allocation.length) {
      errors.push({ field: 'w-alloc', message: 'Add at least one product allocation row.' });
    }
    if (useSchedule && schedule.some(function (n) { return isNaN(n); })) {
      errors.push({ field: 'w-schedule', message: 'The delivery schedule must be numbers separated by commas, for example 10, 20, 30.' });
    } else if (useSchedule && schedule.some(function (n) { return n < 0; })) {
      errors.push({ field: 'w-schedule', message: 'The delivery schedule cannot contain negative numbers.' });
    }

    var allocated = allocation.reduce(function (t, r) { return t + num(r.sites); }, 0);
    if (allocation.length && Math.abs(allocated - totalSites) > 1e-9) {
      errors.push({
        field: 'w-alloc',
        message: 'Allocated sites (' + round(allocated, 2) + ') must equal total sites (' +
                 round(totalSites, 2) + '). ' +
                 (allocated < totalSites
                    ? (round(totalSites - allocated, 2) + ' site(s) are not yet allocated.')
                    : ('You have allocated ' + round(allocated - totalSites, 2) + ' site(s) too many.'))
      });
    }

    var rows = [], baseMd = 0;

    allocation.forEach(function (item, idx) {
      var sites = num(item.sites);
      if (sites <= 0) return;
      var complexity = num(item.complexityPct, 100);
      var baseRate, rateSource;

      if (mode === 'Standard') {
        baseRate = D.lookupBaseMd(item.connectivityMode, item.product);
        rateSource = 'Rate card';
        if (baseRate === null) {
          errors.push({
            field: 'w-alloc',
            message: 'Row ' + (idx + 1) + ': "' + item.product + '" is not offered with connectivity mode "' +
                     item.connectivityMode + '". Pick a different pairing, or switch to Non-standard mode and enter a rate.'
          });
          return;
        }
      } else {
        baseRate = num(item.overrideMdPerSite, 0);
        rateSource = 'Manual override';
        if (!(baseRate > 0)) {
          errors.push({
            field: 'w-alloc',
            message: 'Row ' + (idx + 1) + ' (' + item.product + ' / ' + item.connectivityMode +
                     '): Non-standard mode needs an override MD per site greater than zero.'
          });
          return;
        }
      }

      var md = baseRate * (complexity / 100) * sites;
      baseMd += md;
      rows.push({
        label: item.product,
        product: item.product,
        connectivityMode: item.connectivityMode,
        sites: sites,
        complexityPct: complexity,
        baseMdPerSite: baseRate,
        rateSource: rateSource,
        md: round(md, 3)
      });
    });

    if (errors.length) return { ok: false, errors: errors, warnings: warnings };

    steps.push({
      label: 'Effort for each allocation row',
      formula: 'base rate x complexity x sites, summed over ' + rows.length + ' row(s)',
      value: round(baseMd, 3) + ' MD'
    });

    var migrationMd = migration ? num(s.migrationMdPerSite, 0.5) * totalSites : 0;
    if (migration) {
      steps.push({
        label: 'Migration support uplift',
        formula: s.migrationMdPerSite + ' MD per site x ' + round(totalSites, 2) + ' sites',
        value: '+ ' + round(migrationMd, 3) + ' MD'
      });
    }

    var totalMd = baseMd + migrationMd;
    steps.push({
      label: 'Total project effort',
      formula: round(baseMd, 3) + ' MD' + (migration ? ' + ' + round(migrationMd, 3) + ' MD migration' : ''),
      value: round(totalMd, 3) + ' MD'
    });

    if (useSchedule) { useSchedule = validateSchedule(schedule, totalSites, months, warnings); }

    var out = finalise(totalMd, months, capacity, steps, { schedule: useSchedule ? schedule : null });
    out.rows = withShares(rows, totalMd);
    out.baseMd = round(baseMd, 3);
    out.migrationMd = round(migrationMd, 3);
    out.deliverySchedule = useSchedule ? schedule : null;
    out.steps = steps;
    out.ok = true;
    out.errors = [];
    out.warnings = warnings;
    out.capacityUsed = capacity;
    return out;
  }

  /* ------------------------------------------------------------- LAN ----- */

  function calculateLan(input, settings) {
    var s = Object.assign({}, D.DEFAULT_SETTINGS, settings || {});
    var errors = [], warnings = [], steps = [];

    var months     = num(input.months);
    var totalSites = num(input.totalSites);
    var capacity   = num(s.capacityMdPerMonth, 18);
    var devices    = num(input.devices);
    var mode       = input.mode || 'Standard';
    var stages     = input.stages || [];
    var allocation = input.allocation || [];
    var schedule   = parseSchedule(input.schedule);
    var useSchedule = schedule.length > 0;

    if (!(months > 0))     errors.push({ field: 'l-months', message: 'Enter a project duration greater than zero.' });
    if (!(totalSites > 0)) errors.push({ field: 'l-sites',  message: 'Total sites must be greater than zero.' });
    if (!(capacity > 0))   errors.push({ field: 'set-capacity', message: 'Monthly capacity must be greater than zero.' });
    if (mode === 'By Stage' && !stages.length) {
      errors.push({ field: 'l-stages', message: 'By Stage mode needs at least one delivery stage selected.' });
    }
    if (useSchedule && schedule.some(function (n) { return isNaN(n); })) {
      errors.push({ field: 'l-schedule', message: 'The delivery schedule must be numbers separated by commas, for example 10, 20, 30.' });
    } else if (useSchedule && schedule.some(function (n) { return n < 0; })) {
      errors.push({ field: 'l-schedule', message: 'The delivery schedule cannot contain negative numbers.' });
    }

    var usingTierRows = allocation.length > 0 &&
                        allocation.reduce(function (t, r) { return t + num(r.sites); }, 0) > 0;

    var rows = [], totalMd = 0, fallbackTier = null;

    if (usingTierRows) {
      var allocated = allocation.reduce(function (t, r) { return t + num(r.sites); }, 0);
      if (Math.abs(allocated - totalSites) > 1e-9) {
        errors.push({
          field: 'l-alloc',
          message: 'Allocated sites (' + round(allocated, 2) + ') must equal total sites (' +
                   round(totalSites, 2) + '). ' +
                   (allocated < totalSites
                      ? (round(totalSites - allocated, 2) + ' site(s) are not yet allocated.')
                      : ('You have allocated ' + round(allocated - totalSites, 2) + ' site(s) too many.'))
        });
      }

      allocation.forEach(function (item, idx) {
        var tier = D.tierByLabel(item.tierLabel);
        var sites = num(item.sites);
        if (!tier || sites <= 0) return;
        var complexity = num(item.complexityPct, 100);
        var baseRate, rateSource;

        if (mode === 'Standard') {
          baseRate = tier.loe;
          rateSource = 'Rate card';
        } else if (mode === 'Non-standard') {
          baseRate = num(item.overrideMdPerSite, 0);
          rateSource = 'Manual override';
          if (!(baseRate > 0)) {
            errors.push({
              field: 'l-alloc',
              message: 'Row ' + (idx + 1) + ' (' + item.tierLabel +
                       '): Non-standard mode needs an override MD per site greater than zero.'
            });
            return;
          }
        } else {
          baseRate = D.stageMdPerSite(tier.key, stages);
          rateSource = 'Stage hours / ' + D.HOURS_PER_DAY;
          if (!(baseRate > 0)) {
            errors.push({
              field: 'l-stages',
              message: 'The selected stages produce zero effort for tier ' + tier.name + '.'
            });
            return;
          }
        }

        var md = baseRate * (complexity / 100) * sites;
        totalMd += md;
        rows.push({
          label: item.tierLabel,
          tier: tier.name,
          tierKey: tier.key,
          sites: sites,
          complexityPct: complexity,
          baseMdPerSite: round(baseRate, 4),
          rateSource: rateSource,
          md: round(md, 3)
        });
      });
    } else {
      /* No tier rows: fall back to a single tier derived from the device count.
         The old build did this silently, and a device count of 0 quietly became
         the smallest tier. It is now stated in the result and warned about. */
      fallbackTier = D.tierForDeviceCount(devices);
      if (devices <= 0) {
        warnings.push('No tier rows and no device count entered, so every site was priced at the smallest tier (' +
                      fallbackTier.name + '). Add tier rows or enter a device count for an accurate estimate.');
      } else {
        warnings.push('No tier rows entered, so all ' + round(totalSites, 2) + ' sites were priced at tier ' +
                      fallbackTier.name + ', chosen from a device count of ' + round(devices, 0) + '.');
      }

      var rate, src;
      if (mode === 'Standard') {
        rate = fallbackTier.loe; src = 'Rate card (fallback tier)';
      } else if (mode === 'Non-standard') {
        rate = num(input.fallbackOverride, 0); src = 'Manual override (fallback tier)';
        if (!(rate > 0)) {
          errors.push({ field: 'l-fb-ovrd', message: 'Non-standard mode with no tier rows needs a fallback override MD per site.' });
        }
      } else {
        rate = D.stageMdPerSite(fallbackTier.key, stages); src = 'Stage hours / ' + D.HOURS_PER_DAY + ' (fallback tier)';
      }

      if (!errors.length) {
        totalMd = rate * totalSites;
        rows.push({
          label: fallbackTier.name + ' (fallback - whole project)',
          tier: fallbackTier.name,
          tierKey: fallbackTier.key,
          sites: totalSites,
          complexityPct: 100,
          baseMdPerSite: round(rate, 4),
          rateSource: src,
          md: round(totalMd, 3)
        });
      }
    }

    if (errors.length) return { ok: false, errors: errors, warnings: warnings };

    if (mode === 'By Stage') {
      steps.push({
        label: 'Rate built from selected stages',
        formula: 'sum of activity hours in [' + stages.join(', ') + '] / ' + D.HOURS_PER_DAY + ' hours per day',
        value: 'per-tier MD per site'
      });
    }
    steps.push({
      label: 'Effort for each tier row',
      formula: 'base rate x complexity x sites, summed over ' + rows.length + ' row(s)',
      value: round(totalMd, 3) + ' MD'
    });

    if (useSchedule) { useSchedule = validateSchedule(schedule, totalSites, months, warnings); }

    var out = finalise(totalMd, months, capacity, steps, { schedule: useSchedule ? schedule : null });
    out.rows = withShares(rows, totalMd);
    out.baseMd = round(totalMd, 3);
    out.migrationMd = 0;
    out.deliverySchedule = useSchedule ? schedule : null;
    out.steps = steps;
    out.ok = true;
    out.errors = [];
    out.warnings = warnings;
    out.capacityUsed = capacity;
    out.fallbackTier = fallbackTier ? fallbackTier.name : null;
    out.usedTierRows = usingTierRows;
    return out;
  }

  global.FTECalc = {
    num: num,
    round: round,
    monthsBetween: monthsBetween,
    parseSchedule: parseSchedule,
    distributeMonthly: distributeMonthly,
    makeProjectCode: makeProjectCode,
    makeRecordId: makeRecordId,
    calculateWan: calculateWan,
    calculateLan: calculateLan
  };
})(window);
