/**
 * Shared-progress backend for the CA DMV prep dashboard - Cloudflare Worker.
 *
 * Contract (the dashboard speaks exactly this, so any backend implementing it works):
 *
 *   GET  <url>?code=<syncCode>            -> 200 {"state": <object>, "rev": <n>} | {"state":null,"rev":0}
 *   POST <url>?code=<syncCode>  body=JSON -> 200 {"ok":true, "rev": <n>}
 *
 * The sync code is a shared secret the two devices type in. It is hashed here
 * before being used as a storage key, so the raw code is never stored and one
 * code cannot be used to guess another.
 *
 * SETUP
 *   1. dash.cloudflare.com -> Workers & Pages -> Create -> Worker. Name it
 *      "dmv-sync". Deploy the placeholder, then Edit code and paste this file.
 *   2. Settings -> Bindings -> Add -> KV namespace.
 *      Variable name: PROGRESS      Namespace: create one called "dmv-progress"
 *   3. Deploy. Copy the workers.dev URL.
 *   4. Paste that URL into the dashboard's Sync card, on both phones, with the
 *      same sync code.
 *
 * Free tier covers this many times over: 100k requests/day, 1k KV writes/day.
 */

const MAX_BODY = 256 * 1024;   // the whole state is a few KB; this is generous
const TTL_DAYS = 400;

async function keyFor(code) {
  const data = new TextEncoder().encode("cadmv:" + code);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      // The dashboard is served from a different origin (GitHub Pages).
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      "Cache-Control": "no-store",
    },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return json({}, 204);

    const url = new URL(request.url);
    const code = (url.searchParams.get("code") || "").trim();

    // A short code is brute-forceable; refuse rather than pretend it is private.
    if (code.length < 6) {
      return json({ error: "sync code must be at least 6 characters" }, 400);
    }
    if (!env.PROGRESS) {
      return json({ error: "KV binding 'PROGRESS' is not configured on this Worker" }, 500);
    }

    const key = await keyFor(code);

    if (request.method === "GET") {
      const raw = await env.PROGRESS.get(key);
      if (!raw) return json({ state: null, rev: 0 });
      try {
        const rec = JSON.parse(raw);
        return json({ state: rec.state, rev: rec.rev || 0 });
      } catch (e) {
        return json({ state: null, rev: 0 });
      }
    }

    if (request.method === "POST") {
      const text = await request.text();
      if (text.length > MAX_BODY) return json({ error: "state too large" }, 413);
      let state;
      try {
        state = JSON.parse(text);
      } catch (e) {
        return json({ error: "body is not valid JSON" }, 400);
      }
      if (!state || typeof state !== "object") {
        return json({ error: "state must be an object" }, 400);
      }

      let rev = 0;
      const prev = await env.PROGRESS.get(key);
      if (prev) {
        try { rev = (JSON.parse(prev).rev || 0); } catch (e) { rev = 0; }
      }
      rev += 1;

      await env.PROGRESS.put(
        key,
        JSON.stringify({ state, rev, updated: Date.now() }),
        { expirationTtl: TTL_DAYS * 24 * 3600 }
      );
      return json({ ok: true, rev });
    }

    return json({ error: "method not allowed" }, 405);
  },
};
