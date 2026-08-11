/** Tracks active voice-watch AbortControllers per session (replace on restart). */
if (typeof window !== "undefined") {
  throw new Error("Módulo restrito ao servidor.");
}

type VoiceWatchSlot = {
  abort: AbortController;
  jobId: string;
};

const activeBySession = new Map<string, VoiceWatchSlot>();

/** Stop whatever watch is running for this session (if any). */
export function abortVoiceWatch(sessionId: string): void {
  const prev = activeBySession.get(sessionId);
  if (!prev) return;
  activeBySession.delete(sessionId);
  try {
    prev.abort.abort("replaced");
  } catch {
    // ignore
  }
}

/** Register the active watch for this session (does not abort itself). */
export function registerVoiceWatch(
  sessionId: string,
  abort: AbortController,
  jobId: string,
): void {
  activeBySession.set(sessionId, { abort, jobId });
}

export function clearVoiceWatch(sessionId: string, jobId: string): void {
  const cur = activeBySession.get(sessionId);
  if (cur?.jobId === jobId) {
    activeBySession.delete(sessionId);
  }
}
