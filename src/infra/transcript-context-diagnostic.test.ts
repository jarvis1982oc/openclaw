import { expect, it, vi } from "vitest";
import {
  decodeSessionTranscriptWorkerReadError,
  encodeSessionTranscriptWorkerError,
} from "../config/sessions/session-history-worker-errors.js";
import { SessionTranscriptReadFenceError } from "../config/sessions/session-transcript-read-fence-error.js";
import {
  annotateContextFailure,
  decodeContextDiagnostic,
  recordContextDiagnostic,
  retainContextDiagnosticReply,
  serializeContextDiagnostic,
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
const message = "Completed-turn transcript anchor changed";
const wire = serializeContextDiagnostic(
  annotateContextFailure(
    new SessionTranscriptReadFenceError(message),
    anchor,
    "transcript-index-unready",
    "snapshot-anchor-validation",
  ),
);

it("carries only validated source-bound domain detail and emits bounded raw log fields", () => {
  const original = annotateContextFailure(
    new SessionTranscriptReadFenceError(message),
    anchor,
    "transcript-index-unready",
    "snapshot-anchor-validation",
  );
  const encoded = encodeSessionTranscriptWorkerError(original);
  expect(encoded).toMatchObject({ kind: "fence", message });
  const received = structuredClone(encoded);
  expect(received?.kind).toBe("fence");
  if (!received) {
    throw new Error("Missing fixture domain failure");
  }
  retainContextDiagnosticReply(received);
  const decoded = decodeSessionTranscriptWorkerReadError(received);
  expect(decoded).toBeInstanceOf(SessionTranscriptReadFenceError);
  expect(decoded.message).toBe(message);
  const rejected = vi.fn();
  recordContextDiagnostic(
    decoded,
    { ...anchor, generation: "other" },
    "context-preparation",
    rejected,
  );
  expect(rejected).not.toHaveBeenCalled();
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
  const token = serializeContextDiagnostic(decoded)?.sourceToken;
  expect(token).toBeDefined();
  expect(token).toMatch(/^[a-f0-9]{64}$/);
  expect(wire).toEqual({
    version: 1,
    reason: "transcript-index-unready",
    stage: "snapshot-anchor-validation",
    sourceToken: token,
  });
  expect(JSON.stringify(write.mock.calls)).not.toContain(token);
  const failingWrite = vi.fn(() => {
    throw new Error("synthetic logging failure");
  });
  expect(() => recordContextDiagnostic(decoded, anchor, "review-run", failingWrite)).not.toThrow();
  expect(failingWrite).toHaveBeenCalledExactlyOnceWith({
    version: 1,
    reason: "transcript-index-unready",
    stage: "snapshot-anchor-validation",
    phase: "review-run",
  });
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
  { ...wire, extra: "synthetic-private-payload" },
  Object.assign(Object.create({ inherited: true }), wire),
  { ...wire, [Symbol("extra")]: true },
])("leaves malformed or unrelated metadata as the same generic refusal (%j)", (detail) => {
  const failure = { kind: "fence" as const, message, contextDiagnostic: detail };
  retainContextDiagnosticReply(failure);
  const decoded = decodeSessionTranscriptWorkerReadError(failure);
  expect(decoded).toBeInstanceOf(SessionTranscriptReadFenceError);
  expect(decoded.message).toBe(message);
  const write = vi.fn();
  recordContextDiagnostic(decoded, anchor, "context-preparation", write);
  expect(write).not.toHaveBeenCalled();
});

it("does not read diagnostic or source accessors and never classifies message lookalikes", () => {
  const getter = vi.fn(() => wire);
  const write = vi.fn();
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
    retainContextDiagnosticReply(failure);
    recordContextDiagnostic(
      decodeSessionTranscriptWorkerReadError(failure),
      anchor,
      "context-preparation",
      write,
    );
    expect(write).not.toHaveBeenCalled();
  }
  const sourceAccessor = Object.defineProperty({ ...anchor }, "generation", { get: getter });
  const sourceFailure = annotateContextFailure(
    new SessionTranscriptReadFenceError(message),
    sourceAccessor,
    "transcript-index-unready",
    "snapshot-anchor-validation",
  );
  recordContextDiagnostic(sourceFailure, anchor, "context-preparation", write);
  expect(write).not.toHaveBeenCalled();
  expect(getter).not.toHaveBeenCalled();
  // The held-lock path has not opted into the ordinary-pool diagnostic adapter.
  const unbound = { kind: "fence" as const, message, contextDiagnostic: wire };
  recordContextDiagnostic(
    decodeSessionTranscriptWorkerReadError(unbound),
    anchor,
    "context-preparation",
    write,
  );
  expect(write).not.toHaveBeenCalled();
  for (const other of [
    new Error(message),
    new SessionTranscriptReadFenceError(message),
    new Error("worker task timed out"),
    new Error("worker exited"),
  ]) {
    recordContextDiagnostic(other, anchor, "context-preparation", write);
    expect(write).not.toHaveBeenCalled();
  }
  const ownership = {
    kind: "fence" as const,
    message: "Completed-turn anchor belongs to another transcript",
    contextDiagnostic: wire,
  };
  retainContextDiagnosticReply(ownership);
  recordContextDiagnostic(
    decodeSessionTranscriptWorkerReadError(ownership),
    anchor,
    "context-preparation",
    write,
  );
  expect(write).not.toHaveBeenCalled();
});

