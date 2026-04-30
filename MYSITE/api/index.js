export const config = {
  runtime: "edge",
};

const TARGET_BASE = (process.env.TARGET_DOMAIN || "").replace(/\/$/, "");

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const FOLLOW_REDIRECTS = false;
const MAX_REDIRECTS = 5;
const UPSTREAM_TIMEOUT_MS = 15000;

function buildUpstreamUrl(reqUrl) {
  const url = new URL(reqUrl);
  return TARGET_BASE + url.pathname + url.search;
}

function copyRequestHeaders(req) {
  const headers = new Headers();

  for (const [key, value] of req.headers) {
    const k = key.toLowerCase();
    if (HOP_BY_HOP.has(k)) continue;
    if (k === "host") continue;
    if (k.startsWith("x-vercel-")) continue;
    headers.set(k, value);
  }

  const url = new URL(req.url);
  headers.set("x-forwarded-proto", url.protocol.replace(":", ""));
  headers.set("x-forwarded-host", url.host);

  return headers;
}

function copyResponseHeaders(upstreamHeaders) {
  const headers = new Headers();
  for (const [k, v] of upstreamHeaders) {
    if (k.toLowerCase() === "transfer-encoding") continue;
    headers.set(k, v);
  }
  return headers;
}

function addCors(req, headers) {
  const origin = req.headers.get("origin") || "*";
  headers.set("access-control-allow-origin", origin);
  headers.set("vary", "origin");
  headers.set("access-control-allow-credentials", "true");
  headers.set(
    "access-control-allow-methods",
    "GET,POST,PUT,PATCH,DELETE,OPTIONS"
  );
  headers.set(
    "access-control-allow-headers",
    req.headers.get("access-control-request-headers") ||
      "content-type, authorization"
  );
  headers.set("access-control-max-age", "86400");
  return headers;
}

async function fetchWithTimeout(url, opts, timeoutMs) {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(id);
  }
}

async function followRedirects(url, opts) {
  let currentUrl = url;
  for (let i = 0; i < MAX_REDIRECTS; i++) {
    const res = await fetchWithTimeout(
      currentUrl,
      { ...opts, redirect: "manual" },
      UPSTREAM_TIMEOUT_MS
    );
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return res;
      const next = new URL(loc, currentUrl).toString();
      if (!next.startsWith(TARGET_BASE)) {
        return new Response("Blocked redirect", { status: 502 });
      }
      currentUrl = next;
      continue;
    }
    return res;
  }
  return new Response("Too many redirects", { status: 508 });
}

export default async function handler(req) {
  if (!TARGET_BASE) {
    return new Response("Misconfigured: TARGET_DOMAIN is not set", {
      status: 500,
    });
  }

  if (req.method === "OPTIONS") {
    const headers = addCors(req, new Headers());
    return new Response(null, { status: 204, headers });
  }

  const targetUrl = buildUpstreamUrl(req.url);

  if (!targetUrl.startsWith(TARGET_BASE)) {
    return new Response("Forbidden", { status: 403 });
  }

  const method = req.method;
  const hasBody = method !== "GET" && method !== "HEAD";

  const headers = copyRequestHeaders(req);

  const fetchOpts = {
    method,
    headers,
    redirect: "manual",
  };

  if (hasBody) {
    fetchOpts.body = req.body;
  }

  try {
    const upstream = FOLLOW_REDIRECTS
      ? await followRedirects(targetUrl, fetchOpts)
      : await fetchWithTimeout(targetUrl, fetchOpts, UPSTREAM_TIMEOUT_MS);

    const respHeaders = copyResponseHeaders(upstream.headers);
    addCors(req, respHeaders);

    return new Response(upstream.body, {
      status: upstream.status,
      headers: respHeaders,
    });
  } catch {
    const headersOut = addCors(req, new Headers());
    return new Response("Bad Gateway: Upstream request failed", {
      status: 502,
      headers: headersOut,
    });
  }
}