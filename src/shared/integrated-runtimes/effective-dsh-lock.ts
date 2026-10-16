import releaseLock from "./dsh-lock.json";

// The build driver replaces this constant with the verified handoff identity.
// Source-mode tests and unprepared development continue to use the committed lock.
declare const __NEXTTOOLS_DSH_BUILD_LOCK__: typeof releaseLock | undefined;

const effectiveDshLock = typeof __NEXTTOOLS_DSH_BUILD_LOCK__ === "undefined"
  ? releaseLock
  : __NEXTTOOLS_DSH_BUILD_LOCK__;

export const isPreparedDshBuild = typeof __NEXTTOOLS_DSH_BUILD_LOCK__ !== "undefined";

export default effectiveDshLock;
