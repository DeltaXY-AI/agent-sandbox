// Runs one fx turn inside the sandbox and reports it as JSON lines on stdout.
// Run: NODE_USE_ENV_PROXY=1 node fx-turn.mjs <fx ask args...>
//
// Why a relay: fx (a Zig binary) ignores HTTPS_PROXY, so the sbx proxy never sees its
// requests and cannot swap the placeholder key for the real one. fx talks to this
// per-turn relay over plain HTTP on loopback; the relay forwards with Node's fetch,
// which honours HTTPS_PROXY (NODE_USE_ENV_PROXY=1), so the proxy substitutes the key.
//
// Why it streams: `fx ask --json` prints one object at the end. The relay sees the
// model's live stream (AI SDK parts) and the tool results fx sends back, so it reports
// them as they happen. One relay per turn, so concurrent turns never mix events.
//
// Output lines (each one JSON object, `at` = epoch ms):
//   {"t":"part","at":..,"part":{..}}       model stream part (text, reasoning, tool input, tool call)
//   {"t":"tool_result","at":..,"id":..,"tool":..,"error":null|"message"}
//   {"t":"result","at":..,"exit":0,"stdout":"<fx --json output>","stderr":".."}   always last
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { StringDecoder } from "node:string_decoder";

const upstream = process.env.RELAY_UPSTREAM ?? "https://ai-gateway.vercel.sh";
const FORWARD_PARTS = new Set(["text-delta", "reasoning-delta", "tool-input-start", "tool-call"]);
const ERROR_OUTPUTS = new Set(["error-text", "error-json", "execution-denied"]);
const hopByHop = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "host",
  "content-length",
]);
const seenResults = new Set();

const emit = (line) => process.stdout.write(JSON.stringify({ ...line, at: Date.now() }) + "\n");

/** A short failure message from a tool-result output, or null when the tool succeeded. */
function toolError(output) {
  if (!output || !ERROR_OUTPUTS.has(output.type)) return null;
  const value =
    typeof output.value === "string" ? output.value : JSON.stringify(output.value ?? "");
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed.exit_code === "number") return `exit code ${parsed.exit_code}`;
  } catch {
    // not JSON; use the text
  }
  return value.slice(0, 300) || output.type;
}

/** Report tool results that fx sends back to the model in the next request. */
function reportToolResults(body) {
  for (const message of body.prompt ?? []) {
    if (message.role !== "tool" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== "tool-result" || seenResults.has(part.toolCallId)) continue;
      seenResults.add(part.toolCallId);
      emit({
        t: "tool_result",
        id: part.toolCallId,
        tool: part.toolName,
        error: toolError(part.output),
      });
    }
  }
}

/** Parse SSE `data:` frames out of a growing text buffer; returns the unparsed rest. */
function drainFrames(text, onPart) {
  let end;
  while ((end = text.indexOf("\n\n")) !== -1) {
    const frame = text.slice(0, end);
    text = text.slice(end + 2);
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        onPart(JSON.parse(line.slice(5).trim()));
      } catch {
        // not JSON (keepalive or [DONE]); ignore
      }
    }
  }
  return text;
}

const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    // Only the agent's own model calls carry tools; side requests (titles) are not reported.
    let agentCall = false;
    if (req.url?.startsWith("/v4/ai/language-model") && raw.length) {
      try {
        const body = JSON.parse(raw.toString("utf8"));
        agentCall = Array.isArray(body.tools) && body.tools.length > 0;
        if (agentCall) reportToolResults(body);
      } catch {
        // not JSON; forward as is
      }
    }
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (!hopByHop.has(name) && value !== undefined) headers[name] = value;
    }
    const up = await fetch(upstream + req.url, {
      method: req.method,
      headers,
      body: raw.length ? raw : undefined,
    });
    const outHeaders = {};
    up.headers.forEach((value, name) => {
      if (!hopByHop.has(name) && name !== "content-encoding") outHeaders[name] = value;
    });
    res.writeHead(up.status, outHeaders);
    const decoder = new StringDecoder("utf8");
    let pending = "";
    if (up.body) {
      for await (const chunk of up.body) {
        res.write(chunk);
        if (agentCall) {
          pending = drainFrames(pending + decoder.write(Buffer.from(chunk)), (part) => {
            if (FORWARD_PARTS.has(part.type)) emit({ t: "part", part });
          });
        }
      }
    }
    res.end();
  } catch (err) {
    process.stderr.write(`relay: ${req.method} ${req.url} failed: ${err}\n`);
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end("relay error");
  }
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  const fx = spawn("fx", ["ask", ...process.argv.slice(2)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      FX_GATEWAY_BASE_URL: `http://127.0.0.1:${port}`,
      FX_GATEWAY_CHAT_URL: `http://127.0.0.1:${port}/v4/ai/language-model`,
      FX_AUTO_UPGRADE: "0",
    },
  });
  let stdout = "";
  let stderr = "";
  fx.stdout.setEncoding("utf8").on("data", (c) => (stdout += c));
  fx.stderr.setEncoding("utf8").on("data", (c) => (stderr += c));
  fx.on("error", (err) => {
    emit({ t: "result", exit: 127, stdout: "", stderr: `cannot run fx: ${err.message}` });
    process.exit(0);
  });
  fx.on("close", (code) => {
    emit({ t: "result", exit: code ?? 1, stdout, stderr: stderr.slice(-4000) });
    server.close();
    process.exit(0);
  });
});
