// Remote file browsing over the existing SSH session (GNU find on the machine).
import { dq, sq } from "./deploy.ts";

export type Entry = { name: string; dir: boolean; size: number; mtime: string };

const cd = (path: string) => `cd -- ${dq(path)}`; // dq expands a leading ~

/** First output line is the resolved absolute path, then one tab-separated line per entry. */
// ponytail: names containing tabs/newlines break the listing; switch to -printf '\0' if that ever shows up.
export const listScript = (path: string) =>
  `${cd(path)} && pwd && find . -mindepth 1 -maxdepth 1 -printf '%Y\\t%s\\t%TY-%Tm-%Td %TH:%TM\\t%f\\n'`;

export const PREVIEW_BYTES = 256 * 1024;
export const readScript = (path: string) => `head -c ${PREVIEW_BYTES} -- ${sq(path)}`;
/** Content goes in on stdin; `cat >` rewrites in place, so owner and mode are kept. */
export const writeScript = (path: string) => `cat > ${sq(path)}`;
/** Root-owned files: stdin = password line, then content. Content goes via a temp file so a sudo that
 *  doesn't prompt (NOPASSWD) can never write the password into the target; `cat >` keeps owner and mode. */
export const sudoWriteScript = (path: string) =>
  `IFS= read -r pw; t=$(mktemp) || exit 1; cat > "$t"; printf '%s\\n' "$pw" | sudo -S -k -p '' sh -c 'cat -- "$1" > "$2"' _ "$t" ${sq(path)}; r=$?; rm -f -- "$t"; exit $r`;

/** Editor highlighting by file name. */
export const modeFor = (name: string) =>
  /\.ya?ml$/i.test(name) ? "yaml" : /\.(sh|bash|zsh)$|^\.?env\b|^\.(bashrc|profile|zshrc)$/i.test(name) ? "sh" : "text";

/** Folders first, then by name. */
export function parseListing(out: string): { path: string; entries: Entry[] } {
  const [path, ...lines] = out.replace(/\n$/, "").split("\n");
  const entries = lines
    .map((l) => l.split("\t"))
    .filter((p) => p.length >= 4)
    .map(([type, size, mtime, ...name]) => ({ name: name.join("\t"), dir: type === "d", size: +size, mtime: mtime.slice(0, 16) }))
    .sort((a, b) => +b.dir - +a.dir || a.name.localeCompare(b.name));
  return { path, entries };
}

/** Parent of an absolute path ("/" stays "/"). */
export const parentOf = (p: string) => p.replace(/\/[^/]*\/?$/, "") || "/";
export const joinPath = (dir: string, name: string) => (dir === "/" ? "" : dir) + "/" + name;

export const fmtSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(1)} GB`;
