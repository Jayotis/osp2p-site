
// Render the public terms from the canonical OSP repository, not a site-local copy.
const TERMS_SOURCE = "https://raw.githubusercontent.com/Jayotis/open-social-p2p/main/docs/terms.md";
const TERMS_HISTORY = "https://github.com/Jayotis/open-social-p2p/commits/main/docs/terms.md";

function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function termsInline(value) {
  // Escape all prose first; the only supported Markdown formatting is a link.
  return value.replace(/\[([^\]]+)\]\(([^)]+)\)|([^[]+|\[)/g, (part, label, target, plain) => {
    if (plain !== undefined) return escapeHtml(plain);
    // Link targets are relative to docs/ in the source repository.
    const destination = new URL(target, "https://github.com/Jayotis/open-social-p2p/blob/main/docs/");
    if (destination.origin !== "https://github.com" ||
        !destination.pathname.startsWith("/Jayotis/open-social-p2p/blob/main/docs/")) {
      throw new Error("Unexpected terms link");
    }
    return '<a href="' + escapeHtml(destination.href) + '">' + escapeHtml(label) + "</a>";
  });
}

function renderTerms(markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").trim().split("\n");
  if (lines[0] !== "# Terms of use" || !/^Version \d+, \d{4}-\d{2}-\d{2}\./.test(lines[2])) {
    throw new Error("Unexpected canonical terms format");
  }
  const paragraphs = [];
  const bullets = [];
  for (const line of lines.slice(2)) {
    if (!line.trim()) continue;
    if (line.startsWith("- ")) bullets.push("<li>" + termsInline(line.slice(2)) + "</li>");
    else if (!bullets.length) paragraphs.push("<p>" + termsInline(line) + "</p>");
    else throw new Error("Unexpected terms content");
  }
  if (!paragraphs.length || bullets.length < 1) throw new Error("Incomplete canonical terms");
  const version = lines[2].match(/^Version (\d+),/)[1];
  return {intro: paragraphs.join("\n"), list: "<ul>\n" + bullets.join("\n") + "\n</ul>", version};
}

async function serveTerms(request, env) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", {status: 405, headers: {Allow: "GET, HEAD"}});
  }
  try {
    const source = await fetch(TERMS_SOURCE, {
      headers: {"Accept": "text/plain"},
      cf: {cacheEverything: true, cacheTtl: 300},
    });
    if (!source.ok) throw new Error("Canonical terms unavailable");
    const markdown = await source.text();
    if (markdown.length > 30000) throw new Error("Canonical terms too large");
    const {intro, list, version} = renderTerms(markdown);
    const template = await env.ASSETS.fetch(new Request(new URL("/terms/", request.url)));
    if (!template.ok) throw new Error("Terms page template unavailable");
    let html = await template.text();
    const hero = /(<section class="page-hero">[\s\S]*?<h1>Terms of use<\/h1>)[\s\S]*?(<\/section>)/;
    const body = /(<article class="prose terms-copy">)[\s\S]*?(<p><a class="button secondary")/;
    if (!hero.test(html) || !body.test(html)) throw new Error("Terms template changed");
    html = html.replace(hero, (_, start, end) => start + "\n      " + intro + "\n    " + end);
    html = html.replace(body, (_, start, button) => start + "\n        " + list + "\n\n        " + button);
    html = html.replace(/(<aside class="side-card">\s*<h3>)Version \d+/, "$1Version " + version);
    html = html.replace(/<meta name="description" content="[^"]*">/,
      '<meta name="description" content="Open Social P2P terms of use, sourced from the official project repository.">');
    html = html.replace("</article>", "</article>"); // Keep the site's existing controls and styling.
    return new Response(request.method === "HEAD" ? null : html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=300",
        "X-Content-Type-Options": "nosniff",
        "Link": '<' + TERMS_HISTORY + '>; rel="version-history"',
      },
    });
  } catch (error) {
    console.error("terms sync failure", error.message);
    // Never silently present stale, potentially contradictory legal terms.
    return new Response("Terms are temporarily unavailable. Please try again shortly.", {
      status: 503, headers: {"Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8"},
    });
  }
}

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

    if (url.pathname === "/terms" || url.pathname === "/terms/") {
      return serveTerms(request, env);
    }

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
