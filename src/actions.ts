import { z } from "zod";

const point = z.strictObject({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
});
const frameId = z.string().uuid();
const button = z.enum(["left", "right", "middle"]);
const direction = z.enum(["up", "down", "left", "right"]);

export const computerActionSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("click"),
    frameId,
    ...point.shape,
    button: button.optional(),
    count: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  }),
  z.strictObject({ action: z.literal("move"), frameId, ...point.shape }),
  z.strictObject({
    action: z.literal("drag"),
    frameId,
    from: point,
    to: point,
    durationMs: z.number().int().positive().max(10_000).optional(),
  }),
  z.strictObject({
    action: z.literal("scroll"),
    frameId,
    ...point.shape,
    direction,
    amount: z.number().int().positive().max(50).optional(),
  }),
  z.strictObject({ action: z.literal("type"), text: z.string().min(1) }),
  z.strictObject({ action: z.literal("key"), chord: z.string().trim().min(1) }),
]);

export type ComputerAction = z.infer<typeof computerActionSchema>;
type Point = z.infer<typeof point>;

/** Coordinates passed to a backend use full-resolution capture pixels. */
export type BackendAction =
  | ({ action: "click"; button: z.infer<typeof button>; count: 1 | 2 | 3 } & Point)
  | ({ action: "move" } & Point)
  | { action: "drag"; from: Point; to: Point; durationMs?: number }
  | ({ action: "scroll"; direction: z.infer<typeof direction>; amount: number } & Point)
  | { action: "type"; text: string }
  | { action: "key"; key: string; modifiers: string[] };
