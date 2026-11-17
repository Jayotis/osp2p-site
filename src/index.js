const RULES = new Set([
  "Explicit sexual material",
  "Prolonged graphic or sadistic realistic violence",
  "Sexual material involving minors",
  "Intimate images shared without consent",
  "Threats of violence, or material made to incite it",
  "This was hidden and shouldn't be",
]);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function clean(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/report") {
      if (request.method !== "POST") {
        return json({error: "Method not allowed."}, 405);
      }

      const origin = request.headers.get("Origin");
      if (origin && origin !== url.origin) {
        return json({error: "This form can only be submitted from osp2p.com."}, 403);
      }

      const rateKey = request.headers.get("CF-Connecting-IP") || "unknown";
      const { success: withinLimit } = await env.REPORT_RATE_LIMITER.limit({ key: rateKey });
      if (!withinLimit) {
        return json({error: "Too many reports were sent from this connection. Try again in about a minute."}, 429);
      }

      let body;
      try {
        body = await request.json();
      } catch (_) {
        return json({error: "Invalid report."}, 400);
      }

      // Honeypot: real users never see or fill this field. Pretend success so
      // simple form bots do not learn how to bypass it, but send no email.
      if (clean(body.website, 200)) {
        return json({ok: true});
      }

      const kind = clean(body.kind, 32) || "manual";
      const target = clean(body.target, 500);
      const rule = clean(body.rule, 120);
      const note = clean(body.note, 2000);
      const email = clean(body.email, 320);

      if (!target) return json({error: "A post, reply or profile is required."}, 400);
      if (!RULES.has(rule)) return json({error: "Choose one report reason."}, 400);
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return json({error: "Enter a valid email address, or leave it blank."}, 400);
      }
      if (!env.REPORT_TO) {
        return json({error: "Reporting is temporarily unavailable. Email support@osp2p.com instead."}, 503);
      }

      const text = [
        "OSP content report",
        "",
        "Kind: " + kind,
        "ID / target: " + target,
        "Rule: " + rule,
        "",
        "Note:",
        note || "(none)",
        "",
        "Reporter email: " + (email || "(not provided)"),
        "Received: " + new Date().toISOString(),
      ].join("\n");

      const message = {
        from: {email: "reports@osp2p.com", name: "OSP Reports"},
        to: env.REPORT_TO,
        subject: "[OSP report] " + rule,
        text,
      };
      if (email) message.replyTo = email;

      try {
        await env.EMAIL.send(message);
      } catch (e) {
        console.error("report delivery failed", e && e.code ? e.code : "unknown");
        return json({error: "The report could not be delivered. Email support@osp2p.com instead."}, 502);
      }

      return json({ok: true});
    }

    return env.ASSETS.fetch(request);
  },
};
