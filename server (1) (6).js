// ANVAR ENGLISH PRO — AI server (Node.js 18+, qo'shimcha paket kerak emas)
//
// Nima qiladi:
//   1) index.html ni o'zi ochib beradi:   http://localhost:3000
//   2) /ping        — sayt serverni shu orqali topadi
//   3) /chat, /chat-stream — haqiqiy AI suhbat (Anthropic API) + 4 xil xarakter (persona)
//
// Ishga tushirish: start.bat (Windows) yoki  node server.js
// Kalit .env faylda:  ANTHROPIC_API_KEY=sk-ant-...
// Qo'shimcha: PORT, MODEL, ALLOW_ORIGIN

const http = require("http");
const fs = require("fs");
const path = require("path");

try {
  for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
    }
  }
} catch (e) { /* .env yo'q — muammo emas */ }

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.MODEL || "claude-sonnet-5-5";
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";

if (!API_KEY) console.warn("Ogohlantirish: ANTHROPIC_API_KEY berilmagan (.env faylga yozing) — AI suhbat ishlamaydi, sayt tayyor rejimda ishlaydi.");

/* ---------------- Yordamchilar ---------------- */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 50_000) { reject(new Error("too large")); req.destroy(); }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function sendJson(res, cors, status, obj) {
  res.writeHead(status, { ...cors, "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return true; }
  arr.push(now);
  hits.set(key, arr);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (!v.some((t) => now - t < 60_000)) hits.delete(k);
}, 300_000).unref();

/* ---------------- AI suhbat va 4 xil xarakter ---------------- */
const FORMAT =
  "Format: first the English reply. Then a line containing only three dashes (---). Then a short Uzbek translation of your reply matching the same persona tone.";

const PERSONA_PROMPTS = {
  angry:
    "Your persona is strict, impatient, and demanding ('Jahldor'). Do not tolerate lazy mistakes; scold the student briefly and sharply in a humorous way when they make errors, then demand the right answer.",
  kind:
    "Your persona is warm, patient, and deeply encouraging ('Mehribon'). Praise every effort enthusiastically and comfort the student even if they forget everything.",
  sarcastic:
    "Your persona is witty, dry, and sarcastic ('Kinoyali'). Make clever, mildly teasing remarks about their mistakes, while still giving accurate and helpful corrections.",
  neutral:
    "Your persona is calm, objective, and concise ('Neytral'). Keep replies straightforward without emotional exaggeration.",
};

function systemPrompt(name, mode, persona = "kind", profile = "") {
  const style = PERSONA_PROMPTS[persona] || PERSONA_PROMPTS.kind;
  const ctx = profile ? `Student onboarding profile: ${profile}.` : "";
  if (mode === "ielts") {
    return [
      `You are an IELTS Speaking examiner. ${style} ${ctx} The candidate's name is "${name}". Use the name rarely and naturally.`,
      "Run the test in order. Part 1: greet, then ask 4-5 short everyday questions (home, studies, hobbies). Part 2: give one cue card topic with 3-4 bullet prompts, tell the candidate to speak for 1-2 minutes, and after they finish ask one short follow-up. Part 3: ask 4-5 deeper discussion questions related to the Part 2 topic.",
      "Ask only ONE question at a time. Keep each turn to 1-3 short spoken sentences, no lists or emoji, except the Part 2 cue card. Do not correct the candidate during the test and do not give hints.",
      "After Part 3 (or if the candidate says they want to finish), give feedback: an estimated band score for Fluency & Coherence, Lexical Resource and Grammatical Range & Accuracy, plus the 3 most important mistakes with corrected versions. You only receive a speech-to-text transcript, so say clearly that Pronunciation cannot be assessed.",
      FORMAT,
    ].join("\n");
  }
  return [
    `You are an English conversation partner and tutor for an Uzbek-speaking student. ${style} ${ctx} The student's name is "${name}". Address the student by this exact name: use it in your first reply and then in about every second reply, never in every sentence.`,
    "This is a spoken conversation: reply in 1-2 short, simple sentences, no lists, no emoji, no markdown. Always end with one easy question to keep the conversation going.",
    "If the student makes a mistake, briefly say the corrected sentence in character, then continue.",
    FORMAT,
  ].join("\n");
}

function parseChat(raw) {
  const body = JSON.parse(raw);
  const name = String(body.name || "friend").slice(0, 30).replace(/[\r\n"]/g, " ");
  const mode = body.mode === "ielts" ? "ielts" : "free";
  const persona = ["angry", "kind", "sarcastic", "neutral"].includes(body.persona) ? body.persona : "kind";
  const profile = String(body.profile || "").slice(0, 250).replace(/[\r\n"]/g, " ");
  const messages = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 1500) }));
  while (messages.length && messages[0].role !== "user") messages.shift();
  if (!messages.length || messages[messages.length - 1].role !== "user") throw new Error("bad messages");
  return { name, mode, persona, profile, messages };
}

function apiBody({ name, mode, persona, profile, messages }, stream, signal) {
  return {
    method: "POST",
    headers: { "x-api-key": API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: mode === "ielts" ? 700 : 300, system: systemPrompt(name, mode, persona, profile), messages, stream }),
    signal,
  };
}

