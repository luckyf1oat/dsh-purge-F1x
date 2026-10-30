let on = false;

export let verbose = false;

export function setVerbose(v) {
  on = v === true;
  verbose = on;
}

export function log(...args) {
  if (!on) return;
  try {
    console.log("[purge-flash]", ...args);
  } catch {
    /* 绝不因为日志抛错 */
  }
}

/** 无论 verbose 与否都报一次：只用于「某层挂了」这种必须让用户知道的事。 */
export function warnOnce(key, ...args) {
  try {
    const set = (globalThis.__purgeFlashWarned ??= new Set());
    if (set.has(key)) return;
    set.add(key);
    console.warn("[purge-flash]", ...args);
  } catch {
    /* ignore */
  }
}
