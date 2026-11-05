// Live machine stats (Linux /proc), read over the existing SSH session.

export const STATS_SCRIPT = `awk '/^cpu /{print "cpu",$2+$3+$4+$5+$6+$7+$8+$9,$5+$6}' /proc/stat
awk '/^MemTotal/{t=$2}/^MemAvailable/{a=$2}END{print "mem",t,a}' /proc/meminfo
df -Pk / | awk 'NR==2{print "disk",$2,$3}'`;

/** Cumulative CPU jiffies [total, idle]; CPU % needs two samples. */
export type Cpu = [total: number, idle: number];
export type Stats = { cpu: number | null; memUsed: number; memTotal: number; disk: number; cpuRaw: Cpu };

export function parseStats(out: string, prev?: Cpu): Stats {
  const f: Record<string, number[]> = Object.fromEntries(
    out.trim().split("\n").map((l) => {
      const [k, ...v] = l.trim().split(/\s+/);
      return [k, v.map(Number)];
    }),
  );
  if (!f.cpu || !f.mem || !f.disk) throw new Error(`unexpected stats output: ${out}`);
  const [total, idle] = f.cpu;
  const [memTotal, memAvail] = f.mem;
  const [diskSize, diskUsed] = f.disk;
  const dt = prev ? total - prev[0] : 0;
  return {
    cpu: prev && dt > 0 ? 100 * (1 - (idle - prev[1]) / dt) : null,
    memUsed: (memTotal - memAvail) * 1024,
    memTotal: memTotal * 1024,
    disk: (100 * diskUsed) / diskSize,
    cpuRaw: [total, idle],
  };
}
