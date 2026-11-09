import os from 'node:os';
import fs from 'node:fs';

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    for (const t of Object.values(c.times)) total += t;
    idle += c.times.idle;
  }
  return { idle, total };
}
let prev = cpuTimes();

/** Instantané système affiché dans les panneaux du HUD. */
export function sampleStats() {
  const cur = cpuTimes();
  const dI = cur.idle - prev.idle;
  const dT = cur.total - prev.total;
  prev = cur;
  const disks = [];
  for (const l of 'CDEFGH') {
    try {
      const s = fs.statfsSync(`${l}:\\`);
      if (s.blocks > 0) disks.push({ name: `${l}:`, total: s.blocks * s.bsize, free: s.bavail * s.bsize });
    } catch {}
  }
  return {
    cpu: dT > 0 ? Math.max(0, Math.min(100, Math.round(100 * (1 - dI / dT)))) : 0,
    cores: os.cpus().length,
    cpuModel: os.cpus()[0]?.model?.replace(/\s+/g, ' ').trim(),
    ramUsed: os.totalmem() - os.freemem(),
    ramTotal: os.totalmem(),
    uptime: os.uptime(),
    disks,
  };
}
