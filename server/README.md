# Shared progress between phones

By default the dashboard stores everything in the browser it is open in, so
Karla's phone and Dexter's phone keep separate progress. To share it, you need
somewhere for the two phones to meet. That needs an account somewhere — there is
no longer a usable service that will store data for you with no signup (I checked
four; they are all either dead or now require an API key).

Pick **one** of the two options below. Both are free, both take a few minutes,
and the dashboard does not care which you choose.

Once it is running, open the dashboard on each phone, expand **Shared progress**
at the top of the Plan tab, and enter:

- **Sync address** — the URL the setup gives you
- **Sync code** — any phrase at least 6 characters, *the same on both phones*

Then tap **Save & sync now**. That is it.

---

## Option A — Google Apps Script (no new account)

Uses the Google account you already have. The data lands in a spreadsheet in
your own Drive, which you can open and read.

1. Go to <https://script.google.com> → **New project**.
2. Delete the sample code, paste in [`apps-script.gs`](apps-script.gs).
3. **Deploy** → **New deployment** → type **Web app**.
   - *Execute as*: **Me**
   - *Who has access*: **Anyone**
4. Authorise when prompted — it is your own script touching your own Drive.
5. Copy the **/exec** URL. That is your sync address.

A spreadsheet called *DMV prep sync* appears in your Drive on first use.

**Trade-off:** Apps Script is rate-limited and occasionally slow. For two people
tapping a checklist that is irrelevant, but it is not built for heavy traffic.

## Option B — Cloudflare Worker (new free account, more robust)

1. Sign up at <https://dash.cloudflare.com> (free).
2. **Workers & Pages** → **Create** → **Worker**. Name it `dmv-sync`, deploy the
   placeholder, then **Edit code** and paste [`cloudflare-worker.js`](cloudflare-worker.js).
3. **Settings** → **Bindings** → **Add** → **KV namespace**
   - Variable name: `PROGRESS`
   - Namespace: create one called `dmv-progress`
4. **Deploy**. Copy the `*.workers.dev` URL. That is your sync address.

Free tier gives 100,000 requests and 1,000 KV writes a day — far more than two
people can use.

---

## What syncs, and what does not

**Shared:** checklist ticks, quiz miss lists, questions answered, audio positions
and finished chapters, both names, and the residency date.

**Not shared, deliberately:** which person the device is currently set to, and the
sync settings themselves. Each phone stays on whoever is holding it.

## How conflicts are handled

Every value records when it last changed, and merging happens per value rather
than per blob. If Karla ticks a step on her phone while Dexter answers a quiz
question on his, both survive — a whole-blob overwrite would have thrown one away.

Deleting is handled too: when you master a question and it leaves your miss list,
that deletion carries a timestamp, so the other phone does not push the old entry
back the next time it syncs.

Sync is best-effort and local-first. If the network is down, or you never set this
up, the dashboard works exactly as before and writes to the device it is on.

## Security, stated plainly

Anyone who has **both** the sync address and the sync code can read and overwrite
that progress. The code is hashed before it is used as a storage key, so the
server never stores the raw phrase, and one code tells you nothing about another.
But this is a study tracker, not a vault:

- Do not reuse a password as the sync code.
- The only data involved is two first names and quiz progress.

## Testing locally

`testserver.py` implements the same contract, for checking the client without
deploying anything:

```bash
python server/testserver.py 8764
```

Then use `http://127.0.0.1:8764` as the sync address. (The dashboard requires
`https://` for real addresses; the local server is for development only.)
