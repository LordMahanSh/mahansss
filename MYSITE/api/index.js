import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const config = {
  api: { bodyParser: false },
  maxDuration: 60,
};

const TARGET = (process.env.TARGET_DOMAIN || "").replace(/\/$/, "");

const SKIP = new Set([
  "host","connection","keep-alive","transfer-encoding","upgrade",
  "x-vercel-","forwarded","x-forwarded-host","x-forwarded-proto","x-forwarded-port"
]);

export default async function(req, res) {
  if (!TARGET) return res.status(500).end("TARGET_DOMAIN missing");

  if (req.method === "OPTIONS") {
    res.setHeader("access-control-allow-origin", req.headers.origin || "*");
    res.setHeader("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type,authorization");
    return res.status(204).end();
  }

  try {
    const headers = {};
    let ip = null;
    
    for (const k in req.headers) {
      const key = k.toLowerCase();
      if (key === "x-real-ip") ip = req.headers[k];
      if (key === "x-forwarded-for" && !ip) ip = req.headers[k];
      if (SKIP.has(key)) continue;
      if (key.startsWith("x-vercel-")) continue;
      headers[key] = req.headers[k];
    }
    
    if (ip) headers["x-forwarded-for"] = ip;

    const opts = { method: req.method, headers, redirect: "manual" };
    
    if (req.method !== "GET" && req.method !== "HEAD") {
      opts.body = Readable.toWeb(req);
      opts.duplex = "half";
    }

    const upstream = await fetch(TARGET + req.url, opts);

    res.statusCode = upstream.status;
    
    for (const [k, v] of upstream.headers) {
      if (k !== "transfer-encoding") res.setHeader(k, v);
    }
    
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-credentials", "true");

    if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), res);
    else res.end();
    
  } catch {
    if (!res.headersSent) res.status(502).end("Bad Gateway");
  }
}
