/**
 * Process-local, one-shot transport for runtime-action text.  Intent events
 * deliberately contain only stable identifiers; a restart therefore fails
 * closed rather than replaying private text from durable storage.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export interface RuntimeActionTextHandoffShape {
  readonly put: (input: {
    readonly commandId: string;
    readonly text: string;
  }) => Effect.Effect<boolean>;
  readonly take: (commandId: string) => Effect.Effect<string | undefined>;
  readonly discard: (commandId: string) => Effect.Effect<void>;
}
export class RuntimeActionTextHandoff extends Context.Service<
  RuntimeActionTextHandoff,
  RuntimeActionTextHandoffShape
>()("t3/orchestration/Services/RuntimeActionTextHandoff") {}
