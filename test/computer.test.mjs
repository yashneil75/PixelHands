import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { createComputer } from "pixelhands";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAIAAAA8r+mnAAAAEUlEQVR4nGOoV+7BihioJwEAXq0lwdWsLikAAAAASUVORK5CYII=",
  "base64",
);
const display = { width: 8, height: 4, scaleFactor: 1 };

function makeBackend(overrides = {}) {
  const calls = [];
  let geometry = display;
  return {
    calls,
    setGeometry(next) {
      geometry = next;
    },
    platform: "win32",
    async capture() {
      return { png, width: 8, height: 4, display };
    },
    async displayGeometry() {
      return geometry;
    },
    async perform(action) {
      calls.push(action);
      return { effect: "confirmed" };
    },
    async close() {
      calls.push("close");
    },
    ...overrides,
  };
}

test("encodes a screenshot and projects coordinates for every pointer action", async () => {
  const backend = makeBackend();
  const computer = await createComputer({ backend });
  try {
    const { frameId, width, height, mimeType, bytes } = await computer.screenshot({
      format: "jpeg",
      maxSide: 4,
    });
    assert.deepEqual([width, height, mimeType], [4, 2, "image/jpeg"]);
    assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xd8]);

    assert.deepEqual(
      await computer.act({ action: "click", frameId, x: 3, y: 1, count: 2 }),
      { effect: "confirmed" },
    );
    await computer.act({ action: "move", frameId, x: 2, y: 0 });
    await computer.act({ action: "drag", frameId, from: { x: 0, y: 0 }, to: { x: 3, y: 1 }, durationMs: 250 });
    await computer.act({ action: "scroll", frameId, x: 3, y: 1, direction: "down" });
    await computer.act({ action: "key", chord: "Control+Return" });
    await computer.act({ action: "type", text: "hello" });

    assert.deepEqual(backend.calls, [
      { action: "click", x: 6, y: 2, button: "left", count: 2 },
      { action: "move", x: 4, y: 0 },
      { action: "drag", from: { x: 0, y: 0 }, to: { x: 6, y: 2 }, durationMs: 250 },
      { action: "scroll", x: 6, y: 2, direction: "down", amount: 3 },
      { action: "key", key: "enter", modifiers: ["ctrl"] },
      { action: "type", text: "hello" },
    ]);
  } finally {
    await computer.close();
  }
});

test("rejects invalid, outdated, out-of-bounds, and changed-display inputs", async () => {
  const backend = makeBackend();
  const computer = await createComputer({ backend });
  try {
    const first = await computer.screenshot();
    const second = await computer.screenshot();
    assert.equal(second.mimeType, "image/png");
    assert.deepEqual(second.bytes, png);
    assert.notEqual(first.frameId, second.frameId);
    const click = { action: "click", frameId: second.frameId, x: 0, y: 0 };
    await assert.rejects(computer.act({ ...click, x: -1 }), { name: "ZodError" });
    await assert.rejects(computer.act({ ...click, frameId: first.frameId }), /frame is stale/);
    await assert.rejects(computer.act({ ...click, x: 8 }), /outside the screenshot/);
    backend.setGeometry({ ...display, width: 9 });
    await assert.rejects(computer.act(click), /geometry changed/);
    await assert.rejects(computer.act(click), /frame is stale/);
    assert.deepEqual(backend.calls, []);
  } finally {
    await computer.close();
  }
});

test("serializes calls, skips aborted queued input, and closes once after admitted work", async () => {
  const pending = Promise.withResolvers();
  const backend = makeBackend({
    async perform(action) {
      this.calls.push(action.text);
      if (action.text === "first") {
        await pending.promise;
      }
      return { effect: "unverifiable" };
    },
  });
  const computer = await createComputer({ backend });
  const first = computer.act({ action: "type", text: "first" });
  const abort = new AbortController();
  const skipped = computer.act({ action: "type", text: "skipped" }, { signal: abort.signal });
  const last = computer.act({ action: "type", text: "last" });
  abort.abort();
  const closing = computer.close();
  assert.equal(computer.close(), closing);

  await assert.rejects(computer.screenshot(), /session is closed/);
  await setImmediate();
  assert.deepEqual(backend.calls, ["first"]);
  pending.resolve();
  await first;
  await assert.rejects(skipped, { name: "AbortError" });
  await last;
  await closing;
  assert.deepEqual(backend.calls, ["first", "last", "close"]);
});
