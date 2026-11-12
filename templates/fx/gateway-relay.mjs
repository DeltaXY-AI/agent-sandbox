// Runs inside the sandbox. fx (a Zig binary) ignores HTTPS_PROXY, so the sbx proxy
// never sees its requests and cannot swap the placeholder key for the real one.
// fx talks to this relay over plain HTTP on loopback; the relay forwards to the
// AI Gateway with Node's fetch, which honours HTTPS_PROXY (NODE_USE_ENV_PROXY=1),
// so the sbx proxy substitutes the real key.
// Run: NODE_USE_ENV_PROXY=1 node gateway-relay.mjs   (port from RELAY_PORT, default 8787)
import { createServer } from "node:http";
import { Readable } from "node:stream";

const upstream = process.env.RELAY_UPSTREAM ?? "https://ai-gateway.vercel.sh";
const port = Number(process.env.RELAY_PORT ?? 8787);
const verbose = process.env.RELAY_LOG === "1";

const hopByHop = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "host",
  "content-length",
]);

createServer(async (req, res) => {
  const started = Date.now();
  try {
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (!hopByHop.has(name) && value !== undefined) headers[name] = value;
    }
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const upstreamRes = await fetch(upstream + req.url, {
      method: req.method,
      headers,
      body: hasBody ? Readable.toWeb(req) : undefined,
      duplex: hasBody ? "half" : undefined,
    });
    const outHeaders = {};
    upstreamRes.headers.forEach((value, name) => {
      if (!hopByHop.has(name) && name !== "content-encoding") outHeaders[name] = value;
    });
    res.writeHead(upstreamRes.status, outHeaders);
    if (upstreamRes.body) {
      for await (const chunk of upstreamRes.body) res.write(chunk);
    }
    res.end();
    if (verbose)
      console.log(`${req.method} ${req.url} -> ${upstreamRes.status} ${Date.now() - started}ms`);
  } catch (err) {
    console.error(`${req.method} ${req.url} failed: ${err}`);
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end("relay error");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`gateway relay on http://127.0.0.1:${port} -> ${upstream}`);
});
