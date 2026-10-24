import { createHash, randomBytes } from "node:crypto";

export type ContextDiagnosticReason = "transcript-index-unready" | "anchor-mismatch";
export type ContextDiagnosticStage =
  | "snapshot-anchor-validation"
  | "anchor-validation"
  | "post-worker-anchor-validation";
export type ContextDiagnosticPhase =
  | "context-preparation"
  | "pre-review"
  | "review-run"
  | "post-review";
type ContextDiagnostic = Readonly<{
  version: 1;
  reason: ContextDiagnosticReason;
  stage: ContextDiagnosticStage;
  sourceToken: string;
}>;
type LogDiagnostic = Omit<ContextDiagnostic, "sourceToken"> & { phase: ContextDiagnosticPhase };
const details = new WeakMap<object, ContextDiagnostic>();
const reasons = new Set<string>(["transcript-index-unready", "anchor-mismatch"]);
const stages = new Set<string>([
  "snapshot-anchor-validation",
  "anchor-validation",
  "post-worker-anchor-validation",
]);
const phases = new Set<string>(["context-preparation", "pre-review", "review-run", "post-review"]);
const sourceFields = [
  "agentId",
  "sessionId",
  "sessionKey",
  "storePath",
  "generation",
  "entryId",
  "rawSeq",
  "effectiveParentId",
  "activeMessagePosition",
] as const;

function objectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function contextFenceEnvelope(value: unknown): value is Record<string, unknown> {
  return (
    objectRecord(value) &&
    Object.getOwnPropertyDescriptor(value, "kind")?.value === "fence" &&
    Object.getOwnPropertyDescriptor(value, "message")?.value ===
      "Completed-turn transcript anchor changed"
  );
}

/** Opaque original-source binding, never a log field or execution authority. */
export function sourceToken(anchor: unknown): string | undefined {
  try {
    if (!objectRecord(anchor)) {
      return undefined;
    }
    const descriptors = Object.getOwnPropertyDescriptors(anchor);
    if (sourceFields.some((key) => !Object.hasOwn(descriptors[key] ?? {}, "value"))) {
      return undefined;
    }
    const values: Record<string, unknown> = Object.fromEntries(
      sourceFields.map((key) => [key, descriptors[key]!.value]),
    );
    if (
      !["agentId", "sessionId", "sessionKey", "storePath", "entryId", "generation"].every(
        (key) => typeof values[key] === "string",
      ) ||
      !["rawSeq", "activeMessagePosition"].every(
        (key) =>
          typeof values[key] === "number" &&
          Number.isSafeInteger(values[key]) &&
          values[key] >= 0,
      ) ||
      !(values.effectiveParentId === null || typeof values.effectiveParentId === "string")
    ) {
      return undefined;
    }
    return createHash("sha256")
      .update(JSON.stringify(sourceFields.map((key) => values[key])))
      .digest("hex");
  } catch {
    return undefined;
  }
}

function validated(value: unknown): ContextDiagnostic | undefined {
  try {
    if (
      !objectRecord(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).some((key) => typeof key !== "string") ||
      Object.getOwnPropertyNames(value).toSorted().join(",") !==
        "reason,sourceToken,stage,version" ||
      Object.values(Object.getOwnPropertyDescriptors(value)).some(
        (descriptor) => !Object.hasOwn(descriptor, "value"),
      )
    ) {
      return undefined;
    }
    if (
      value.version !== 1 ||
      typeof value.reason !== "string" ||
      !reasons.has(value.reason) ||
      typeof value.stage !== "string" ||
      !stages.has(value.stage) ||
      typeof value.sourceToken !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.sourceToken)
    ) {
      return undefined;
    }
    return Object.freeze({
      version: 1,
      // SAFETY: Both bounded enum values were checked above.
      reason: value.reason as ContextDiagnosticReason,
      stage: value.stage as ContextDiagnosticStage,
      sourceToken: value.sourceToken,
    });
  } catch {
    return undefined;
  }
}

export function annotateContextFailure<T>(
  error: T,
  anchor: unknown,
  reason: ContextDiagnosticReason,
  stage: ContextDiagnosticStage,
): T {
  const detail = validated({ version: 1, reason, stage, sourceToken: sourceToken(anchor) });
  if (detail && objectRecord(error)) {
    details.set(error, detail);
  }
  return error;
}

