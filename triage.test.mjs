import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTriageServer } from "./server.mjs";

let server;
let baseUrl;

before(async () => {
  server = createTriageServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  baseUrl = "http://127.0.0.1:" + port;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function triage(body, { raw = false } = {}) {
  const response = await fetch(baseUrl + "/api/triage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ? body : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}

describe("POST /api/triage - validation", () => {
  it("empty text -> 400 invalid_input", async () => {
    const { status, data } = await triage({ text: "" });
    assert.equal(status, 400);
    assert.deepEqual(data, { status: "invalid_input" });
  });

  it("whitespace-only text -> 400 invalid_input", async () => {
    const { status, data } = await triage({ text: "   \n\t " });
    assert.equal(status, 400);
    assert.deepEqual(data, { status: "invalid_input" });
  });

  it("missing text field -> 400 invalid_input", async () => {
    const { status, data } = await triage({ message: "hi" });
    assert.equal(status, 400);
    assert.deepEqual(data, { status: "invalid_input" });
  });

  it("non-string text -> 400 invalid_input", async () => {
    const { status, data } = await triage({ text: 42 });
    assert.equal(status, 400);
    assert.deepEqual(data, { status: "invalid_input" });
  });

  it("broken JSON -> 400 invalid_input", async () => {
    const { status, data } = await triage("{ not json", { raw: true });
    assert.equal(status, 400);
    assert.deepEqual(data, { status: "invalid_input" });
  });
});

describe("POST /api/triage - success", () => {
  it("delivery topic with non-empty draft", async () => {
    const { status, data } = await triage({ text: "Когда будет доставка заказа?" });
    assert.equal(status, 200);
    assert.equal(data.status, "ready");
    assert.equal(data.topic, "delivery");
    assert.equal(typeof data.draft, "string");
    assert.ok(data.draft.trim().length > 0);
  });

  it("pricing topic", async () => {
    const { status, data } = await triage({ text: "Сколько стоит доставка до склада?" });
    assert.equal(status, 200);
    assert.equal(data.status, "ready");
    assert.ok(["delivery", "pricing"].includes(data.topic));
  });

  it("unknown topic becomes other", async () => {
    const { status, data } = await triage({ text: "Просто вопрос" });
    assert.equal(status, 200);
    assert.equal(data.status, "ready");
    assert.equal(data.topic, "other");
  });
});

describe("POST /api/triage - model failures -> manual_review", () => {
  it("model timeout -> 200 manual_review", async () => {
    const startedAt = Date.now();
    const { status, data } = await triage({ text: "Заявка [timeout] проверка" });
    const elapsed = Date.now() - startedAt;
    assert.equal(status, 200);
    assert.deepEqual(data, { status: "manual_review", topic: null, draft: null });
    assert.ok(elapsed < 900, "answer took " + elapsed + " ms, expected ~300 ms timeout");
  });

  it("mock provider error -> 200 manual_review", async () => {
    const { status, data } = await triage({ text: "Заявка [error] проверка" });
    assert.equal(status, 200);
    assert.deepEqual(data, { status: "manual_review", topic: null, draft: null });
  });

  it("model output is not JSON -> 200 manual_review", async () => {
    const { status, data } = await triage({ text: "Заявка [bad-json] проверка" });
    assert.equal(status, 200);
    assert.deepEqual(data, { status: "manual_review", topic: null, draft: null });
  });

  it("disallowed topic -> 200 manual_review", async () => {
    const { status, data } = await triage({ text: "Заявка [bad-topic] проверка" });
    assert.equal(status, 200);
    assert.deepEqual(data, { status: "manual_review", topic: null, draft: null });
  });

  it("empty draft -> 200 manual_review, empty string never reaches the client", async () => {
    const { status, data } = await triage({ text: "Заявка [empty-draft] проверка" });
    assert.equal(status, 200);
    assert.deepEqual(data, { status: "manual_review", topic: null, draft: null });
  });
});
