import { randomUUID } from "node:crypto";
import type { ActionResult as NativeActionResult, ToolResult } from "@trycua/cua-driver";
import { z } from "zod";
import type { ActionResult, ComputerBackend } from "./index.js";

const dimensions = {
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  scale_factor: z.number().positive(),
};
const screenSize = z.object(dimensions);
const desktopGeometry = z.object({
  screen_width: dimensions.width,
  screen_height: dimensions.height,
  scale_factor: dimensions.scale_factor,
  screenshot_width: dimensions.width,
  screenshot_height: dimensions.height,
});

function assertSuccess(result: ToolResult): void {
  if (result.isError) {
    const code = result.errorCode ? ` (${result.errorCode})` : "";
    throw new Error(`CUA Driver: ${result.text || "operation failed"}${code}`);
  }
}

function structured(result: ToolResult): unknown {
  assertSuccess(result);
  if (!result.structuredJson) {
    throw new Error("CUA Driver returned no display geometry");
  }
  return JSON.parse(result.structuredJson) as unknown;
}

// The trusted session and explicit desktop target are adapted from OpenClaw's
// direct CUA Driver provider.
export async function openNativeBackend(): Promise<ComputerBackend> {
  const sdk = await import("@trycua/cua-driver").catch((cause: unknown) => {
    throw new Error("Unable to load CUA Driver for this platform", { cause });
  });
  const mode = sdk.SessionPermissionMode.Unrestricted;
  const maxSessionTtlSeconds = 3_600n;
  const maxIdleTtlSeconds = 300n;
  const runtime = sdk.CuaDriver.createConfigured({
    claudeCodeCompatibility: false,
    authorization: {
      allowedModes: [mode],
      compatibilityMode: mode,
      unrestrictedAcknowledged: true,
      maxSessionTtlSeconds,
      maxIdleTtlSeconds,
    },
  });
  const publicSession = `computer-use-${randomUUID()}`;
  const shutdown = async () => {
    try {
      await runtime.shutdown();
    } finally {
      if (runtime instanceof sdk.CuaDriver) {
        runtime.uniffiDestroy();
      }
    }
  };

  const session = await (async () => {
    try {
      if (!runtime.isAvailable()) {
        throw new Error("CUA Driver could not access a local desktop");
      }
      const trusted = sdk.createTrustedSession(runtime, {
        mode,
        ttlSeconds: maxSessionTtlSeconds,
        idleTtlSeconds: maxIdleTtlSeconds,
        publicSession,
      });
      try {
        await trusted.startSession({ session: publicSession });
        return trusted;
      } catch (error) {
        trusted.close();
        throw error;
      }
    } catch (error) {
      await shutdown();
      throw error;
    }
  })();

  const target = sdk.ActionTarget.Desktop.new({ displayId: "primary" });
  const buttons = { left: sdk.ClickButton.Left, middle: sdk.ClickButton.Middle, right: sdk.ClickButton.Right };
  const directions = {
    up: sdk.ScrollDirection.Up,
    down: sdk.ScrollDirection.Down,
    left: sdk.ScrollDirection.Left,
    right: sdk.ScrollDirection.Right,
  };
  const effects = {
    [sdk.ActionEffect.Confirmed]: "confirmed",
    [sdk.ActionEffect.Partial]: "partial",
    [sdk.ActionEffect.Unverifiable]: "unverifiable",
    [sdk.ActionEffect.SuspectedNoop]: "suspected_noop",
  } as const;

  function actionResult(result?: NativeActionResult): ActionResult {
    if (result?.effect === sdk.ActionEffect.Refused) {
      throw new Error(result.summary ?? "CUA Driver refused input");
    }
    return {
      effect: result ? effects[result.effect] ?? "unverifiable" : "unverifiable",
      ...(result?.summary ? { summary: result.summary } : {}),
      ...(result?.hint ? { hint: result.hint } : {}),
    };
  }

  return {
    platform: process.platform,
    async capture(signal) {
      const result = await session.getDesktopState({ session: publicSession }, signal ? { signal } : undefined);
      const geometry = desktopGeometry.parse(structured(result));
      const image = result.images.find((entry) => entry.mimeType === "image/png");
      if (!image?.dataBase64) {
        throw new Error("CUA Driver returned no PNG screenshot");
      }
      if (
        process.platform !== "darwin" &&
        (geometry.screen_width !== geometry.screenshot_width ||
          geometry.screen_height !== geometry.screenshot_height)
      ) {
        throw new Error("CUA Driver reported different capture and input coordinate spaces");
      }
      return {
        png: Buffer.from(image.dataBase64, "base64"),
        width: geometry.screenshot_width,
        height: geometry.screenshot_height,
        display: {
          width: geometry.screen_width,
          height: geometry.screen_height,
          scaleFactor: geometry.scale_factor,
        },
      };
    },
    async displayGeometry(signal) {
      const result = await session.getScreenSize({ session: publicSession }, signal ? { signal } : undefined);
      const { width, height, scale_factor } = screenSize.parse(structured(result));
      return { width, height, scaleFactor: scale_factor };
    },
    async perform(action, signal) {
      const options = signal ? { signal } : undefined;
      let result: ToolResult;
      switch (action.action) {
        case "click":
          return actionResult(await session.click({
            position: sdk.ClickPosition.Coordinates.new({ x: action.x, y: action.y }),
            deliveryMode: sdk.InputDeliveryMode.Foreground,
            button: buttons[action.button],
            count: action.count,
            target,
          }, options));
        case "move":
          result = await session.moveCursor({ x: action.x, y: action.y, target }, options);
          break;
        case "drag":
          result = await session.drag({
            fromX: action.from.x,
            fromY: action.from.y,
            toX: action.to.x,
            toY: action.to.y,
            durationMs: action.durationMs === undefined ? undefined : BigInt(action.durationMs),
            target,
          }, options);
          break;
        case "scroll":
          result = await session.scroll({
            x: action.x,
            y: action.y,
            direction: directions[action.direction],
            amount: BigInt(action.amount),
            by: sdk.ScrollBy.Line,
            target,
          }, options);
          break;
        case "type":
          result = await session.typeText({ text: action.text, target }, options);
          break;
        case "key":
          result = await session.pressKey({ key: action.key, modifiers: action.modifiers, target }, options);
          break;
      }
      assertSuccess(result);
      return actionResult(result.action);
    },
    async close() {
      try {
        await session.endSession({ session: publicSession });
      } catch (error) {
        if (
          !sdk.DriverError.Shutdown.instanceOf(error) &&
          !(sdk.DriverError.Tool.instanceOf(error) &&
            error.inner.errorCode === "permission_denied" &&
            error.inner.message === "Permission denied: authorization context expired")
        ) {
          throw error;
        }
      } finally {
        try {
          session.close();
        } finally {
          await shutdown();
        }
      }
    },
  };
}
