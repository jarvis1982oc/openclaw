import { expect, it, vi } from "vitest";
import {
  decodeSessionTranscriptWorkerReadError,
  encodeSessionTranscriptWorkerError,
} from "../config/sessions/session-history-worker-errors.js";
import { SessionTranscriptReadFenceError } from "../config/sessions/session-transcript-read-fence-error.js";
import {
  acceptContextDiagnosticReply,
  annotateContextFailure,
  bindContextDiagnosticRequest,
  decodeContextDiagnostic,
  readContextDiagnostic,
  recordContextDiagnostic,
  sourceToken,
} from "./transcript-context-diagnostic.js";

const anchor = {
  agentId: "synthetic-agent",
  sessionId: "synthetic-session",
  sessionKey: "agent:synthetic-agent:synthetic-session",
  storePath: "/synthetic/transcript.sqlite",
  generation: "synthetic-generation",
  entryId: "synthetic-entry",
  rawSeq: 2,
  effectiveParentId: null,
  activeMessagePosition: 1,
};
const requestToken = "1".repeat(32);
const message = "Completed-turn transcript anchor changed";
const wire = {
  version: 1,
  reason: "transcript-index-unready",
  stage: "snapshot-anchor-validation",
  sourceToken: sourceToken(anchor),
  requestToken,
};

it("carries only source- and request-bound domain detail and emits bounded raw log fields", () => {
  const original = annotateContextFailure(
    new SessionTranscriptReadFenceError(message),
    anchor,
    "transcript-index-unready",
    "snapshot-anchor-validation",
  );
  const encoded = encodeSessionTranscriptWorkerError(original);
  expect(encoded).toMatchObject({ kind: "fence", message });
  bindContextDiagnosticRequest(encoded, requestToken);
  const received = structuredClone(encoded);
  expect(received?.kind).toBe("fence");
  if (!received) {
    throw new Error("Missing fixture domain failure");
  }
  acceptContextDiagnosticReply(received, requestToken);
  const decoded = decodeSessionTranscriptWorkerReadError(received);
  expect(decoded).toBeInstanceOf(SessionTranscriptReadFenceError);
  expect(decoded.message).toBe(message);
  expect(readContextDiagnostic(decoded, { ...anchor, generation: "other" })).toBeUndefined();
  const write = vi.fn();
  recordContextDiagnostic(decoded, anchor, "context-preparation", write);
  expect(write).toHaveBeenCalledExactlyOnceWith({
    version: 1,
    reason: "transcript-index-unready",
    stage: "snapshot-anchor-validation",
    phase: "context-preparation",
  });
  expect(Object.keys(decoded)).not.toContain("contextDiagnostic");
  expect(JSON.stringify(write.mock.calls)).not.toContain(anchor.storePath);
  expect(JSON.stringify(write.mock.calls)).not.toContain(sourceToken(anchor));
  expect(JSON.stringify(write.mock.calls)).not.toContain(requestToken);
  expect(() =>
    recordContextDiagnostic(decoded, anchor, "review-run", () => {
      throw new Error("synthetic logging failure");
    }),
  ).not.toThrow();
  expect(decoded.message).toBe(message);
});

it.each([
  undefined,
  null,
  {},
  { ...wire, version: 2 },
  { ...wire, reason: "unknown" },
  { ...wire, stage: "model-execution" },
  { ...wire, sourceToken: "not-a-source-token" },
  { ...wire, requestToken: undefined },
  { ...wire, requestToken: "2".repeat(32) },
  { ...wire, extra: "synthetic-private-payload" },
  Object.assign(Object.create({ inherited: true }), wire),
  { ...wire, [Symbol("extra")]: true },
])("leaves malformed or unrelated metadata as the same generic refusal (%j)", (detail) => {
  const failure = { kind: "fence" as const, message, contextDiagnostic: detail };
  acceptContextDiagnosticReply(failure, requestToken);
  const decoded = decodeSessionTranscriptWorkerReadError(failure);
  expect(decoded).toBeInstanceOf(SessionTranscriptReadFenceError);
  expect(decoded.message).toBe(message);
  expect(readContextDiagnostic(decoded, anchor)).toBeUndefined();
});

