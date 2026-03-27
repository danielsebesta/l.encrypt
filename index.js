const ALLOWED_DOMAINS = [
  "encrypt.click",
];

const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const SLUG_LENGTH = 6;

function generateSlug() {
  const bytes = new Uint8Array(SLUG_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => ALPHABET[b % ALPHABET.length])
    .join("");
}

function extractDomain(url) {
  try {
    const { hostname } = new URL(url);
    return hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function isDomainAllowed(url) {
  const domain = extractDomain(url);
  if (!domain) return false;
  return ALLOWED_DOMAINS.some(
    (d) => domain === d || domain === `www.${d}` || domain.endsWith(`.${d}`)
  );
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2) + "\n", {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

async function handleShorten(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const url = (body.url || "").trim();
  if (!url) {
    return json({ error: "Missing 'url' field" }, 400);
  }
  
  try {
    new URL(url);
  } catch {
    return json({ error: "Invalid URL" }, 400);
  }

  if (!isDomainAllowed(url)) {
    return json(
      {
        error: "Domain not allowed",
        allowed: ALLOWED_DOMAINS,
      },
      403
    );
  }

  const existingSlug = await env.URLS.get(`url:${url}`);
  if (existingSlug) {
    const base = new URL(request.url).origin;
    return json({
      slug: existingSlug,
      short_url: `${base}/${existingSlug}`,
      original_url: url,
      duplicate: true,
    });
  }

  let slug;
  let attempts = 0;
  do {
    slug = generateSlug();
    const collision = await env.URLS.get(`slug:${slug}`);
    if (!collision) break;
    attempts++;
  } while (attempts < 10);

  if (attempts >= 10) {
    return json({ error: "Failed to generate unique slug, try again" }, 500);
  }

  await env.URLS.put(`slug:${slug}`, url);
  await env.URLS.put(`url:${url}`, slug);

  const base = new URL(request.url).origin;
  return json(
    {
      slug,
      short_url: `${base}/${slug}`,
      original_url: url,
      duplicate: false,
    },
    201
  );
}

async function handleResolve(slug, env) {
  const url = await env.URLS.get(`slug:${slug}`);
  if (!url) {
    return json({ error: "Not found" }, 404);
  }
  return json({ slug, original_url: url });
}

async function handleRedirect(slug, env) {
  const url = await env.URLS.get(`slug:${slug}`);
  if (!url) {
    return new Response("Not found\n", {
      status: 404,
      headers: { "Content-Type": "text/plain" },
    });
  }
  return Response.redirect(url, 301);
}

async function handleInfo(request) {
  const base = new URL(request.url).origin;
  return json({
    name: "shrink",
    description: "Privacy-first URL shortener. No logs, no tracking.",
    endpoints: {
      "POST /api/shorten": {
        body: '{"url": "https://encrypt.click/u/#zSSYWjX4KL8gAhoeV"}',
        returns: "short URL (deduplicates automatically)",
      },
      "GET /api/resolve/:slug": {
        returns: "original URL as JSON (no redirect)",
      },
      "GET /:slug": {
        returns: "301 redirect to original URL",
      },
    },
    allowed_domains: ALLOWED_DOMAINS,
    curl_example: `curl -s -X POST ${base}/api/shorten -H 'Content-Type: application/json' -d '{"url":"https://encrypt.click/u/#zSSYWjX4KL8gAhoeV"}'`,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    if (path === "/" || path === "/api") {
      return handleInfo(request);
    }
    
    if (path === "/api/shorten" && request.method === "POST") {
      return handleShorten(request, env);
    }

    const resolveMatch = path.match(/^\/api\/resolve\/([a-z2-9]{4,10})$/);
    if (resolveMatch) {
      return handleResolve(resolveMatch[1], env);
    }

    const slugMatch = path.match(/^\/([a-z2-9]{4,10})$/);
    if (slugMatch) {
      return handleRedirect(slugMatch[1], env);
    }

    return json({ error: "Unknown route. Try GET / for docs." }, 404);
  },
};
