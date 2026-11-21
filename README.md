# Pixelhands

`pixelhands` is an in-process TypeScript SDK for giving an existing agent access to a desktop. It provides screenshots, clicks, pointer movement, drags, scrolls, text entry, and key chords. Your application chooses the model and decides when to call the SDK.

## Install

Requires Node.js 22 or later.

```sh
npm install pixelhands
```

## Use

```ts
import { computerActionSchema, createComputer } from "pixelhands";

const computer = await createComputer();
try {
  const frame = await computer.screenshot({ format: "jpeg", maxSide: 1280 });
  // Pass frame.bytes, frame.mimeType, and the image dimensions to your model.
  // Use coordinates relative to that image, in pixels from its top-left corner.
  async function applyClick(modelPoint: { x: number; y: number }) {
    const action = computerActionSchema.parse({
      ...modelPoint,
      action: "click",
      frameId: frame.frameId,
    });
    return computer.act(action);
  }

  // Replace this point with the one your model selects.
  // await applyClick({ x: 80, y: 60 });
  console.log(frame.width, frame.height);
} finally {
  await computer.close();
}
```

Coordinate actions use the latest screenshot’s `frameId`. The SDK scales resized-image pixels back to capture coordinates and rejects old frames and changed display geometry. Call `screenshot()` again to observe changes after an action. Text and key actions go to the currently focused app. The `effect` in an action result reports the backend’s confidence about what happened.

The default backend uses CUA Driver’s primary-display API. Run it in an interactive desktop session with screen capture and input permissions. The bundled driver targets Windows x64/ARM64, glibc Linux x64/ARM64, and macOS x64/ARM64. macOS requires Accessibility and Screen Recording permissions for the host process. If a native session expires, close it and create a new one.

Use `createComputer({ backend })` with a `ComputerBackend` to connect a different desktop or to test your agent without sending input to the host. A backend receives full-resolution capture pixels and is closed by the SDK. Calls on a computer instance run in order. Each screenshot and action accepts an optional `AbortSignal`.

## Source

This package adapts the local driver session, key chord parsing, and screenshot coordinate projection from the [OpenClaw CUA plugin](https://github.com/openclaw/openclaw/tree/16c1c2491708bf4743fcf0b611685c65f568cb50/extensions/cua-computer). OpenClaw’s MIT license is included.
