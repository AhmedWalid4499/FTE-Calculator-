/* ===========================================================================
   updates.js - is there a newer version, and what does it add?

   The published version lives in assets/release-notes.js on GitHub. How the
   app learns about it depends on how it was opened:
     launcher  the local host checks GitHub itself and can install the update
               (see /api/update/* in server/serve.ps1);
     website   the page re-reads its own release-notes.js, so it knows when
               GitHub Pages has published a newer version and can reload;
     one file  (the portable build) reads GitHub directly and can only point
               to where the new version is.
   No DOM access.
   =========================================================================== */
(function (global) {
  'use strict';

  var REPO = 'AhmedWalid4499/FTE-Calculator-';
  var BRANCH = 'main';
  var RAW_NOTES = 'https://raw.githubusercontent.com/' + REPO + '/' + BRANCH + '/assets/release-notes.js';
  var WEBSITE = 'https://ahmedwalid4499.github.io/FTE-Calculator-/';

  /* The JSON between the markers of a release-notes.js file. */
  function parseNotes(text) {
    var s = String(text || '');
    var a = s.indexOf('/*JSON*/'), b = s.indexOf('/*END*/');
    if (a < 0 || b <= a) throw new Error('the release notes could not be read');
    var info = JSON.parse(s.slice(a + 8, b));
    if (!info || !info.version) throw new Error('the release notes name no version');
    return info;
  }

  var compare = global.FTEData.compareVersions;

  /* The releases in `info` that are newer than `current`, newest first. */
  function newerThan(info, current) {
    return ((info && info.releases) || []).filter(function (r) { return compare(r.version, current) > 0; });
  }

  function fetchNotes(url) {
    var bust = (url.indexOf('?') < 0 ? '?' : '&') + 't=' + Date.now();
    return fetch(url + bust, { cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    }).then(parseNotes);
  }

  /* The website: the release notes GitHub Pages serves right now. A newer
     version there means this open page is out of date - a reload fixes it. */
  function checkWebsite(current) {
    return fetchNotes('assets/release-notes.js').then(function (info) {
      var newer = newerThan(info, current);
      return { current: current, latest: info.version, available: compare(info.version, current) > 0,
               releases: newer, action: 'reload' };
    });
  }

  /* The single-file build: GitHub directly. It cannot replace itself, so it
     can only say where to get the new version. */
  function checkGitHub(current) {
    return fetchNotes(RAW_NOTES).then(function (info) {
      return { current: current, latest: info.version, available: compare(info.version, current) > 0,
               releases: newerThan(info, current), action: 'download' };
    });
  }

  global.FTEUpdates = {
    WEBSITE: WEBSITE,
    parseNotes: parseNotes,
    compare: compare,
    newerThan: newerThan,
    checkWebsite: checkWebsite,
    checkGitHub: checkGitHub
  };
})(window);
