import { test } from "node:test";
import assert from "node:assert/strict";
import { startMock } from "./mock-rtdb.js";

test("put, get, patch, delete, and null-pruning", async () => {
  const m = await startMock({ port: 0 });
  const j = async (p, o) => {
    const r = await fetch(m.url + p + ".json", o);
    const t = await r.text();
    return t && t !== "null" ? JSON.parse(t) : null;
  };

  await j("/rooms/A/meta", { method: "PUT", body: JSON.stringify({ h: "p1", r: "attack" }) });
  assert.deepEqual(await j("/rooms/A/meta"), { h: "p1", r: "attack" });

  await j("/rooms/A/meta", { method: "PATCH", body: JSON.stringify({ r: "score" }) });
  assert.deepEqual(await j("/rooms/A/meta"), { h: "p1", r: "score" });

  // a null value deletes the key, and an emptied node stops existing
  await j("/rooms/A/meta", { method: "PATCH", body: JSON.stringify({ h: null, r: null }) });
  assert.equal(await j("/rooms/A/meta"), null);

  await j("/rooms/A", { method: "DELETE" });
  assert.equal(await j("/rooms/A"), null);
  await m.close();
});

test("etag compare-and-swap rejects a stale write with 412", async () => {
  const m = await startMock({ port: 0 });
  await fetch(m.url + "/seat/w.json", { method: "PUT", body: "1" });

  const r1 = await fetch(m.url + "/seat/w.json", { headers: { "X-Firebase-ETag": "true" } });
  const tag = r1.headers.get("etag");
  assert.ok(tag, "GET with X-Firebase-ETag must return an ETag header");

  // somebody else writes first, invalidating our tag
  await fetch(m.url + "/seat/w.json", { method: "PUT", body: "2" });

  const stale = await fetch(m.url + "/seat/w.json", {
    method: "PUT", body: "99", headers: { "if-match": tag }
  });
  assert.equal(stale.status, 412);
  assert.equal(m.tree().seat.w, 2);
  await m.close();
});

test("streams an initial put then patches on change", async () => {
  const m = await startMock({ port: 0 });
  await fetch(m.url + "/rooms/A/meta.json", { method: "PUT", body: JSON.stringify({ h: "p1" }) });

  const res = await fetch(m.url + "/rooms/A.json", { headers: { Accept: "text/event-stream" } });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const nextEvent = async () => {
    while (!buf.includes("\n\n")) buf += dec.decode((await reader.read()).value, { stream: true });
    const raw = buf.slice(0, buf.indexOf("\n\n"));
    buf = buf.slice(buf.indexOf("\n\n") + 2);
    return {
      event: /^event: (.*)$/m.exec(raw)[1],
      data: JSON.parse(/^data: (.*)$/m.exec(raw)[1]),
    };
  };

  const first = await nextEvent();
  assert.equal(first.event, "put");
  assert.equal(first.data.path, "/");
  assert.deepEqual(first.data.data, { meta: { h: "p1" } });

  await fetch(m.url + "/rooms/A/seat/p1.json", { method: "PUT", body: JSON.stringify({ n: "Ada" }) });
  const second = await nextEvent();
  assert.equal(second.event, "put");
  assert.equal(second.data.path, "/seat/p1");
  assert.deepEqual(second.data.data, { n: "Ada" });

  await reader.cancel();
  await m.close();
});
