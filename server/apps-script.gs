/**
 * Shared-progress backend for the CA DMV prep dashboard - Google Apps Script.
 *
 * Uses the Google account you already have. No new signup, no billing. The data
 * lives in a folder in your own Drive.
 *
 * Implements the same contract as the Cloudflare Worker:
 *   GET  <url>?code=<syncCode>            -> {"state": <object>|null, "rev": <n>}
 *   POST <url>?code=<syncCode>  body=JSON -> {"ok":true, "rev": <n>}
 *
 * SETUP
 *   1. script.google.com -> New project. Delete the sample, paste this whole file.
 *   2. Deploy -> New deployment -> gear icon -> Web app.
 *        Execute as:      Me
 *        Who has access:  Anyone
 *   3. Authorise when prompted. Google will warn that the app is unverified -
 *      that is expected for your own private script. Advanced -> Go to <name>.
 *   4. Copy the /exec URL. Paste it into the dashboard's Sync card on both
 *      phones, with the same sync code.
 *
 * WHY DRIVE FILES AND NOT A SPREADSHEET: a Sheets cell holds at most 50,000
 * characters. With 208 questions plus per-value timestamps the state can get
 * within reach of that, and blowing the limit would fail at the worst moment.
 * A Drive file has no practical ceiling.
 */

var FOLDER_NAME = 'DMV prep sync';
var PROP_FOLDER = 'dmv_sync_folder_id';
var MAX_BODY = 2000000;   // ~2 MB; far above anything this dashboard produces
var HISTORY_KEEP = 8;     // prior versions retained, so a bad write is recoverable

/** The folder holding one JSON file per sync code. Created on first use. */
function folder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(PROP_FOLDER);
  if (id) {
    try {
      var f = DriveApp.getFolderById(id);
      if (!f.isTrashed()) return f;
    } catch (e) { /* deleted or inaccessible - fall through and recreate */ }
  }
  var created = DriveApp.createFolder(FOLDER_NAME);
  props.setProperty(PROP_FOLDER, created.getId());
  return created;
}

/** Hash the sync code so the raw secret is never written to Drive. */
function keyFor_(code) {
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, 'cadmv:' + code, Utilities.Charset.UTF_8);
  var out = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i] < 0 ? bytes[i] + 256 : bytes[i];
    out += (b + 0x100).toString(16).slice(1);
  }
  return out;
}

function fileFor_(fold, key) {
  var it = fold.getFilesByName(key + '.json');
  return it.hasNext() ? it.next() : null;
}

function out_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function readCode_(e) {
  return ((e && e.parameter && e.parameter.code) || '').trim();
}

function doGet(e) {
  var code = readCode_(e);
  if (code.length < 6) return out_({ error: 'sync code must be at least 6 characters' });

  var f = fileFor_(folder_(), keyFor_(code));
  if (!f) return out_({ state: null, rev: 0 });

  try {
    var rec = JSON.parse(f.getBlob().getDataAsString());
    return out_({ state: rec.state, rev: rec.rev || 0 });
  } catch (err) {
    return out_({ state: null, rev: 0 });
  }
}

function doPost(e) {
  var code = readCode_(e);
  if (code.length < 6) return out_({ error: 'sync code must be at least 6 characters' });

  var body = (e && e.postData && e.postData.contents) || '';
  if (body.length > MAX_BODY) return out_({ error: 'state too large' });

  var state;
  try {
    state = JSON.parse(body);
  } catch (err) {
    return out_({ error: 'body is not valid JSON' });
  }
  if (!state || typeof state !== 'object') return out_({ error: 'state must be an object' });

  // Both phones can post at the same moment; serialise read-modify-write.
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    return out_({ error: 'busy, please retry' });
  }

  try {
    var fold = folder_();
    var key = keyFor_(code);
    var f = fileFor_(fold, key);

    var rev = 1;
    var history = [];
    if (f) {
      try {
        var prev = JSON.parse(f.getBlob().getDataAsString());
        rev = (prev.rev || 0) + 1;
        // Keep a few prior versions. The sync code shipped in the public page is
        // not a secret, so a wrong or malicious write is possible; this makes one
        // recoverable instead of permanent. Open the file in Drive and lift an
        // older 'state' out of history to roll back.
        history = Array.isArray(prev.history) ? prev.history : [];
        if (prev.state) {
          history.unshift({ rev: prev.rev || 0, updated: prev.updated || null, state: prev.state });
        }
        history = history.slice(0, HISTORY_KEEP);
      } catch (err2) { rev = 1; history = []; }
    }

    var payload = JSON.stringify({
      state: state, rev: rev, updated: new Date().toISOString(), history: history
    });
    if (f) {
      f.setContent(payload);
    } else {
      fold.createFile(key + '.json', payload, MimeType.PLAIN_TEXT);
    }
    return out_({ ok: true, rev: rev });
  } finally {
    lock.releaseLock();
  }
}

/**
 * Optional: run this once from the editor (Run -> selfTest) to confirm the
 * script works and to trigger the Drive authorisation prompt before you deploy.
 * It writes a throwaway entry under the code "selftest-code" and reads it back.
 */
function selfTest() {
  var code = 'selftest-code';
  var fake = { parameter: { code: code }, postData: { contents: JSON.stringify({ hello: 'world' }) } };
  var wrote = JSON.parse(doPost(fake).getContent());
  var read = JSON.parse(doGet({ parameter: { code: code } }).getContent());
  Logger.log('POST -> %s', JSON.stringify(wrote));
  Logger.log('GET  -> %s', JSON.stringify(read));
  if (!wrote.ok || !read.state || read.state.hello !== 'world') {
    throw new Error('self test FAILED: ' + JSON.stringify({ wrote: wrote, read: read }));
  }
  // clean up so the throwaway file does not linger
  var f = fileFor_(folder_(), keyFor_(code));
  if (f) f.setTrashed(true);
  Logger.log('self test PASSED - safe to deploy');
}