it("does not read diagnostic or source accessors and never classifies message lookalikes", () => {
  const getter = vi.fn(() => wire);
  for (const failure of [
    Object.defineProperty({ kind: "fence" as const, message }, "contextDiagnostic", {
      get: getter,
    }),
    {
      kind: "fence" as const,
      message,
      contextDiagnostic: Object.defineProperty({ ...wire }, "reason", { get: getter }),
    },
  ]) {
    acceptContextDiagnosticReply(failure, requestToken);
    expect(
      readContextDiagnostic(decodeSessionTranscriptWorkerReadError(failure), anchor),
    ).toBeUndefined();
  }
  expect(
    sourceToken(Object.defineProperty({ ...anchor }, "generation", { get: getter })),
  ).toBeUndefined();
  expect(getter).not.toHaveBeenCalled();
  const unbound = { kind: "fence" as const, message, contextDiagnostic: wire };
  expect(
    readContextDiagnostic(decodeSessionTranscriptWorkerReadError(unbound), anchor),
  ).toBeUndefined();
  for (const other of [
    new Error(message),
    new SessionTranscriptReadFenceError(message),
    new Error("worker task timed out"),
    new Error("worker exited"),
  ]) {
    expect(readContextDiagnostic(other, anchor)).toBeUndefined();
  }
  const ownership = {
    kind: "fence" as const,
    message: "Completed-turn anchor belongs to another transcript",
    contextDiagnostic: wire,
  };
  acceptContextDiagnosticReply(ownership, requestToken);
  expect(
    readContextDiagnostic(decodeSessionTranscriptWorkerReadError(ownership), anchor),
  ).toBeUndefined();
});

it("does not classify unknown envelope kinds or accessor-backed envelope messages", () => {
  for (const kind of [undefined, "unknown", "projection"]) {
    const envelope = { kind, message, contextDiagnostic: wire };
    acceptContextDiagnosticReply(envelope, requestToken);
    const error = decodeContextDiagnostic(new SessionTranscriptReadFenceError(message), envelope);
    expect(readContextDiagnostic(error, anchor)).toBeUndefined();
  }
  const getter = vi.fn(() => message);
  const envelope = Object.defineProperty(
    { kind: "fence" as const, contextDiagnostic: wire },
    "message",
    { get: getter },
  );
  acceptContextDiagnosticReply(envelope, requestToken);
  expect(getter).not.toHaveBeenCalled();
  // The pre-existing domain decoder may read message. The optional diagnostic never does.
  const error = decodeContextDiagnostic(new SessionTranscriptReadFenceError(message), envelope);
  expect(getter).not.toHaveBeenCalled();
  expect(readContextDiagnostic(error, anchor)).toBeUndefined();
});

it("reads only privately retained detail through bounded admission causes", () => {
  const refusal = annotateContextFailure(
    new SessionTranscriptReadFenceError(message),
    anchor,
    "anchor-mismatch",
    "anchor-validation",
  );
  const wrapped = new Error("source execution authority is no longer active", { cause: refusal });
  expect(readContextDiagnostic(wrapped, anchor)?.reason).toBe("anchor-mismatch");
  expect(readContextDiagnostic(wrapped, { ...anchor, sessionId: "other" })).toBeUndefined();
  const getter = vi.fn(() => refusal);
  const accessor = Object.defineProperty(new Error("wrapper"), "cause", { get: getter });
  expect(readContextDiagnostic(accessor, anchor)).toBeUndefined();
  expect(getter).not.toHaveBeenCalled();
  const cycle = new Error("cycle");
  cycle.cause = cycle;
  expect(readContextDiagnostic(cycle, anchor)).toBeUndefined();
  let tooDeep: Error = refusal;
  for (let depth = 0; depth < 8; depth++) {
    tooDeep = new Error("wrapper", { cause: tooDeep });
  }
  expect(readContextDiagnostic(tooDeep, anchor)).toBeUndefined();
});
