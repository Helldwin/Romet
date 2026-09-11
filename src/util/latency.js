export function latencyClass(ms) {
  if (ms === null || ms === undefined) return 'latency-unknown'
  if (ms < 150) return 'latency-good'
  if (ms < 400) return 'latency-ok'
  return 'latency-bad'
}
