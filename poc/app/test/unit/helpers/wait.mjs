export async function waitUntil(check, { timeoutMs = 5000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitUntil: 条件在限定时间内没有满足');
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}
