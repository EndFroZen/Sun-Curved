// Run: node src/stats.test.ts
import assert from "node:assert/strict";
import { parseStats } from "./stats.ts";

const a = parseStats("cpu 1000 800\nmem 8000000 6000000\ndisk 100 25\n");
assert.equal(a.cpu, null); // first sample has nothing to diff against
assert.equal(a.memUsed, 2000000 * 1024);
assert.equal(a.disk, 25);
const b = parseStats("cpu 1100 850\nmem 8000000 6000000\ndisk 100 25", a.cpuRaw);
assert.equal(b.cpu, 50); // 100 jiffies passed, 50 idle
assert.throws(() => parseStats("bash: awk: not found"), /unexpected/);
console.log("stats ok");