export function serializeContextDiagnostic(error: unknown): ContextDiagnostic | undefined {
  return objectRecord(error) ? details.get(error) : undefined;
}

/** Diagnostic-only request binding; never a grant of source or execution authority. */
export function createContextDiagnosticRequest(): string | undefined {
  try {
    return randomBytes(16).toString("hex");
  } catch {
    return undefined;
  }
}

/** The domain worker binds already-produced detail to this request before transport. */
export function bindContextDiagnosticRequest(envelope: unknown, requestToken?: string): void {
  try {
    if (!contextFenceEnvelope(envelope) || !requestToken || !/^[a-f0-9]{32}$/.test(requestToken)) {
      return;
    }
    const detail = validated(Object.getOwnPropertyDescriptor(envelope, "contextDiagnostic")?.value);
    if (detail) {
      Object.defineProperty(envelope, "contextDiagnostic", {
        value: { ...detail, requestToken },
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  } catch {
    // Binding failure drops diagnostic detail, not the original refusal.
  }
}

/** Missing, stale or malformed task metadata stays an ordinary domain failure. */
export function acceptContextDiagnosticReply(envelope: unknown, expectedToken?: string): void {
  try {
    if (objectRecord(envelope)) {
      details.delete(envelope);
    }
    if (
      !contextFenceEnvelope(envelope) ||
      !expectedToken ||
      !/^[a-f0-9]{32}$/.test(expectedToken)
    ) {
      return;
    }
    const wire = Object.getOwnPropertyDescriptor(envelope, "contextDiagnostic")?.value;
    if (
      !objectRecord(wire) ||
      Object.getPrototypeOf(wire) !== Object.prototype ||
      Reflect.ownKeys(wire).some((key) => typeof key !== "string") ||
      Object.getOwnPropertyNames(wire).toSorted().join(",") !==
        "reason,requestToken,sourceToken,stage,version" ||
      Object.values(Object.getOwnPropertyDescriptors(wire)).some(
        (descriptor) => !Object.hasOwn(descriptor, "value"),
      ) ||
      wire.requestToken !== expectedToken
    ) {
      return;
    }
    const detail = validated({
      version: wire.version,
      reason: wire.reason,
      stage: wire.stage,
      sourceToken: wire.sourceToken,
    });
    if (detail) {
      details.set(envelope, detail);
    }
  } catch {
    // Accessors and malformed payloads never replace the original refusal.
  }
}

/** Decode only task-bound domain detail; transport failures never enter this adapter. */
export function decodeContextDiagnostic<T extends Error>(error: T, envelope: unknown): T {
  try {
    const detail = contextFenceEnvelope(envelope) ? details.get(envelope) : undefined;
    if (detail && error.message === "Completed-turn transcript anchor changed") {
      details.set(error, detail);
    }
  } catch {
    // Optional envelope metadata cannot replace a domain refusal.
  }
  return error;
}

export function readContextDiagnostic(
  error: unknown,
  anchor: unknown,
): ContextDiagnostic | undefined {
  try {
    const expectedSource = sourceToken(anchor);
    const seen = new Set<object>();
    // Prepared admission preserves its refusal as cause; do not infer from wrapper text.
    for (let depth = 0; depth < 8 && objectRecord(error) && !seen.has(error); depth++) {
      seen.add(error);
      const detail = details.get(error);
      if (detail) {
        return detail.sourceToken === expectedSource ? detail : undefined;
      }
      error = Object.getOwnPropertyDescriptor(error, "cause")?.value;
    }
  } catch {
    // Opaque errors and cause accessors carry no diagnostic evidence.
  }
  return undefined;
}

export function recordContextDiagnostic(
  error: unknown,
  anchor: unknown,
  phase: ContextDiagnosticPhase,
  write: (detail: LogDiagnostic) => void,
): void {
  try {
    const detail = readContextDiagnostic(error, anchor);
    if (detail && phases.has(phase)) {
      write({ version: detail.version, reason: detail.reason, stage: detail.stage, phase });
    }
  } catch {
    // Logging failure is never a reason to retry or replace the refusal.
  }
}
