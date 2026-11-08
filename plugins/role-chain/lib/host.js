// Optional Cordis services must not trip property injection checks.
export function serviceOf(ctx, name) {
  try { const service = ctx?.get?.(name); if (service) return service } catch {}
  try { return ctx?.[name] } catch { return undefined }
}

export async function bounded(promise, timeoutMs = 1000) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve(promise).then(value => ({ settled: true, value }), error => ({ settled: true, error })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ settled: false }), timeoutMs) }),
    ])
  } finally { clearTimeout(timer) }
}
