import { randomUUID } from "node:crypto";
import { createRastermill } from "rastermill";
import { z } from "zod";
import { computerActionSchema, type BackendAction, type ComputerAction } from "./actions.js";
import { parseKeyChord } from "./keys.js";
import { openNativeBackend } from "./native-backend.js";

export { computerActionSchema };
export type { BackendAction, ComputerAction };

export interface DisplayGeometry {
  width: number;
  height: number;
  scaleFactor: number;
}

export interface DesktopCapture {
  png: Uint8Array;
  width: number;
  height: number;
  display: DisplayGeometry;
}

export interface ActionResult {
  effect: "confirmed" | "partial" | "unverifiable" | "suspected_noop";
  summary?: string;
  hint?: string;
}

/** A caller-supplied backend is owned and closed by the computer session. */
export interface ComputerBackend {
  readonly platform: string;
  capture(signal?: AbortSignal): Promise<DesktopCapture>;
  displayGeometry(signal?: AbortSignal): Promise<DisplayGeometry>;
  perform(action: BackendAction, signal?: AbortSignal): Promise<ActionResult>;
  close(): Promise<void>;
}

const screenshotOptionsSchema = z.object({
  format: z.enum(["png", "jpeg"]).optional(),
  maxSide: z.number().int().positive().optional(),
  quality: z.number().int().min(1).max(100).optional(),
});

export type ScreenshotOptions = z.infer<typeof screenshotOptionsSchema> & {
  signal?: AbortSignal;
};

export interface Screenshot {
  frameId: string;
  width: number;
  height: number;
  mimeType: "image/png" | "image/jpeg";
  bytes: Uint8Array;
}

export interface Computer {
  screenshot(options?: ScreenshotOptions): Promise<Screenshot>;
  act(action: ComputerAction, options?: { signal?: AbortSignal }): Promise<ActionResult>;
  close(): Promise<void>;
}

type Frame = {
  id: string;
  width: number;
  height: number;
  nativeWidth: number;
  nativeHeight: number;
  display: DisplayGeometry;
};

// Adapted from OpenClaw's primary-display frame projection.
function scalePoint(frame: Frame, { x, y }: { x: number; y: number }) {
  if (x >= frame.width || y >= frame.height) {
    throw new RangeError("Coordinates are outside the screenshot");
  }
  return {
    x: Math.min(frame.nativeWidth - 1, Math.round((x * frame.nativeWidth) / frame.width)),
    y: Math.min(frame.nativeHeight - 1, Math.round((y * frame.nativeHeight) / frame.height)),
  };
}

/** Open a local primary desktop, or use an existing backend supplied by the caller. */
export async function createComputer(options: { backend?: ComputerBackend } = {}): Promise<Computer> {
  const backend = options.backend ?? (await openNativeBackend());
  const raster = createRastermill({ execution: "internal", limits: { inputPixels: 40_000_000 } });
  let frame: Frame | undefined;
  let queue = Promise.resolve();
  let closing: Promise<void> | undefined;

  function enqueue<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    if (closing) {
      return Promise.reject(new Error("Computer session is closed"));
    }
    const pending = queue.then(() => {
      signal?.throwIfAborted();
      return operation();
    });
    queue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  return {
    screenshot(options = {}) {
      const { signal } = options;
      return enqueue(signal, async () => {
        const { format = "png", maxSide, quality = 75 } = screenshotOptionsSchema.parse(options);
        frame = undefined;
        const capture = await backend.capture(signal);
        let { width, height } = capture;
        let bytes = capture.png;
        if (format === "jpeg" || (maxSide !== undefined && Math.max(width, height) > maxSide)) {
          const encoded = await raster.encode(bytes, {
            format,
            signal,
            ...(format === "jpeg" ? { quality } : {}),
            ...(maxSide !== undefined ? { resize: { maxSide, enlarge: false } } : {}),
          });
          ({ width, height, data: bytes } = encoded);
        }
        signal?.throwIfAborted();
        frame = {
          id: randomUUID(),
          width,
          height,
          nativeWidth: capture.width,
          nativeHeight: capture.height,
          display: { ...capture.display },
        };
        return { frameId: frame.id, width, height, mimeType: `image/${format}`, bytes };
      });
    },

    act(input, { signal } = {}) {
      // Parse before joining the queue so the SDK owns the validated action.
      const parsed = computerActionSchema.safeParse(input);
      if (!parsed.success) {
        return Promise.reject(parsed.error);
      }
      const action = parsed.data;
      return enqueue(signal, async () => {
        if (action.action === "type") {
          return backend.perform(action, signal);
        }
        if (action.action === "key") {
          return backend.perform({ action: "key", ...parseKeyChord(action.chord, backend.platform) }, signal);
        }

        if (!frame || frame.id !== action.frameId) {
          throw new Error("Screenshot frame is stale. Take a new screenshot before using coordinates.");
        }
        const current = await backend.displayGeometry(signal);
        signal?.throwIfAborted();
        if (
          current.width !== frame.display.width ||
          current.height !== frame.display.height ||
          current.scaleFactor !== frame.display.scaleFactor
        ) {
          frame = undefined;
          throw new Error("Display geometry changed. Take a new screenshot before using coordinates.");
        }

        switch (action.action) {
          case "click":
            return backend.perform({
              action: "click",
              ...scalePoint(frame, action),
              button: action.button ?? "left",
              count: action.count ?? 1,
            }, signal);
          case "move":
            return backend.perform({ action: "move", ...scalePoint(frame, action) }, signal);
          case "drag":
            return backend.perform({
              action: "drag",
              from: scalePoint(frame, action.from),
              to: scalePoint(frame, action.to),
              durationMs: action.durationMs,
            }, signal);
          case "scroll":
            return backend.perform({
              action: "scroll",
              ...scalePoint(frame, action),
              direction: action.direction,
              amount: action.amount ?? 3,
            }, signal);
        }
      });
    },

    close() {
      closing ??= queue.then(() => backend.close());
      return closing;
    },
  };
}
