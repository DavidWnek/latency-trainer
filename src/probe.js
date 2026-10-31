// Measures real round trips from this device to the page's host. Served from a laptop
// and opened on a phone over Wi-Fi, that is the Wi-Fi hop itself; on a hosted site it
// is Wi-Fi plus the route to the nearest edge server.

// Median round trip, and jitter as the spread of the slow tail over the fastest trip:
// the extra delay a packet can pick up, which is what the sim's jitter setting adds.
export function summarizeRtt(samples) {
  const ok = samples.filter(Number.isFinite).sort((a, b) => a - b);
  if (!ok.length) return null;
  const at = (p) => ok[Math.round(p * (ok.length - 1))];
  return {
    median: at(0.5),
    jitter: at(0.9) - ok[0],
    lost: samples.length - ok.length,
    n: samples.length,
  };
}

export async function probeRtt({ count = 20, gap = 60, timeout = 2000, url = location.href } = {}) {
  const once = async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    const t0 = performance.now();
    try {
      await fetch(url, { method: 'HEAD', cache: 'no-store', signal: ctrl.signal });
      return performance.now() - t0;
    } catch {
      return Infinity;
    } finally {
      clearTimeout(timer);
    }
  };
  await once(); // warm-up: opens the connection so later trips don't pay for the handshake
  const samples = [];
  for (let i = 0; i < count; i++) {
    samples.push(await once());
    await new Promise((r) => setTimeout(r, gap));
  }
  return summarizeRtt(samples);
}