async function handleChat(req, res, cors, streamMode) {
  const ctrl = new AbortController();
  res.on("close", () => ctrl.abort());
  let started = false;
  try {
    if (!API_KEY) throw new Error("ANTHROPIC_API_KEY yo'q");
    const parsed = parseChat(await readBody(req));
    if (!streamMode) {
      const r = await fetch("https://api.anthropic.com/v1/messages", apiBody(parsed, false, ctrl.signal));
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error?.message || "API xatosi");
      const reply = (data.content || []).map((b) => b.text || "").join("").trim();
      return sendJson(res, cors, 200, { reply });
    }
    const r = await fetch("https://api.anthropic.com/v1/messages", apiBody(parsed, true, ctrl.signal));
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      throw new Error(data?.error?.message || "API xatosi");
    }
    res.writeHead(200, { ...cors, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    started = true;
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = block.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        let ev = null;
        try { ev = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") res.write(`data: ${JSON.stringify({ t: ev.delta.text })}\n\n`);
        else if (ev.type === "error") throw new Error(ev.error?.message || "stream xatosi");
      }
    }
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (e) {
    if (e.name !== "AbortError") console.error(e.message);
    if (started) {
      if (!res.writableEnded) { res.write(`data: ${JSON.stringify({ error: "server error" })}\n\n`); res.end(); }
    } else if (!res.headersSent) sendJson(res, cors, 500, { error: "server error" });
  }
}

/* ---------------- Marshrutlar ---------------- */
const server = http.createServer(async (req, res) => {
  const cors = {
    "Access-Control-Allow-Origin": ALLOW_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  const p = (req.url || "").split("?")[0];

  if (req.method === "GET" && p === "/ping") return sendJson(res, cors, 200, { app: "anvar-english", ai: !!API_KEY });

  if (req.method === "GET" && (p === "/" || p === "/index.html")) {
    try {
      const html = fs.readFileSync(path.join(__dirname, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      return res.end(html);
    } catch (e) {
      res.writeHead(404, cors);
      return res.end("index.html server.js bilan bir papkada bo'lishi kerak.");
    }
  }

  if (req.method === "POST" && (p === "/chat" || p === "/chat-stream")) {
    if (limited("chat:" + (req.socket.remoteAddress || "?"), 40, 60_000)) return sendJson(res, cors, 429, { error: "Juda tez. Biroz kuting." });
    return handleChat(req, res, cors, p === "/chat-stream");
  }

  res.writeHead(404, cors);
  res.end();
});

server.listen(PORT, () => console.log(`Server: http://localhost:${PORT}  (saytni shu manzildan ham ochishingiz mumkin)`));
