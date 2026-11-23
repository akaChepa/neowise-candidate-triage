import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { classify } from "./mock-ai.mjs";

const html = await readFile(new URL("./index.html", import.meta.url));

// Сколько ждём модель. По заданию — не больше 300 мс.
const MODEL_TIMEOUT_MS = Number(process.env.MODEL_TIMEOUT_MS || 300);
// Ограничение на тело запроса: заявка — текст, 64 КБ с запасом.
const MAX_BODY_BYTES = 64 * 1024;
const ALLOWED_TOPICS = new Set(["delivery", "pricing", "other"]);

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function extractText(rawBody) {
  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { text } = parsed;
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  return trimmed;
}

function parseModelResult(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const topic = parsed.topic;
  const draft = parsed.draft;
  if (typeof topic !== "string" || !ALLOWED_TOPICS.has(topic)) return null;
  if (typeof draft !== "string" || draft.trim().length === 0) return null;
  return { topic, draft: draft.trim() };
}

async function runModel(text) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  try {
    const raw = await classify(text, { signal: controller.signal });
    return parseModelResult(raw);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function handleTriage(request, response) {
  let rawBody;
  try {
    rawBody = await readBody(request);
  } catch {
    return json(response, 400, { status: "invalid_input" });
  }
  const text = extractText(rawBody);
  if (text === null) {
    return json(response, 400, { status: "invalid_input" });
  }
  const result = await runModel(text);
  if (result === null) {
    return json(response, 200, { status: "manual_review", topic: null, draft: null });
  }
  return json(response, 200, { status: "ready", topic: result.topic, draft: result.draft });
}

export function createTriageServer() {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }
    try {
      await handleTriage(request, response);
    } catch {
      json(response, 500, { status: "server_error" });
    }
  });
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = Number(process.env.PORT || 3000);
  createTriageServer().listen(port, "127.0.0.1", () => {
    console.log("Сервер: http://127.0.0.1:" + port);
  });
}
