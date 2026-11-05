// Run: node src/files.test.ts   (needs bash + GNU find on PATH for the live check)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fmtSize, joinPath, listScript, parentOf, parseListing } from "./files.ts";

const l = parseListing("/home/me\nf\t12\t2026-11-05 10:00\tb.txt\nd\t4096\t2026-11-05 10:00\tz dir\nf\t0\t2026-11-05 10:00\ta b's.txt\n");
assert.equal(l.path, "/home/me");
assert.deepEqual(l.entries.map((e) => e.name), ["z dir", "a b's.txt", "b.txt"]);
assert.equal(l.entries[0].dir, true);
assert.equal(parentOf("/home/me"), "/home");
assert.equal(parentOf("/home"), "/");
assert.equal(parentOf("/"), "/");
assert.equal(joinPath("/", "etc"), "/etc");
assert.equal(joinPath("/etc", "x"), "/etc/x");
assert.equal(fmtSize(1536), "1.5 KB");
assert.match(listScript("~/a b"), /^cd -- "\$HOME\/a b"/);

// Live: the real script against a temp dir with awkward names.
const dir = mkdtempSync(join(tmpdir(), "files-"));
mkdirSync(join(dir, "sub dir"));
writeFileSync(join(dir, "it's.txt"), "hello");
const bashDir = execFileSync("bash", ["-c", `cygpath -u ${JSON.stringify(dir)} 2>/dev/null || echo ${JSON.stringify(dir)}`]).toString().trim();
const live = parseListing(execFileSync("bash", ["-c", listScript(bashDir)]).toString());
assert.deepEqual(live.entries.map((e) => [e.name, e.dir]), [["sub dir", true], ["it's.txt", false]]);
assert.equal(live.entries[1].size, 5);
console.log("files ok");

// Save round-trip: writeScript keeps awkward names and content byte-for-byte.
import { readFileSync } from "node:fs";
import { modeFor, writeScript } from "./files.ts";
const content = "a='$HOME' `x`\r\nline2\n";
execFileSync("bash", ["-c", writeScript(`${bashDir}/it's.txt`)], { input: content });
assert.equal(readFileSync(join(dir, "it's.txt"), "utf8"), content);
assert.equal(modeFor(".env"), "sh");
assert.equal(modeFor("a.yml"), "yaml");
assert.equal(modeFor("x.ts"), "text");
console.log("write ok");

// sudo save: fake sudo checks the password, then runs the command; password must not reach the file.
import { sudoWriteScript } from "./files.ts";
writeFileSync(join(dir, "bin-sudo"), `#!/bin/sh\nwhile [ "\${1#-}" != "$1" ]; do [ "$1" = -p ] && shift; shift; done\nIFS= read -r p; [ "$p" = "pw x" ] || { echo "Sorry"; exit 1; }\nexec "$@"\n`);
const fake = `mkdir -p ${bashDir}/fb && cp ${bashDir}/bin-sudo ${bashDir}/fb/sudo && chmod +x ${bashDir}/fb/sudo && PATH=${bashDir}/fb:$PATH; `;
execFileSync("bash", ["-c", fake + sudoWriteScript(`${bashDir}/it's.txt`)], { input: `pw x\n${content}` });
assert.equal(readFileSync(join(dir, "it's.txt"), "utf8"), content);
assert.throws(() => execFileSync("bash", ["-c", fake + sudoWriteScript(`${bashDir}/it's.txt`)], { input: `wrong\nzzz` }));
assert.equal(readFileSync(join(dir, "it's.txt"), "utf8"), content);
console.log("sudo write ok");
