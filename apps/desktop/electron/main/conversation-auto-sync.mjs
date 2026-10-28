/** Serial, bounded-rate uploads. No desktop/provider execution is triggered. */
export function createConversationAutoSync({ sync, onError, intervalMs = 15000,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  let disposed = false, started = false, timer = null, running = false, requested = false;
  function schedule(delay) {
    if (disposed || !started) return;
    if (timer !== null) clearTimer(timer);
    timer = setTimer(round, delay); timer?.unref?.();
  }
  async function round() {
    timer = null;
    if (disposed || running) return;
    running = true; requested = false;
    try {
      const status = await sync.getState();
      if (!disposed && status.signedIn && status.state?.enabled === true) await sync.push();
    } catch (error) { if (!disposed) onError(error); }
    finally { running = false; schedule(requested ? 1000 : intervalMs); }
  }
  return {
    start() { if (!started && !disposed) { started = true; schedule(0); } },
    request() { if (disposed) return; requested = true; if (!running) schedule(1000); },
    dispose() { disposed = true; if (timer !== null) clearTimer(timer); timer = null; },
  };
}