it("does not classify unknown envelope kinds or accessor-backed envelope messages", () => {
  const write = vi.fn();
  for (const kind of [undefined, "unknown", "projection"]) {
    const envelope = { kind, message, contextDiagnostic: wire };
    retainContextDiagnosticReply(envelope);
    const error = decodeContextDiagnostic(new SessionTranscriptReadFenceError(message), envelope);
    recordContextDiagnostic(error, anchor, "context-preparation", write);
    expect(write).not.toHaveBeenCalled();
  }
  const getter = vi.fn(() => message);
  const envelope = Object.defineProperty(
    { kind: "fence" as const, contextDiagnostic: wire },
    "message",
    { get: getter },
  );
  retainContextDiagnosticReply(envelope);
  expect(getter).not.toHaveBeenCalled();
  // The pre-existing domain decoder may read message. The optional diagnostic never does.
  const error = decodeContextDiagnostic(new SessionTranscriptReadFenceError(message), envelope);
  expect(getter).not.toHaveBeenCalled();
  recordContextDiagnostic(error, anchor, "context-preparation", write);
  expect(write).not.toHaveBeenCalled();
});

it("reads only privately retained detail through bounded admission causes", () => {
  const refusal = annotateContextFailure(
    new SessionTranscriptReadFenceError(message),
    anchor,
    "anchor-mismatch",
    "anchor-validation",
  );
  const wrapped = new Error("source execution authority is no longer active", { cause: refusal });
  const write = vi.fn();
  const expected = {
    version: 1,
    reason: "anchor-mismatch",
    stage: "anchor-validation",
    phase: "review-run",
  };
  recordContextDiagnostic(wrapped, anchor, "review-run", write);
  expect(write).toHaveBeenCalledExactlyOnceWith(expected);
  write.mockClear();
  recordContextDiagnostic(wrapped, { ...anchor, sessionId: "other" }, "review-run", write);
  expect(write).not.toHaveBeenCalled();
  const getter = vi.fn(() => refusal);
  const accessor = Object.defineProperty(new Error("wrapper"), "cause", { get: getter });
  recordContextDiagnostic(accessor, anchor, "review-run", write);
  expect(write).not.toHaveBeenCalled();
  expect(getter).not.toHaveBeenCalled();
  const cycle = new Error("cycle");
  cycle.cause = cycle;
  recordContextDiagnostic(cycle, anchor, "review-run", write);
  expect(write).not.toHaveBeenCalled();
  let deepestAccepted: Error = refusal;
  for (let depth = 0; depth < 7; depth++) {
    deepestAccepted = new Error("wrapper", { cause: deepestAccepted });
  }
  recordContextDiagnostic(deepestAccepted, anchor, "review-run", write);
  expect(write).toHaveBeenCalledExactlyOnceWith(expected);
  write.mockClear();
  recordContextDiagnostic(
    new Error("wrapper", { cause: deepestAccepted }),
    anchor,
    "review-run",
    write,
  );
  expect(write).not.toHaveBeenCalled();
  const otherSource = annotateContextFailure(
    new Error(message, { cause: refusal }),
    { ...anchor, sessionId: "other" },
    "transcript-index-unready",
    "snapshot-anchor-validation",
  );
  recordContextDiagnostic(otherSource, anchor, "review-run", write);
  expect(write).not.toHaveBeenCalled();
  recordContextDiagnostic(otherSource, { ...anchor, sessionId: "other" }, "review-run", write);
  expect(write).toHaveBeenCalledExactlyOnceWith({
    version: 1,
    reason: "transcript-index-unready",
    stage: "snapshot-anchor-validation",
    phase: "review-run",
  });
});
