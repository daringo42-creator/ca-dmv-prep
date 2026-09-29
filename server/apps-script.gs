/**
 * Shared-progress backend for the CA DMV prep dashboard - Google Apps Script.
 *
 * Uses the Google account you already have. No new signup, no billing, and the
 * data lives in a spreadsheet in your own Drive that you can open and read.
 *
 * Implements the same contract as the Cloudflare Worker:
 *   GET  <url>?code=<syncCode>            -> {"state": <object>|null, "rev": <n>}
 *   POST <url>?code=<syncCode>  body=JSON -> {"ok":true, "rev": <n>}
 *
 * SETUP
 *   1. script.google.com -> New project. Delete the sample, paste this file.
 *   2. Deploy -> New deployment -> type "Web app".
 *        Execute as:        Me
 *        Who has access:    Anyone
 *      Authorise when prompted (it is your own script touching your own Drive).
 *   3. Copy the /exec URL it gives you.
 *   4. Paste that URL into the dashboard's Sync card on both phones, with the
 *      same sync code.
 *
 * NOTE ON "Anyone": the URL is unguessable and the sync code is a second secret,
 * but anyone holding both can read and write that one spreadsheet row. Do not
 * reuse a password as the sync code.
 *
 * A spreadsheet named "DMV prep sync" is created in your Drive on first use.
 */

var SHEET_NAME = 'DMV prep sync';
var PROP_ID = 'dmv_sync_sheet_id';
var MAX_BODY = 250000;

function sheet_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(PROP_ID);
  var ss = null;
  if (id) {
    try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; }
  }
  if (!ss) {
    ss = SpreadsheetApp.create(SHEET_NAME);
    props.setProperty(PROP_ID, ss.getId());
    var s0 = ss.getSheets()[0];
    s0.appendRow(['key', 'rev', 'updated', 'state']);
    s0.setFrozenRows(1);
  }
  return ss.getSheets()[0];
}

/** Hash the sync code so the raw secret is never written to the sheet. */
function keyFor_(code) {
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, 'cadmv:' + code, Utilities.Charset.UTF_8);
  return bytes.map(function (b) {
    return ((b < 0 ? b + 256 : b) + 0x100).toString(16).slice(1);
  }).join('');
}

function findRow_(sh, key) {
  var keys = sh.getRange(2, 1, Math.max(0, sh.getLastRow() - 1) || 1, 1).getValues();
  for (var i = 0; i < keys.length; i++) {
    if (keys[i][0] === key) return i + 2;
  }
  return 0;
}

function out_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  var code = ((e && e.parameter && e.parameter.code) || '').trim();
  if (code.length < 6) return out_({ error: 'sync code must be at least 6 characters' });
  var sh = sheet_();
  var row = findRow_(sh, keyFor_(code));
  if (!row) return out_({ state: null, rev: 0 });
  var vals = sh.getRange(row, 1, 1, 4).getValues()[0];
  var state = null;
  try { state = JSON.parse(vals[3]); } catch (err) { state = null; }
  return out_({ state: state, rev: Number(vals[1]) || 0 });
}

function doPost(e) {
  var code = ((e && e.parameter && e.parameter.code) || '').trim();
  if (code.length < 6) return out_({ error: 'sync code must be at least 6 characters' });

  var body = (e && e.postData && e.postData.contents) || '';
  if (body.length > MAX_BODY) return out_({ error: 'state too large' });
  var state;
  try { state = JSON.parse(body); } catch (err) { return out_({ error: 'body is not valid JSON' }); }
  if (!state || typeof state !== 'object') return out_({ error: 'state must be an object' });

  // Two phones can post at the same moment; serialise the read-modify-write.
  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (err) { return out_({ error: 'busy, retry' }); }

  try {
    var sh = sheet_();
    var key = keyFor_(code);
    var row = findRow_(sh, key);
    var rev = 1;
    if (row) {
      rev = (Number(sh.getRange(row, 2).getValue()) || 0) + 1;
      sh.getRange(row, 1, 1, 4).setValues([[key, rev, new Date(), body]]);
    } else {
      sh.appendRow([key, rev, new Date(), body]);
    }
    return out_({ ok: true, rev: rev });
  } finally {
    lock.releaseLock();
  }
}
