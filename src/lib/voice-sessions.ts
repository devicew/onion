/** Tracks active voice-watch AbortControllers per session (replace on restart). */
if (typeof window !== "undefined") {
  throw new Error("Módulo restrito ao servidor.");
}

type VoiceWatchSlot = {
  abort: AbortController;
  jobId: string;
};

const activeBySession = new Map<string, VoiceWatchSlot>();

/** Cancels any previous watch for this session, then registers the new one. */
export function replaceVoiceWatch(
  sessionId: string,
  abort: AbortController,
  jobId: string,
): void {
  const prev = activeBySession.get(sessionId);
  if (prev) {
    try {
      prev.abort.abort("replaced");
    } catch {
      // ignore
    }
  }
  activeBySession.set(sessionId, { abort, jobId });
}

export function clearVoiceWatch(sessionId: string, jobId: string): void {
  const cur = activeBySession.get(sessionId);
  if (cur?.jobId === jobId) {
    activeBySession.delete(sessionId);
  }
}
