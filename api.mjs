import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

const E = process.env;
const db = () => getStore("sms");
const J = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });
const get = async (k, d) => (await db().get(k, { type: "json" })) ?? d;
const put = (k, v) => db().setJSON(k, v);
const sign = (p) => crypto.createHmac("sha256", E.SESSION_SECRET || "").update(p).digest("hex");
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const token = () => { const x = Date.now() + 12 * 3600e3; return `${x}.${sign(String(x))}`; };
const authed = (req) => {
  const t = (req.headers.get("authorization") || "").replace("Bearer ", "");
  const [x, s] = t.split(".");
  return E.SESSION_SECRET && x && s && Number(x) > Date.now() && safeEq(s, sign(x));
};
export const normPhone = (p) => {
  let d = String(p || "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 10 && d[0] === "0") d = "233" + d.slice(1);
  else if (d.length === 9) d = "233" + d;
  return d.length >= 11 && d.length <= 15 ? d : null;
};
const render = (tpl, c) => tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => c[k.toLowerCase()] ?? "") .replace(/\s+/g, " ").trim();
const FOOTER = " Reply STOP to opt out.";
const STOP = /^\s*(stop|unsubscribe|quit|cancel|end|optout)\s*$/i;

// ---- providers: add new ones here ----
const providers = {
  mock: async (to) => ({ id: "mock-" + crypto.randomUUID(), status: "sent" }),
  arkesel: async (to, message, sender, cb) => {
    const r = await fetch("https://sms.arkesel.com/api/v2/sms/send", {
      method: "POST",
      headers: { "api-key": E.SMS_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({ sender, message, recipients: [to], callback_url: cb }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.status === "error") throw new Error(j.message || `Provider HTTP ${r.status}`);
    return { id: j.data?.[0]?.id || null, status: "sent" };
  },
};
const provider = () => providers[E.SMS_PROVIDER || "mock"] || providers.mock;

async function addOptout(phone, reason) {
  const o = await get("optouts", {});
  if (!o[phone]) { o[phone] = { at: new Date().toISOString(), reason }; await put("optouts", o); }
}

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/?/, "");
  const m = req.method;
  const body = ["POST", "PUT", "DELETE"].includes(m) ? await req.json().catch(() => ({})) : {};

  // Public webhooks (secret in query string)
  if (path === "dlr" || path === "inbound") {
    if (!E.WEBHOOK_SECRET || !safeEq(url.searchParams.get("secret") || "", E.WEBHOOK_SECRET)) return J({ error: "forbidden" }, 403);
    if (path === "inbound") {
      const from = normPhone(body.from || body.sender || body.phone);
      if (from && STOP.test(body.message || body.text || "")) await addOptout(from, "STOP reply");
      return J({ ok: true });
    }
    const id = body.id || body.message_id || body.messageId;
    const raw = String(body.status || "").toLowerCase();
    const ref = id && (await get("mid:" + id, null));
    if (ref) {
      const msgs = await get("msgs:" + ref, {});
      const k = Object.keys(msgs).find((p) => msgs[p].providerId === id);
      if (k) {
        msgs[k].status = /deliver/.test(raw) && !/un/.test(raw) ? "delivered" : /fail|reject|undeliv|expire/.test(raw) ? "failed" : msgs[k].status;
        await put("msgs:" + ref, msgs);
      }
    }
    return J({ ok: true });
  }

  if (path === "login" && m === "POST") {
    if (!E.APP_PASSWORD || !E.SESSION_SECRET) return J({ error: "Server not configured: set APP_PASSWORD and SESSION_SECRET" }, 500);
    await new Promise((r) => setTimeout(r, 400));
    const ok = safeEq(String(body.password || ""), E.APP_PASSWORD);
    return ok ? J({ token: token() }) : J({ error: "Wrong password" }, 401);
  }
  if (!authed(req)) return J({ error: "unauthorized" }, 401);

  if (path === "state") {
    return J({ provider: E.SMS_PROVIDER || "mock", sender: E.DEFAULT_SENDER || "", contacts: await get("contacts", []), optouts: await get("optouts", {}), campaigns: await get("campaigns", []) });
  }
  if (path === "contacts" && m === "POST") {
    const cur = await get("contacts", []);
    const map = new Map(cur.map((c) => [c.phone, c]));
    let bad = 0;
    for (const r of body.contacts || []) {
      const phone = normPhone(r.phone);
      if (!phone) { bad++; continue; }
      const c = { phone };
      for (const [k, v] of Object.entries(r)) if (k !== "phone") c[k.toLowerCase().replace(/\W+/g, "_")] = String(v).slice(0, 200);
      map.set(phone, { ...map.get(phone), ...c });
    }
    const all = [...map.values()].slice(0, 20000);
    await put("contacts", all);
    return J({ total: all.length, invalid: bad });
  }
  if (path === "contacts" && m === "DELETE") { await put("contacts", []); return J({ ok: true }); }
  if (path === "optouts" && m === "POST") {
    let n = 0;
    for (const p of body.phones || []) { const x = normPhone(p); if (x) { await addOptout(x, body.reason || "manual"); n++; } }
    return J({ added: n });
  }
  if (path === "optouts" && m === "DELETE") {
    const o = await get("optouts", {}); delete o[normPhone(body.phone)]; await put("optouts", o); return J({ ok: true });
  }
  if (path === "campaign" && m === "POST") {
    if (!body.consent) return J({ error: "Consent confirmation required" }, 400);
    const camps = await get("campaigns", []);
    const c = { id: crypto.randomUUID(), name: String(body.name || "Untitled").slice(0, 80), template: String(body.template || "").slice(0, 600), sender: String(body.sender || E.DEFAULT_SENDER || "").slice(0, 11), at: new Date().toISOString(), provider: E.SMS_PROVIDER || "mock" };
    if (!c.template || !c.sender) return J({ error: "Template and sender required" }, 400);
    camps.unshift(c); await put("campaigns", camps); return J(c);
  }
  if (path === "send" && m === "POST") {
    const camps = await get("campaigns", []);
    const camp = camps.find((c) => c.id === body.campaignId);
    if (!camp) return J({ error: "campaign not found" }, 404);
    const [contacts, optouts, msgs] = await Promise.all([get("contacts", []), get("optouts", {}), get("msgs:" + camp.id, {})]);
    const byPhone = new Map(contacts.map((c) => [c.phone, c]));
    const cb = `${url.origin}/api/dlr?secret=${encodeURIComponent(E.WEBHOOK_SECRET || "")}`;
    const targets = (body.phones || []).slice(0, 10);
    await Promise.all(targets.map(async (p) => {
      const c = byPhone.get(p);
      if (!c) return;
      if (optouts[p]) { msgs[p] = { phone: p, status: "skipped_optout" }; return; }
      if (msgs[p]) return; // idempotent: never double-send
      const text = render(camp.template, c) + FOOTER;
      try {
        const r = await provider()(p, text, camp.sender, cb);
        msgs[p] = { phone: p, name: c.name || "", text, status: r.status, providerId: r.id, at: new Date().toISOString() };
        if (r.id) await put("mid:" + r.id, camp.id);
      } catch (e) { msgs[p] = { phone: p, text, status: "failed", error: String(e.message).slice(0, 200) }; }
    }));
    await put("msgs:" + camp.id, msgs);
    return J({ done: targets.length });
  }
  if (path.startsWith("report/")) return J(Object.values(await get("msgs:" + path.slice(7), {})));
  return J({ error: "not found" }, 404);
};
export const config = { path: "/api/*" };
