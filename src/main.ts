import { invoke } from "@tauri-apps/api/core";
import Database from "@tauri-apps/plugin-sql";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { compile, parseManifest, scripts, TEMPLATE, type Manifest } from "./deploy";
import { createEditor } from "./editor";
import { createFlow } from "./flow";
import { marked } from "marked";
import manualMd from "./manual.md?raw";
import { fmtSize, joinPath, listScript, parentOf, parseListing, PREVIEW_BYTES, readScript, writeScript, sudoWriteScript, modeFor, type Entry } from "./files";
import { parseStats, STATS_SCRIPT, type Cpu, type Stats } from "./stats";

type Conn = { id: number; name: string; host: string; port: number; user: string; key_path: string };
type Status = "connecting" | "live" | "closed";

const db = await Database.load("sqlite:suncurved.db");
await db.execute(`CREATE TABLE IF NOT EXISTS connections (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 22, user TEXT NOT NULL, key_path TEXT NOT NULL DEFAULT '')`);
await db.execute("CREATE TABLE IF NOT EXISTS wallpapers (conn_id INTEGER PRIMARY KEY, data TEXT NOT NULL)");

const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const loadConns = () => db.select<Conn[]>("SELECT * FROM connections ORDER BY name");

async function saveConn(form: HTMLFormElement) {
  const d = Object.fromEntries(new FormData(form)) as Record<string, string>;
  const vals = [d.name, d.host.trim(), +d.port, d.user, d.key_path.trim()];
  if (d.id) {
    await db.execute("UPDATE connections SET name=$1, host=$2, port=$3, user=$4, key_path=$5 WHERE id=$6", [...vals, +d.id]);
    await invoke("set_secret", { id: +d.id, secretValue: d.secret }); // blank = remove saved password
  } else {
    const r = await db.execute("INSERT INTO connections (name, host, port, user, key_path) VALUES ($1, $2, $3, $4, $5)", vals);
    await invoke("set_secret", { id: r.lastInsertId, secretValue: d.secret });
  }
}

async function deleteConn(id: number) {
  await db.execute("DELETE FROM connections WHERE id = $1", [id]);
  await invoke("del_secret", { id });
  await db.execute("DELETE FROM wallpapers WHERE conn_id = $1", [id]);
}

// ---------- wallpaper (per server, stored locally as a downscaled JPEG data URL) ----------

const loadWall = async (id: number) =>
  (await db.select<{ data: string }[]>("SELECT data FROM wallpapers WHERE conn_id = $1", [id]))[0]?.data;

/** Native file picker -> image shrunk to fit 2560x1440, or null if cancelled. */
async function pickImage() {
  const inp = Object.assign(document.createElement("input"), { type: "file", accept: "image/*" });
  const file = await new Promise<File | undefined>((res) => {
    inp.onchange = () => res(inp.files?.[0]);
    inp.oncancel = () => res(undefined);
    inp.click();
  });
  if (!file) return null;
  const img = await createImageBitmap(file);
  const k = Math.min(1, 2560 / img.width, 1440 / img.height);
  const cv = Object.assign(document.createElement("canvas"), { width: Math.round(img.width * k), height: Math.round(img.height * k) });
  cv.getContext("2d")!.drawImage(img, 0, 0, cv.width, cv.height);
  return cv.toDataURL("image/jpeg", 0.85);
}

/** Loads the saved background into `desk` and gives it a right-click Personalize menu. id 0 = main display. */
function wallpaper(desk: HTMLElement, id: number) {
  const setWall = (url?: string) => {
    desk.style.backgroundImage = url ? `url("${url}")` : "";
    desk.classList.toggle("has-wall", !!url);
  };
  loadWall(id).then(setWall);
  const pick = async () => {
    const url = await pickImage();
    if (!url) return;
    await db.execute("INSERT OR REPLACE INTO wallpapers (conn_id, data) VALUES ($1, $2)", [id, url]);
    setWall(url);
  };
  const remove = async () => {
    await db.execute("DELETE FROM wallpapers WHERE conn_id = $1", [id]);
    setWall();
  };
  const sizeKey = `iconSize:${id}`;
  const setSize = (s: string) => {
    localStorage[sizeKey] = s;
    desk.classList.remove("icons-sm", "icons-lg");
    if (s !== "md") desk.classList.add(`icons-${s}`);
  };
  setSize(localStorage[sizeKey] ?? "md");
  const sizeItem = (s: string, label: string): MenuItem =>
    [label, localStorage[sizeKey] === s ? "check" : "none", () => setSize(s)];
  desk.oncontextmenu = (e) => {
    if ((e.target as HTMLElement).closest("button")) return e.preventDefault(); // icons get their own menu later
    contextMenu(e, [
      sizeItem("lg", "Large icons"),
      sizeItem("md", "Medium icons"),
      sizeItem("sm", "Small icons"),
      ["Personalize", "image", pick],
      ...(desk.classList.contains("has-wall") ? [["Remove background", "x", remove] as MenuItem] : []),
    ]);
  };
  return { pick, remove };
}

// ---------- our own right-click menu ----------

type MenuItem = [label: string, ic: keyof typeof ICONS, run: () => void];
const hideMenu = () => $("#ctx").classList.add("hidden");

function contextMenu(e: MouseEvent, items: MenuItem[]) {
  e.preventDefault();
  const m = $("#ctx");
  m.innerHTML = items
    .map(([label, ic], i) => `<button data-mi="${i}" class="flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left hover:bg-amber-500 hover:text-black">${icon(ic)} ${esc(label)}</button>`)
    .join("");
  m.querySelectorAll<HTMLElement>("[data-mi]").forEach((b) => (b.onclick = () => (hideMenu(), items[+b.dataset.mi!][2]())));
  m.classList.remove("hidden");
  m.style.left = `${Math.min(e.clientX, innerWidth - m.offsetWidth - 4)}px`;
  m.style.top = `${Math.min(e.clientY, innerHeight - m.offsetHeight - 4)}px`;
}

// ---------- icons (inline SVG, no emoji) ----------

// 2D line icons, 24x24, drawn with currentColor so they follow text colour and theme.
const ICONS = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  pencil: '<path d="M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/><path d="m15 5 4 4"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  none: "", // blank slot keeps menu labels aligned
  refresh: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  arrowUp: '<path d="m5 12 7-7 7 7M12 19V5"/>',
  logs: '<path d="M3 5h.01M3 12h.01M3 19h.01M8 5h13M8 12h13M8 19h13"/>',
  terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  plus: '<path d="M5 12h14M12 5v14"/>',
  book: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
  image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>',
  rocket: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
};
const icon = (name: keyof typeof ICONS, cls = "h-4 w-4") =>
  `<svg class="${cls} shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

/** Desktop-style app icon for the machine home grid; `data-<key>` is the click hook. */
const appTile = (key: string, art: keyof typeof ART, label: string, disabled = false) => `
  <button data-${key} ${disabled ? "disabled" : ""} class="group flex flex-col items-center gap-2 rounded-2xl p-3 enabled:hover:bg-zinc-800/50 disabled:cursor-not-allowed disabled:opacity-40">
    <span class="transition-transform duration-200 group-enabled:group-hover:-translate-y-1 group-enabled:group-hover:scale-105">${appArt(art)}</span>
    <span class="text-sm font-medium">${label}</span>
  </button>`;

let artSeq = 0;
/** Hand-drawn 3D app illustrations, 64x64; `#{id}` is made unique per instance. */
const ART = {
  rocket: `
    <defs>
      <linearGradient id="{id}b" x1="0" x2="1"><stop offset="0" stop-color="#64748b"/><stop offset=".35" stop-color="#fff"/><stop offset=".7" stop-color="#e2e8f0"/><stop offset="1" stop-color="#475569"/></linearGradient>
      <linearGradient id="{id}f" x1="0" x2="1"><stop offset="0" stop-color="#fb923c"/><stop offset=".5" stop-color="#ef4444"/><stop offset="1" stop-color="#9f1239"/></linearGradient>
      <linearGradient id="{id}fl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fef08a"/><stop offset=".45" stop-color="#f97316"/><stop offset="1" stop-color="#dc2626" stop-opacity="0"/></linearGradient>
      <radialGradient id="{id}g" cx=".35" cy=".3"><stop offset="0" stop-color="#bae6fd"/><stop offset=".6" stop-color="#0ea5e9"/><stop offset="1" stop-color="#1e3a8a"/></radialGradient>
      <radialGradient id="{id}h"><stop offset="0" stop-color="#fb923c" stop-opacity=".55"/><stop offset="1" stop-color="#fb923c" stop-opacity="0"/></radialGradient>
    </defs>
    <circle cx="22" cy="44" r="20" fill="url(#{id}h)"/>
    <g transform="rotate(45 32 32)">
      <path d="M26.5 46Q32 66 37.5 46Z" fill="url(#{id}fl)"><animate attributeName="d" values="M26.5 46Q32 66 37.5 46Z;M26.5 46Q32 60 37.5 46Z;M26.5 46Q32 66 37.5 46Z" dur=".5s" repeatCount="indefinite"/></path>
      <path d="M24 32 15 46l9-2Z" fill="url(#{id}f)"/><path d="M40 32l9 14-9-2Z" fill="url(#{id}f)"/>
      <path d="M32 5c8 8 10.5 21 8.5 39h-17C21.5 26 24 13 32 5Z" fill="url(#{id}b)"/>
      <path d="M32 5c3.6 3.6 6 7.6 7.4 12.5H24.6C26 12.6 28.4 8.6 32 5Z" fill="url(#{id}f)"/>
      <rect x="25.5" y="44" width="13" height="3.5" rx="1.2" fill="#334155"/>
      <path d="M31 36h2v12h-2Z" fill="url(#{id}f)"/>
      <circle cx="32" cy="26" r="5.6" fill="#cbd5e1"/><circle cx="32" cy="26" r="4.2" fill="url(#{id}g)"/>
      <circle cx="30.4" cy="24.4" r="1.3" fill="#fff" opacity=".9"/>
    </g>`,
  terminal: `
    <defs>
      <linearGradient id="{id}b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#64748b"/><stop offset="1" stop-color="#1e293b"/></linearGradient>
      <radialGradient id="{id}s" cx=".3" cy=".25" r="1"><stop offset="0" stop-color="#065f46"/><stop offset="1" stop-color="#020617"/></radialGradient>
      <linearGradient id="{id}st" x1="0" x2="1"><stop offset="0" stop-color="#334155"/><stop offset=".5" stop-color="#94a3b8"/><stop offset="1" stop-color="#334155"/></linearGradient>
      <filter id="{id}glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    </defs>
    <path d="M25 46h14l4 9H21Z" fill="url(#{id}st)"/>
    <ellipse cx="32" cy="56" rx="14" ry="2.6" fill="#1e293b"/>
    <rect x="5" y="11" width="54" height="39" rx="7" fill="#020617"/>
    <rect x="5" y="8" width="54" height="39" rx="7" fill="url(#{id}b)"/>
    <rect x="5.6" y="8.6" width="52.8" height="37.8" rx="6.4" fill="none" stroke="#fff" stroke-opacity=".3" stroke-width="1.2"/>
    <circle cx="11" cy="12.5" r="1.3" fill="#f87171"/><circle cx="15" cy="12.5" r="1.3" fill="#fbbf24"/><circle cx="19" cy="12.5" r="1.3" fill="#34d399"/>
    <rect x="9" y="16" width="46" height="27" rx="3" fill="url(#{id}s)"/>
    <g fill="none" stroke="#4ade80" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" filter="url(#{id}glow)">
      <path d="m15 23 5 4-5 4"/>
    </g>
    <rect x="23" y="29.5" width="8" height="2.6" rx=".8" fill="#4ade80" filter="url(#{id}glow)"><animate attributeName="opacity" values="1;1;0;0" keyTimes="0;.5;.5;1" dur="1.1s" repeatCount="indefinite"/></rect>
    <rect x="15" y="36" width="22" height="1.6" rx=".8" fill="#4ade80" opacity=".35"/>
    <rect x="15" y="39.5" width="14" height="1.6" rx=".8" fill="#4ade80" opacity=".2"/>
    <path d="M9 16h18L15 43H9Z" fill="#fff" opacity=".06"/>`,
  folder: `
    <defs>
      <linearGradient id="{id}k" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1d4ed8"/><stop offset="1" stop-color="#172554"/></linearGradient>
      <linearGradient id="{id}fr" x1="0" y1="0" x2=".3" y2="1"><stop offset="0" stop-color="#7dd3fc"/><stop offset=".55" stop-color="#3b82f6"/><stop offset="1" stop-color="#1e40af"/></linearGradient>
      <linearGradient id="{id}p" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#cbd5e1"/></linearGradient>
    </defs>
    <path d="M7 16a3 3 0 0 1 3-3h13l4.5 4.5H54a3 3 0 0 1 3 3V50a3 3 0 0 1-3 3H10a3 3 0 0 1-3-3Z" fill="url(#{id}k)"/>
    <g transform="rotate(-7 32 30)"><rect x="13" y="17" width="34" height="26" rx="2" fill="#e2e8f0"/></g>
    <g transform="rotate(5 32 30)">
      <rect x="16" y="15" width="34" height="26" rx="2" fill="url(#{id}p)"/>
      <rect x="20" y="20" width="18" height="2" rx="1" fill="#94a3b8"/><rect x="20" y="25" width="24" height="2" rx="1" fill="#cbd5e1"/><rect x="20" y="30" width="14" height="2" rx="1" fill="#cbd5e1"/>
    </g>
    <path d="M5 29.5A3 3 0 0 1 8 26.3h48a3 3 0 0 1 3 3.4l-2.6 20.6A3.2 3.2 0 0 1 53.2 53H10.8a3.2 3.2 0 0 1-3.2-2.7Z" fill="url(#{id}fr)"/>
    <path d="M8 27.6h48" stroke="#fff" stroke-opacity=".6" stroke-width="1.4" stroke-linecap="round"/>
    <path d="M9 30h46l-1 7c-14 3-30 3-44 0Z" fill="#fff" opacity=".12"/>`,
  file: `
    <defs><linearGradient id="{id}p" x1="0" y1="0" x2=".3" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#cbd5e1"/></linearGradient></defs>
    <path d="M14 6h24l14 14v36a3 3 0 0 1-3 3H14a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3Z" fill="#334155" opacity=".45" transform="translate(2.5 3)"/>
    <path d="M14 6h24l14 14v36a3 3 0 0 1-3 3H14a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3Z" fill="url(#{id}p)"/>
    <path d="M38 6v11a3 3 0 0 0 3 3h11Z" fill="#94a3b8"/>
    <rect x="17" y="25" width="22" height="3" rx="1.5" fill="#cbd5e1"/><rect x="17" y="31" width="16" height="3" rx="1.5" fill="#cbd5e1"/>
    <rect x="11" y="40" width="41" height="11" fill="{c}"/><rect x="11" y="40" width="41" height="3" fill="#fff" opacity=".3"/>`,
  devops: `
    <defs>
      <linearGradient id="{id}bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#334155"/><stop offset="1" stop-color="#0f172a"/></linearGradient>
      <linearGradient id="{id}l" x1="0" x2="1"><stop offset="0" stop-color="#38bdf8"/><stop offset=".5" stop-color="#a78bfa"/><stop offset="1" stop-color="#f59e0b"/></linearGradient>
      <filter id="{id}glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    </defs>
    <rect x="4" y="7" width="56" height="54" rx="14" fill="#020617"/>
    <rect x="4" y="4" width="56" height="54" rx="14" fill="url(#{id}bg)"/>
    <rect x="4.6" y="4.6" width="54.8" height="52.8" rx="13.4" fill="none" stroke="#fff" stroke-opacity=".25" stroke-width="1.2"/>
    <path d="M32 31c-4-5-7-8-11.5-8a8 8 0 0 0 0 16c4.5 0 7.5-3 11.5-8s7-8 11.5-8a8 8 0 0 1 0 16c-4.5 0-7.5-3-11.5-8Z" fill="none" stroke="#020617" stroke-opacity=".6" stroke-width="7" transform="translate(0 2)"/>
    <path d="M32 31c-4-5-7-8-11.5-8a8 8 0 0 0 0 16c4.5 0 7.5-3 11.5-8s7-8 11.5-8a8 8 0 0 1 0 16c-4.5 0-7.5-3-11.5-8Z" fill="none" stroke="url(#{id}l)" stroke-width="6" stroke-linecap="round" filter="url(#{id}glow)"/>
    <path d="M32 31c-4-5-7-8-11.5-8a8 8 0 0 0 0 16c4.5 0 7.5-3 11.5-8s7-8 11.5-8a8 8 0 0 1 0 16c-4.5 0-7.5-3-11.5-8Z" fill="none" stroke="#fff" stroke-opacity=".9" stroke-width="1.6" stroke-dasharray="6 58" pathLength="64"><animate attributeName="stroke-dashoffset" values="0;-64" dur="2.4s" repeatCount="indefinite"/></path>
    <path d="M8 18a14 14 0 0 1 14-10h20a14 14 0 0 1 14 10Z" fill="#fff" opacity=".07"/>`,
  settings: `
    <defs>
      <linearGradient id="{id}bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#52525b"/><stop offset="1" stop-color="#18181b"/></linearGradient>
      <linearGradient id="{id}g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f4f4f5"/><stop offset=".5" stop-color="#a1a1aa"/><stop offset="1" stop-color="#52525b"/></linearGradient>
    </defs>
    <rect x="4" y="7" width="56" height="54" rx="14" fill="#09090b"/>
    <rect x="4" y="4" width="56" height="54" rx="14" fill="url(#{id}bg)"/>
    <rect x="4.6" y="4.6" width="54.8" height="52.8" rx="13.4" fill="none" stroke="#fff" stroke-opacity=".25" stroke-width="1.2"/>
    <g transform="translate(0 2)" opacity=".5"><circle cx="32" cy="31" r="13" fill="none" stroke="#000" stroke-width="7" stroke-dasharray="5.1 5.1"/></g>
    <g>
      <animateTransform attributeName="transform" type="rotate" from="0 32 31" to="360 32 31" dur="12s" repeatCount="indefinite"/>
      <circle cx="32" cy="31" r="15" fill="none" stroke="url(#{id}g)" stroke-width="6" stroke-dasharray="5.9 5.9"/>
      <circle cx="32" cy="31" r="12.5" fill="url(#{id}g)"/>
      <circle cx="32" cy="31" r="5" fill="#27272a"/>
      <circle cx="32" cy="31" r="5" fill="none" stroke="#000" stroke-opacity=".4" stroke-width="1"/>
    </g>
    <path d="M8 18a14 14 0 0 1 14-10h20a14 14 0 0 1 14 10Z" fill="#fff" opacity=".07"/>`,
};
/** `{c}` in the art is an accent colour (file type band). */
const appArt = (name: keyof typeof ART, cls = "h-20 w-20 drop-shadow-[0_8px_10px_rgb(0_0_0/0.45)]", c = "#94a3b8") =>
  `<svg class="app-art ${cls} shrink-0 overflow-visible" viewBox="0 0 64 64" aria-hidden="true">${ART[name].replace(/\{id\}/g, `a${++artSeq}`).replace(/\{c\}/g, c)}</svg>`;

// App art stays still until hovered: pause each one as it lands in the DOM, play while the pointer is on its button.
const arts = (n: Node) => (n instanceof Element ? [...(n.matches(".app-art") ? [n] : []), ...n.querySelectorAll(".app-art")] : []) as SVGSVGElement[];
new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => arts(n).forEach((s) => s.pauseAnimations()))))
  .observe(document.body, { childList: true, subtree: true });
const hoverArt = (play: boolean) => (e: MouseEvent) => {
  const b = (e.target as Element).closest("button");
  if (!b || b.contains(e.relatedTarget as Node)) return; // moving between children of the same button
  arts(b).forEach((s) => (play ? s.unpauseAnimations() : s.pauseAnimations()));
};
addEventListener("mouseover", hoverArt(true));
addEventListener("mouseout", hoverArt(false));

// Colour band on file icons, by extension.
const FILE_COLORS: [RegExp, string][] = [
  [/\.(ts|tsx|js|jsx|mjs|py|go|rs|java|c|cpp|h|php|rb|sh|bash|zsh)$/i, "#8b5cf6"],
  [/\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i, "#ec4899"],
  [/\.(zip|gz|tgz|tar|xz|bz2|7z|rar|deb|rpm)$/i, "#f59e0b"],
  [/\.(json|ya?ml|toml|ini|conf|cfg|env|xml)$|^\.|rc$/i, "#10b981"],
  [/\.(md|txt|log|csv|pdf|docx?)$/i, "#3b82f6"],
  [/\.(db|sqlite3?|sql)$/i, "#ef4444"],
];
const fileColor = (name: string) => FILE_COLORS.find(([re]) => re.test(name))?.[1];

let logoSeq = 0;
/** 3D-shaded sun with a curved horizon ring: the Sun Curved mark. */
function logo(cls: string) {
  const n = ++logoSeq; // gradient ids must be unique per instance
  return `<svg class="${cls} shrink-0" viewBox="0 0 64 64" aria-label="Sun Curved">
    <defs>
      <radialGradient id="sc-body${n}" cx="36%" cy="30%" r="75%">
        <stop offset="0" stop-color="#fef3c7"/><stop offset=".3" stop-color="#fbbf24"/>
        <stop offset=".72" stop-color="#ea580c"/><stop offset="1" stop-color="#7c2d12"/>
      </radialGradient>
      <linearGradient id="sc-gloss${n}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#fff" stop-opacity=".95"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
      </linearGradient>
      <linearGradient id="sc-ring${n}" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#fde68a" stop-opacity=".2"/><stop offset=".5" stop-color="#fff"/>
        <stop offset="1" stop-color="#fde68a" stop-opacity=".2"/>
      </linearGradient>
    </defs>
    <ellipse cx="32" cy="59" rx="17" ry="3" fill="#000" opacity=".22"/>
    <circle cx="32" cy="30" r="23" fill="url(#sc-body${n})"/>
    <ellipse cx="25.5" cy="18.5" rx="11" ry="6.5" fill="url(#sc-gloss${n})" opacity=".75"/>
    <path d="M4 37c11 9 45 9 56 0" fill="none" stroke="url(#sc-ring${n})" stroke-width="3.2" stroke-linecap="round"/>
  </svg>`;
}

// ---------- day / night ----------

const terms = new Set<Terminal>();
const isLight = () =>
  localStorage.theme ? localStorage.theme === "light" : matchMedia("(prefers-color-scheme: light)").matches;
const termTheme = () =>
  isLight()
    ? { background: "#ffffff", foreground: "#18181b", cursor: "#d97706", selectionBackground: "#f59e0b55" }
    : { background: "#09090b", foreground: "#e4e4e7", cursor: "#f59e0b", selectionBackground: "#f59e0b55" };

/** Applies day/night; `save` remembers the choice, otherwise the OS setting is followed. */
function setTheme(light: boolean, save = false) {
  if (save) localStorage.theme = light ? "light" : "dark";
  document.documentElement.classList.toggle("light", light);
  terms.forEach((t) => (t.options.theme = termTheme()));
  const b = $("#theme");
  b.innerHTML = icon(light ? "moon" : "sun", "h-[18px] w-[18px]");
  b.title = light ? "Switch to night mode" : "Switch to day mode";
}

// ---------- remote workspace setup ----------

// ponytail: fixed path; make it a per-connection setting if machines differ.
const REMOTE_DIR = "~/EndFroZen/SunCurved";
const REMOTE_DB = "suncurved.db";
// An empty file is a valid (empty) SQLite database, so no sqlite3 binary is needed on the machine.
const SETUP_SCRIPT = `d="$HOME/${REMOTE_DIR.slice(2)}"; f="$d/${REMOTE_DB}"
if [ -d "$d" ]; then echo dir=exists; else mkdir -p "$d" && echo dir=created; fi
if [ -f "$f" ]; then echo db=exists; else : > "$f" && echo db=created; fi`;

type LogLevel = "info" | "step" | "ok" | "warn" | "err";
const LOG_COLOR: Record<LogLevel, string> = { info: "text-zinc-400", step: "font-semibold text-zinc-100", ok: "text-emerald-400", warn: "text-amber-400", err: "text-red-400" };

// ---------- auth popup (password / 2FA asked by the server) ----------

type AuthPrompt = { req: number; sid: number; instructions: string; prompts: [string, boolean][] };
const authQueue: AuthPrompt[] = [];

function showAuth() {
  const dlg = $<HTMLDialogElement>("#auth");
  const a = authQueue[0];
  if (dlg.open || !a) return;
  const tab = tabs.find((t) => t.sid === a.sid);
  $("#auth-title").textContent = tab ? `Sign in to ${tab.conn.name}` : "Sign in";
  $("#auth-sub").textContent = a.instructions || (tab ? `${tab.conn.user}@${tab.conn.host}` : "");
  $("#auth-fields").innerHTML = a.prompts
    .map(([text, echo], i) => {
      const otp = /code|token|otp/i.test(text);
      return `<label class="block text-xs text-zinc-400">${esc(text.replace(/^\(.*?\)\s*/, ""))}
        <input data-i="${i}" type="${echo || otp ? "text" : "password"}" ${otp ? 'inputmode="numeric" autocomplete="one-time-code"' : 'autocomplete="off"'}
          class="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 ${otp ? "font-mono tracking-[0.3em]" : ""} text-sm text-zinc-100 outline-none focus:border-amber-500" />
      </label>`;
    })
    .join("");
  dlg.showModal();
  $<HTMLInputElement>("#auth-fields input").focus();
}

function answerAuth(answers: string[] | null) {
  const a = authQueue.shift();
  $<HTMLDialogElement>("#auth").close();
  if (a) invoke("auth_answer", { req: a.req, answers });
  showAuth();
}

/** Drop pending prompts of a session that's going away. */
function cancelAuth(sid: number) {
  if (authQueue[0]?.sid === sid) answerAuth(null);
  for (let i = authQueue.length - 1; i >= 0; i--)
    if (authQueue[i].sid === sid) invoke("auth_answer", { req: authQueue.splice(i, 1)[0].req, answers: null });
}

// ---------- new UI ----------

type Tab = { key: number; sid: number; conn: Conn; pane: HTMLElement; status: Status; close: () => void; where: string };
let sidSeq = 0;
const tabs: Tab[] = [];
let activeKey = 0;
let tabSeq = 0;
let conns: Conn[] = [];

const dot = (s: Status | undefined) =>
  `<span class="inline-block h-2 w-2 shrink-0 rounded-full ${
    s === "live" ? "bg-emerald-400" : s === "connecting" ? "animate-pulse bg-amber-400" : s === "closed" ? "bg-red-500" : "bg-zinc-600"
  }"></span>`;

async function app() {
  document.body.className = "bg-zinc-950 text-zinc-100 antialiased";
  document.body.innerHTML = `
    <div class="flex h-screen">
      <aside class="flex w-72 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900">
        <div class="flex items-center gap-3 px-5 py-4">
          <button id="home" title="Main display" class="rounded-xl">${logo("h-10 w-10")}</button>
          <div>
            <p class="font-semibold leading-tight">Sun Curved</p>
            <p class="text-xs text-zinc-500">SSH workspace</p>
          </div>
          <button id="manual-open" title="Deploy YAML manual" class="ml-auto rounded-lg px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">${icon("book")}</button>
          <button id="theme" class=" rounded-lg px-2 py-1 text-base hover:bg-zinc-800"></button>
        </div>
        <div class="px-3">
          <input id="q" placeholder="Search servers…" class="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm outline-none placeholder:text-zinc-600 focus:border-amber-500" />
        </div>
        <div class="flex items-center justify-between px-5 pb-2 pt-5 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
          Servers
          <button id="add" class="rounded-md px-2 py-0.5 normal-case tracking-normal text-amber-400 hover:bg-zinc-800">+ New</button>
        </div>
        <nav id="list" class="flex-1 space-y-0.5 overflow-auto px-3 pb-3"></nav>
        <div id="where" class="truncate border-t border-zinc-800 px-5 py-2 font-mono text-[11px] text-zinc-500"></div>
      </aside>
      <main class="flex min-w-0 flex-1 flex-col">
        <div id="tabs" class="flex h-11 shrink-0 items-end gap-1 overflow-x-auto border-b border-zinc-800 bg-zinc-900 px-2"></div>
        <div id="stage" class="relative flex-1"></div>
      </main>
    </div>
    <div id="launcher" class="fixed inset-0 z-40 flex flex-col bg-zinc-950 bg-cover bg-center p-8">
      <div class="flex items-center gap-3">
        ${logo("h-10 w-10")}
        <p class="font-semibold">Sun Curved</p>
      </div>
      <div class="tiles mt-8 flex-1">
        ${appTile("devops", "devops", "DevOps")}
        ${appTile("settings", "settings", "Settings")}
      </div>
      <div class="mt-auto font-mono text-[11px] text-zinc-500">/</div>
    </div>
    <dialog id="dlg" class="fixed inset-0 m-auto h-fit w-[28rem] rounded-2xl border border-zinc-800 bg-zinc-900 p-0 text-zinc-100 backdrop:bg-black/70">
      <form id="f" class="space-y-3 p-6">
        <h2 id="dlg-title" class="text-lg font-semibold">New SSH connection</h2>
        <input type="hidden" name="id" />
        ${field("name", "Name", "Production web")}
        <div class="flex gap-3">
          <div class="flex-1">${field("host", "Host / IP", "192.168.1.10")}</div>
          <div class="w-24">${field("port", "Port", "", 'type="number" value="22" min="1" max="65535"')}</div>
        </div>
        ${field("user", "Username", "root")}
        ${field("key_path", "Private key path", "optional, e.g. C:\\Users\\me\\.ssh\\id_ed25519", "", false)}
        <div class="relative">
          ${field("secret", "Password / key passphrase", "saved in Windows Credential Manager", 'type="password" autocomplete="off"', false)}
          <button type="button" id="eye" class="absolute bottom-1.5 right-1.5 rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">Show</button>
        </div>
        <div class="flex justify-end gap-2 pt-2">
          <button type="button" id="cancel" class="rounded-lg px-4 py-2 text-sm text-zinc-400 hover:bg-zinc-800">Cancel</button>
          <button class="rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-black hover:bg-amber-400">Save</button>
        </div>
      </form>
    </dialog>
    <dialog id="run" class="fixed inset-0 m-auto h-fit w-[34rem] max-w-[92vw] rounded-2xl border border-zinc-800 bg-zinc-900 p-0 text-zinc-100 backdrop:bg-black/70">
      <form id="run-form" class="space-y-4 p-6">
        <div class="flex items-center gap-3">
          <div class="grid h-9 w-9 place-items-center rounded-xl bg-amber-500/15 text-amber-400">${icon("rocket", "h-[18px] w-[18px]")}</div>
          <h2 id="run-title" class="font-semibold"></h2>
        </div>
        <label id="run-tag-wrap" class="block text-xs text-zinc-400">Version (tag)
          <select id="run-tag" class="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-100 outline-none focus:border-amber-500"></select>
        </label>
        <div id="run-dirty" class="space-y-3"></div>
        <div class="flex justify-end gap-2 pt-2">
          <button type="button" id="run-cancel" class="rounded-lg px-4 py-2 text-sm text-zinc-400 hover:bg-zinc-800">Cancel</button>
          <button id="run-go" class="flex items-center gap-2 rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-black hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-40">${icon("rocket")} Deploy</button>
        </div>
      </form>
    </dialog>
    <dialog id="confirm" class="fixed inset-0 m-auto h-fit w-96 rounded-2xl border border-zinc-800 bg-zinc-900 p-0 text-zinc-100 backdrop:bg-black/70">
      <form method="dialog" class="space-y-3 p-6">
        <div class="flex items-center gap-3">
          <div class="grid h-9 w-9 place-items-center rounded-xl bg-amber-500/15 text-amber-400">${icon("x", "h-[18px] w-[18px]")}</div>
          <h2 id="confirm-title" class="min-w-0 truncate font-semibold"></h2>
        </div>
        <p id="confirm-text" class="text-sm text-zinc-400"></p>
        <div class="flex justify-end gap-2 pt-2">
          <button value="" class="rounded-lg px-4 py-2 text-sm text-zinc-400 outline-none hover:bg-zinc-800 focus-visible:ring-2 focus-visible:ring-amber-500/50">Cancel</button>
          <button value="ok" id="confirm-ok" class="rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-black outline-none hover:bg-amber-400 focus-visible:ring-2 focus-visible:ring-amber-500/50 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900"></button>
        </div>
      </form>
    </dialog>
    <dialog id="settings" class="fixed inset-0 m-auto h-fit w-[30rem] max-w-[92vw] rounded-2xl border border-zinc-800 bg-zinc-900 p-0 text-zinc-100 backdrop:bg-black/70">
      <div class="space-y-5 p-6">
        <div class="flex items-center gap-3">
          <h2 class="text-lg font-semibold">Settings</h2>
          <button id="set-close" class="ml-auto rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">${icon("x")}</button>
        </div>
        <div class="flex items-center justify-between gap-4">
          <span class="text-sm">Theme</span>
          <div class="flex gap-1 rounded-lg border border-zinc-800 p-1 text-sm">
            <button data-theme-set="light" class="flex items-center gap-1.5 rounded-md px-3 py-1">${icon("sun")} Light</button>
            <button data-theme-set="dark" class="flex items-center gap-1.5 rounded-md px-3 py-1">${icon("moon")} Dark</button>
          </div>
        </div>
        <div class="flex items-center justify-between gap-4">
          <span class="text-sm">Main display background</span>
          <div class="flex gap-2 text-sm">
            <button id="set-wall" class="flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 font-medium text-black hover:bg-amber-400">${icon("image")} Choose</button>
            <button id="set-wall-x" class="rounded-lg px-3 py-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">Remove</button>
          </div>
        </div>
      </div>
    </dialog>
    <dialog id="manual"class="fixed inset-0 m-auto h-[90vh] w-[60rem] max-w-[94vw] rounded-2xl border border-zinc-800 bg-zinc-900 p-0 text-zinc-100 backdrop:bg-black/70">
      <div class="flex h-full flex-col">
        <div class="flex items-center gap-3 border-b border-zinc-800 px-5 py-3">
          <span class="text-amber-400">${icon("book")}</span>
          <h2 class="font-semibold">Deploy YAML manual</h2>
          <button id="manual-close" class="ml-auto rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">${icon("x")}</button>
        </div>
        <article id="manual-body" class="manual min-h-0 flex-1 overflow-auto px-8 py-6"></article>
      </div>
    </dialog>
    <div id="ctx" class="fixed z-50 hidden min-w-48 rounded-xl border border-zinc-700 bg-zinc-900/95 p-1 text-sm text-zinc-100 shadow-2xl shadow-black/50 backdrop-blur"></div>
    <dialog id="auth" class="fixed inset-0 m-auto h-fit w-96 rounded-2xl border border-zinc-800 bg-zinc-900 p-0 text-zinc-100 backdrop:bg-black/70">
      <form id="auth-form" class="space-y-3 p-6">
        <div class="mb-1 flex items-center gap-3">
          <div class="grid h-9 w-9 place-items-center rounded-xl bg-amber-500/15 text-amber-400">${icon("lock", "h-[18px] w-[18px]")}</div>
          <div class="min-w-0">
            <h2 id="auth-title" class="truncate font-semibold"></h2>
            <p id="auth-sub" class="truncate font-mono text-xs text-zinc-500"></p>
          </div>
        </div>
        <div id="auth-fields" class="space-y-3"></div>
        <div class="flex justify-end gap-2 pt-2">
          <button type="button" id="auth-cancel" class="rounded-lg px-4 py-2 text-sm text-zinc-400 hover:bg-zinc-800">Cancel</button>
          <button class="rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-black hover:bg-amber-400">Continue</button>
        </div>
      </form>
    </dialog>`;

  const dlg = $<HTMLDialogElement>("#dlg");
  const form = $<HTMLFormElement>("#f");
  $("#add").onclick = () => openForm();
  $("#cancel").onclick = () => dlg.close();
  $("#eye").onclick = () => {
    const pw = form.elements.namedItem("secret") as HTMLInputElement;
    pw.type = pw.type === "password" ? "text" : "password";
    $("#eye").textContent = pw.type === "password" ? "Show" : "Hide";
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    await saveConn(form);
    dlg.close();
    await refreshList();
    // Open tabs pick up the new name now; new host/user/etc. apply on reconnect.
    tabs.forEach((t) => (t.conn = conns.find((c) => c.id === t.conn.id) ?? t.conn));
    renderTabs();
  };
  $("#q").oninput = renderList;
  $("#manual-open").onclick = openManual;
  $("#manual-close").onclick = () => $<HTMLDialogElement>("#manual").close();
  $("#theme").onclick = () => setTheme(!isLight(), true);
  // Main display: a launcher over everything; the existing workspace is its DevOps app.
  $("#home").onclick = () => $("#launcher").classList.replace("hidden", "flex");
  $("[data-devops]").onclick = () => $("#launcher").classList.replace("flex", "hidden");
  const mainWall = wallpaper($("#launcher"), 0);
  setTheme(isLight());

  // Settings app.
  const setDlg = $<HTMLDialogElement>("#settings");
  const markTheme = () =>
    setDlg.querySelectorAll<HTMLElement>("[data-theme-set]").forEach((b) => {
      const on = (b.dataset.themeSet === "light") === isLight();
      b.classList.toggle("bg-amber-500", on);
      b.classList.toggle("text-black", on);
    });
  setDlg.querySelectorAll<HTMLElement>("[data-theme-set]").forEach((b) =>
    (b.onclick = () => (setTheme(b.dataset.themeSet === "light", true), markTheme())));
  $("[data-settings]").onclick = () => (markTheme(), setDlg.showModal());
  $("#set-close").onclick = () => setDlg.close();
  $("#set-wall").onclick = mainWall.pick;
  $("#set-wall-x").onclick = mainWall.remove;

  wireRunDialog();

  $<HTMLFormElement>("#auth-form").onsubmit = (e) => {
    e.preventDefault();
    answerAuth([...document.querySelectorAll<HTMLInputElement>("#auth-fields input")].map((i) => i.value));
  };
  $("#auth-cancel").onclick = () => answerAuth(null);
  $("#auth").addEventListener("cancel", (e) => (e.preventDefault(), answerAuth(null))); // Esc
  addEventListener("pointerdown", (e) => $("#ctx").contains(e.target as Node) || hideMenu());
  addEventListener("keydown", (e) => e.key === "Escape" && hideMenu());
  addEventListener("blur", hideMenu);
  addEventListener("resize", hideMenu);

  await listen<AuthPrompt>("auth-prompt", (e) => (authQueue.push(e.payload), showAuth()));

  await refreshList();
  renderTabs();
}

/** Same dialog for add (no conn) and edit. */
async function openForm(c?: Conn) {
  const form = $<HTMLFormElement>("#f");
  form.reset();
  const set = (name: string, v: unknown) => ((form.elements.namedItem(name) as HTMLInputElement).value = String(v));
  set("id", c?.id ?? "");
  if (c) {
    (["name", "host", "port", "user", "key_path"] as const).forEach((k) => set(k, c[k]));
    set("secret", await invoke<string>("get_secret", { id: c.id }));
  }
  $("#dlg-title").textContent = c ? `Edit ${c.name}` : "New SSH connection";
  const pw = form.elements.namedItem("secret") as HTMLInputElement;
  pw.type = "password";
  $("#eye").textContent = "Show";
  $<HTMLDialogElement>("#dlg").showModal();
}

function field(name: string, label: string, placeholder: string, attrs = "", required = true) {
  return `<label class="block text-xs text-zinc-400">${label}
    <input name="${name}" placeholder="${esc(placeholder)}" ${attrs} ${required ? "required" : ""}
      class="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-amber-500" />
  </label>`;
}

async function refreshList() {
  conns = await loadConns();
  renderList();
}

function renderList() {
  const q = $<HTMLInputElement>("#q").value.toLowerCase();
  const shown = conns.filter((c) => `${c.name} ${c.host} ${c.user}`.toLowerCase().includes(q));
  $("#list").innerHTML = shown.length
    ? shown.map((c) => {
        const open = tabs.find((t) => t.conn.id === c.id);
        return `
        <div class="group flex items-center rounded-lg hover:bg-zinc-800">
          <button data-open="${c.id}" class="flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left">
            ${dot(open?.status)}
            <span class="min-w-0">
              <span class="block truncate text-sm">${esc(c.name)}</span>
              <span class="block truncate font-mono text-[11px] text-zinc-500">${esc(c.user)}@${esc(c.host)}${c.port === 22 ? "" : `:${c.port}`}</span>
            </span>
          </button>
          <button data-edit="${c.id}" title="Edit" class="hidden rounded px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-700 hover:text-zinc-200 group-hover:block">${icon("pencil", "h-3.5 w-3.5")}</button>
          <button data-del="${c.id}" title="Delete" class="mr-1 hidden rounded px-2 py-1 text-xs text-zinc-500 hover:bg-red-500/15 hover:text-red-400 group-hover:block">${icon("x", "h-3.5 w-3.5")}</button>
        </div>`;
      }).join("")
    : `<p class="px-3 py-6 text-center text-xs text-zinc-600">${conns.length ? "No match" : "No servers yet"}</p>`;

  document.querySelectorAll<HTMLElement>("[data-open]").forEach((b) => {
    const c = conns.find((c) => c.id === +b.dataset.open!)!;
    // Already connected → jump to its first tab; a fresh session is a right-click away.
    b.onclick = () => {
      const t = tabs.find((t) => t.conn.id === c.id);
      if (!t) return openTab(c);
      activeKey = t.key;
      renderTabs();
    };
    b.oncontextmenu = (e) => contextMenu(e, [["New session", "plus", () => openTab(c)]]);
  });
  document.querySelectorAll<HTMLElement>("[data-edit]").forEach((b) =>
    (b.onclick = () => openForm(conns.find((c) => c.id === +b.dataset.edit!))));
  // Two-click delete: first click arms, second confirms.
  document.querySelectorAll<HTMLElement>("[data-del]").forEach((b) =>
    (b.onclick = async () => {
      if (!b.dataset.armed) {
        b.dataset.armed = "1";
        b.textContent = "Delete?";
        b.classList.add("block", "text-red-400");
        setTimeout(() => b.isConnected && renderList(), 3000);
        return;
      }
      const id = +b.dataset.del!;
      tabs.filter((t) => t.conn.id === id).forEach((t) => closeTab(t.key));
      await deleteConn(id);
      await refreshList();
    }));
}

function openTab(c: Conn) {
  const pane = document.createElement("div");
  pane.className = "absolute inset-0";
  $("#stage").append(pane);
  const tab: Tab = { key: ++tabSeq, sid: 0, conn: c, pane, status: "connecting", close: () => {}, where: "" };
  tabs.push(tab);
  activeKey = tab.key;
  connect(tab);
}

/** Opens the machine view: our menu up front, the shell minimised to a button. */
function connect(tab: Tab, attempt = 1, lastErr = "") {
  tab.close();
  const c = tab.conn;
  const sid = (tab.sid = ++sidSeq);
  tab.pane.innerHTML = `
    <div data-view="home" class="absolute inset-0 flex">
      <div data-desk class="flex min-w-0 flex-1 flex-col bg-cover bg-center p-6">
        <div class="flex items-baseline gap-3">
          <h1 class="text-xl font-semibold">${esc(c.name)}</h1>
          <p class="font-mono text-sm text-zinc-500">${esc(c.user)}@${esc(c.host)}:${c.port}</p>
          <span data-stats class="ml-auto hidden items-center gap-4 self-center rounded-full bg-zinc-900/70 px-3 py-1 font-mono text-xs backdrop-blur"></span>
          <span data-ssh class=" flex items-center gap-2 self-center rounded-full bg-zinc-900/70 px-3 py-1 text-xs backdrop-blur"></span>
          <button data-log-btn title="Show log" class="flex items-center gap-1.5 self-center rounded-lg px-2.5 py-1 text-sm hover:bg-zinc-800/60">${icon("logs")} Log</button>
        </div>
        <div class="tiles mt-6 flex-1 overflow-auto">
          ${appTile("deploy", "rocket", "Deploy", true)}
          ${appTile("term-app", "terminal", "Terminal")}
          ${appTile("files-app", "folder", "Files")}
        </div>
      </div>
      <section data-log-panel class="absolute inset-y-0 right-0 z-40 hidden w-[26rem] flex-col border-l border-zinc-800 bg-zinc-900 shadow-2xl shadow-black/50">
        <div class="flex items-center justify-between px-4 pt-3">
          <h2 class="text-[11px] font-medium uppercase tracking-wider text-zinc-500">Log</h2>
          <button data-log-x title="Hide log" class="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">${icon("x", "h-3.5 w-3.5")}</button>
        </div>
        <div data-log class="min-h-0 flex-1 overflow-auto px-4 py-2 font-mono text-xs leading-6"></div>
      </section>
    </div>
    <div data-view="deploy" class="absolute inset-0 hidden flex-col">
      <div class="flex items-center gap-2 border-b border-zinc-800 px-4 py-2.5">
        <button data-back class="flex items-center gap-1 rounded-lg px-2 py-1 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">${icon("chevronLeft")} ${esc(c.name)}</button>
        <span class="text-zinc-600">/</span>
        <span class="flex items-center gap-2 text-sm font-semibold"><span class="text-amber-400">${icon("rocket")}</span> Deploy</span>
      </div>
      <div class="flex min-h-0 flex-1">
        <aside class="flex w-64 shrink-0 flex-col border-r border-zinc-800">
          <div class="p-3">
            <button data-new class="flex w-full items-center justify-center gap-2 rounded-lg bg-amber-500 px-3 py-2 text-sm font-medium text-black hover:bg-amber-400">${icon("plus")} New Deploy</button>
          </div>
          <div class="flex items-center justify-between px-4 pb-1 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
            Deployments
            <button data-refresh title="Refresh" class="rounded p-1 hover:bg-zinc-800 hover:text-zinc-200">${icon("refresh", "h-3.5 w-3.5")}</button>
          </div>
          <nav data-list class="flex-1 space-y-0.5 overflow-auto px-2 pb-3"></nav>
        </aside>
        <main class="flex min-w-0 flex-1 flex-col">
          <div class="flex items-center gap-2 border-b border-zinc-800 px-5 py-2">
            <h2 data-title class="flex-1 truncate font-mono text-sm"></h2>
            <button data-del class="rounded-lg px-3 py-1.5 text-sm text-red-400 hover:bg-red-500/10">Delete</button>
            <button data-manual title="Manual" class="rounded-lg px-2 py-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">${icon("book")}</button>
            <button data-flow class="rounded-lg px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800">Flow</button>
            <button data-sh class="rounded-lg px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800">View sh</button>
            <button data-apply class="flex items-center gap-2 rounded-lg bg-amber-500 px-4 py-1.5 text-sm font-medium text-black hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-40">${icon("rocket")} Apply</button>
          </div>
          <p data-err class="min-h-5 px-5 pt-1 text-xs text-red-400"></p>
          <div data-yaml class="min-h-0 flex-1 overflow-hidden"></div>
          <div data-flowbox class="hidden min-h-0 flex-1 overflow-auto"></div>
          <div class="flex h-60 shrink-0 flex-col border-t border-zinc-800">
            <p class="px-5 pt-2 text-[11px] font-medium uppercase tracking-wider text-zinc-500">Deploy log</p>
            <div data-dlog class="min-h-0 flex-1 overflow-auto px-5 py-1 font-mono text-xs leading-6"></div>
          </div>
        </main>
      </div>
    </div>
    <div data-view="term" class="absolute inset-0 hidden flex-col">
      <div class="flex items-center gap-2 border-b border-zinc-800 px-4 py-2.5">
        <button data-back class="flex items-center gap-1 rounded-lg px-2 py-1 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">${icon("chevronLeft")} ${esc(c.name)}</button>
        <span class="text-zinc-600">/</span>
        <span class="flex items-center gap-2 text-sm font-semibold"><span class="text-amber-400">${icon("terminal")}</span> Terminal</span>
        <span class="ml-auto font-mono text-xs text-zinc-500">${esc(c.user)}@${esc(c.host)}</span>
      </div>
      <div data-term class="min-h-0 flex-1 p-2"></div>
    </div>
    <div data-view="files" class="absolute inset-0 hidden flex-col">
      <div class="flex items-center gap-2 border-b border-zinc-800 px-4 py-2.5">
        <button data-back class="flex items-center gap-1 rounded-lg px-2 py-1 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">${icon("chevronLeft")} ${esc(c.name)}</button>
        <span class="text-zinc-600">/</span>
        <span class="flex items-center gap-2 text-sm font-semibold"><span class="text-amber-400">${icon("folder")}</span> Files</span>
        <details class="relative ml-auto">
          <summary class="cursor-pointer list-none rounded-lg px-2 py-1 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">Settings</summary>
          <div class="absolute right-0 z-50 mt-1 min-w-48 rounded-xl border border-zinc-700 bg-zinc-900/95 p-1 text-sm shadow-2xl shadow-black/50">
            <label class="flex cursor-pointer items-center justify-between gap-4 rounded-lg px-3 py-1.5 hover:bg-zinc-800">
              Show hidden files
              <input type="checkbox" role="switch" data-fhidden class="peer sr-only" />
              <span class="relative h-5 w-9 shrink-0 rounded-full bg-zinc-700 transition-colors peer-checked:bg-amber-500 peer-focus-visible:ring-2 peer-focus-visible:ring-amber-500/50 after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-4"></span>
            </label>
          </div>
        </details>
      </div>
      <form data-fbar class="flex items-center gap-1 border-b border-zinc-800 px-4 py-2">
        <button type="button" data-up title="Up one folder" class="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">${icon("arrowUp")}</button>
        <button type="button" data-frefresh title="Refresh" class="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">${icon("refresh")}</button>
        <input data-path spellcheck="false" class="ml-1 flex-1 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-1.5 font-mono text-sm outline-none focus:border-amber-500" />
      </form>
      <div class="flex min-h-0 flex-1">
        <div data-flist class="min-w-0 flex-1 overflow-auto p-2"></div>
        <section data-fprev class="hidden w-1/2 flex-col border-l border-zinc-800">
          <div class="flex items-center gap-2 border-b border-zinc-800 px-4 py-2">
            <span data-fname class="min-w-0 flex-1 truncate font-mono text-sm"></span>
            <span data-fstat class="shrink-0 text-xs text-zinc-500"></span>
            <button data-fsave disabled title="Save (Ctrl+S)" class="rounded-lg bg-amber-500 px-3 py-1 text-xs font-semibold text-zinc-950 hover:bg-amber-400 disabled:cursor-default disabled:opacity-40">Save</button>
            <button data-fx title="Close preview" class="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">${icon("x", "h-3.5 w-3.5")}</button>
          </div>
          <pre data-fbody class="min-h-0 flex-1 overflow-auto whitespace-pre p-4 font-mono text-xs leading-5"></pre>
          <div data-fed class="hidden min-h-0 flex-1"></div>
        </section>
      </div>
    </div>
    <div data-loading class="absolute inset-0 z-50 grid place-items-center bg-zinc-950/40 backdrop-blur-md">
      <div class="flex flex-col items-center gap-3">
        <span class="h-10 w-10 animate-spin rounded-full border-4 border-zinc-700 border-t-amber-500"></span>
        <p class="text-sm text-zinc-300">Connecting to ${esc(c.name)}…</p>
      </div>
    </div>`;
  const q = (s: string) => tab.pane.querySelector<HTMLElement>(s)!;
  const log = makeLog(q("[data-log]"));
  const ctx: DeployCtx = { sid, connId: c.id, log: makeLog(q("[data-dlog]")) };
  const openDeploy = deployPage(ctx, q('[data-view="deploy"]'));
  type View = "home" | "deploy" | "term" | "files";
  let cur: View = "home";
  const setWhere = () => {
    tab.where = `/devops/server/${tab.conn.id}${cur === "home" ? "" : `/${cur}`}`;
    showWhere();
  };
  const openFiles = filesPage(sid, c.id, q('[data-view="files"]'));
  const view = (v: "home" | "deploy" | "term" | "files") => {
    tab.pane.querySelectorAll<HTMLElement>("[data-view]").forEach((el) => {
      el.classList.toggle("hidden", el.dataset.view !== v);
      el.classList.toggle("flex", el.dataset.view === v);
    });
    cur = v;
    setWhere();
    if (v === "term") term.focus();
  };
  setWhere();
  q("[data-deploy]").onclick = () => (view("deploy"), openDeploy());
  tab.pane.querySelectorAll<HTMLElement>("[data-back]").forEach((b) => (b.onclick = () => view("home")));
  const showLog = (show: boolean) => {
    q("[data-log-panel]").classList.toggle("hidden", !show);
    q("[data-log-panel]").classList.toggle("flex", show);
    q("[data-log-btn]").classList.toggle("hidden", show);
  };
  q("[data-log-btn]").onclick = () => showLog(true);
  q("[data-log-x]").onclick = () => showLog(false);

  wallpaper(q("[data-desk]"), c.id);
  const setStatus = (s: Status) => {
    tab.status = s;
    q("[data-ssh]").innerHTML = `${dot(s)} SSH ${s === "live" ? "connected" : s === "connecting" ? "connecting…" : "disconnected"}`;
    q("[data-loading]").classList.toggle("hidden", s !== "connecting");
    if (!tabs.includes(tab)) return; // tab closed meanwhile
    renderTabs();
    renderList();
  };

  // Terminal (minimised until the button is pressed).
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: "'Cascadia Mono', Consolas, monospace",
    fontSize: 14,
    theme: termTheme(),
  });
  terms.add(term);
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(q("[data-term]"));
  q("[data-term-app]").onclick = () => view("term");
  q("[data-files-app]").onclick = () => (view("files"), openFiles());

  let closed = false;
  const cleanups: (() => void)[] = [];
  const add = (f: () => void) => (closed ? f() : cleanups.push(f));
  tab.close = () => {
    if (closed) return;
    closed = true;
    cancelAuth(sid);
    cleanups.reverse().forEach((f) => f());
    terms.delete(term);
    term.dispose();
  };
  const ro = new ResizeObserver(() => {
    if (!q("[data-term]").clientWidth) return; // minimised or hidden tab
    fit.fit();
    invoke("term_resize", { sid, cols: term.cols, rows: term.rows });
  });
  ro.observe(q("[data-term]"));
  add(() => ro.disconnect());

  /** Refreshes the CPU/RAM/disk pill every 3 s while this machine's home view is on screen. */
  async function pollStats() {
    const box = q("[data-stats]");
    let prev: Cpu | undefined;
    while (!closed && tab.status === "live") {
      if (!tab.pane.classList.contains("hidden") && !q('[data-view="home"]').classList.contains("hidden")) {
        try {
          const s = parseStats((await invoke<ExecOut>("remote_exec", { sid, command: STATS_SCRIPT })).out, prev);
          prev = s.cpuRaw;
          box.innerHTML = statsHtml(s);
          box.classList.replace("hidden", "flex");
        } catch {
          break; // not Linux, or session gone
        }
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    box.classList.replace("flex", "hidden");
  }

  setStatus("connecting");
  if (lastErr) log("warn", `Attempt ${attempt - 1} failed: ${lastErr}`);
  log("info", `Connecting to ${c.user}@${c.host}:${c.port}…${attempt > 1 ? ` (attempt ${attempt}/3)` : ""}`);
  // Until setup finishes, any failure retries on its own (3 tries total); after that, drops wait for the reconnect button.
  let settled = false;
  const retry = (why: string) => {
    if (settled || attempt >= 3) return false;
    settled = true; // retry once per attempt
    setTimeout(() => tabs.includes(tab) && tab.sid === sid && connect(tab, attempt + 1, why), 1000);
    return true;
  };
  (async () => {
    // Listen before connecting so the first bytes aren't lost.
    add(await listen<number[]>(`term-data-${sid}`, (e) => term.write(new Uint8Array(e.payload))));
    add(await listen(`term-exit-${sid}`, () => {
      if (retry("session dropped during setup")) return;
      term.writeln("\r\n\x1b[33m[disconnected]\x1b[0m");
      log("err", "Disconnected. Use the reconnect button on the tab.");
      q("[data-deploy]").toggleAttribute("disabled", true);
      q("[data-apply]").toggleAttribute("disabled", true);
      setStatus("closed");
    }));
    if (closed) return;
    try {
      await invoke("ssh_connect", {
        sid, id: c.id, host: c.host, port: c.port, user: c.user, keyPath: c.key_path, cols: term.cols, rows: term.rows,
      });
    } catch (err) {
      if (closed || retry(String(err))) return;
      log("err", `Connection failed: ${err}`);
      setStatus("closed");
      return;
    }
    add(() => invoke("ssh_disconnect", { sid }));
    const input = term.onData((data) => invoke("term_write", { sid, data }).catch(() => {}));
    add(() => input.dispose());
    if (closed) return;
    setStatus("live");
    log("ok", "Connected");
    pollStats();
    // ponytail: settles only on setup success; a real setup error leaves retry armed, so a later drop auto-reconnects too.
    if (await runSetup(sid, log)) {
      settled = true;
      q("[data-deploy]").toggleAttribute("disabled", false);
    }
  })();
}

const gb = (b: number) => (b / 2 ** 30).toFixed(1);
const meter = (label: string, pct: number | null, text: string) => {
  const p = Math.round(pct ?? 0);
  const color = p > 85 ? "bg-red-400" : p > 60 ? "bg-amber-400" : "bg-emerald-400";
  return `<span class="flex items-center gap-1.5" title="${label} ${pct === null ? "…" : p + "%"}">
    <span class="text-zinc-500">${label}</span>
    <span class="h-1.5 w-10 overflow-hidden rounded-full bg-zinc-700"><span class="block h-full rounded-full ${color}" style="width:${p}%"></span></span>
    ${text}</span>`;
};
const statsHtml = (s: Stats) =>
  meter("CPU", s.cpu, s.cpu === null ? "…" : `${Math.round(s.cpu)}%`) +
  meter("RAM", (100 * s.memUsed) / s.memTotal, `${gb(s.memUsed)}/${gb(s.memTotal)}G`) +
  meter("Disk", s.disk, `${Math.round(s.disk)}%`);

/** Makes sure the workspace folder and database exist on the machine; true when ready. */
async function runSetup(sid: number, log: (level: LogLevel, text: string) => void) {
  log("info", `Checking ${REMOTE_DIR}/ and ${REMOTE_DB}…`);
  try {
    const r = await invoke<{ out: string; code: number }>("remote_exec", { sid, command: SETUP_SCRIPT });
    const got = Object.fromEntries(r.out.split("\n").map((l) => l.trim().split("=")));
    const report = (v: string | undefined, path: string) =>
      v === "exists" ? log("ok", `found    ${path}`) : v === "created" ? log("warn", `created  ${path}`) : log("err", `failed   ${path}`);
    report(got.dir, `${REMOTE_DIR}/`);
    report(got.db, `${REMOTE_DIR}/${REMOTE_DB}`);
    const ok = /^(exists|created)$/.test(got.dir ?? "") && /^(exists|created)$/.test(got.db ?? "");
    if (!ok && r.out.trim()) log("err", r.out.trim());
    if (ok) log("ok", "Workspace ready");
    return ok;
  } catch (err) {
    log("err", `Setup failed: ${err}`);
    return false;
  }
}

// ---------- files page (browse + edit, saved only on Save) ----------

/** Wires the Files page of one machine; returns a function to call each time the page is shown. */
function filesPage(sid: number, connId: number, root: HTMLElement) {
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const list = q("[data-flist]");
  const input = q<HTMLInputElement>("[data-path]");
  let cur = "~";
  let opened = false;
  let last: Entry[] = [];
  const hiddenBox = q<HTMLInputElement>("[data-fhidden]");
  hiddenBox.checked = localStorage.showHidden === "1"; // default: hide dotfiles
  hiddenBox.onchange = () => ((localStorage.showHidden = hiddenBox.checked ? "1" : "0"), render(last));
  const run = (command: string) => invoke<ExecOut>("remote_exec", { sid, command });
  const showPrev = (show: boolean) => {
    q("[data-fprev]").classList.toggle("hidden", !show);
    q("[data-fprev]").classList.toggle("flex", show);
  };

  async function go(path: string) {
    list.innerHTML = `<p class="px-3 py-2 text-xs text-zinc-500">Loading…</p>`;
    try {
      const r = await run(listScript(path));
      if (!r.out.startsWith("/")) throw r.out.trim() || `exit ${r.code}`; // cd failed (missing / no permission)
      const { path: abs, entries } = parseListing(r.out);
      cur = abs;
      input.value = abs;
      render(entries);
    } catch (err) {
      input.value = cur;
      list.innerHTML = `<p class="px-3 py-2 font-mono text-xs text-red-400">${esc(err)}</p>`;
    }
  }

  function render(all: Entry[]) {
    last = all;
    const entries = hiddenBox.checked ? all : all.filter((e) => !e.name.startsWith("."));
    list.innerHTML = entries.length
      ? `<div class="grid grid-cols-[1fr_6rem_9rem] px-3 pb-1 text-[11px] font-medium uppercase tracking-wider text-zinc-500"><span>Name</span><span class="text-right">Size</span><span class="text-right">Modified</span></div>` +
        entries
          .map((e, i) => `
            <button data-fi="${i}" class="grid w-full grid-cols-[1fr_6rem_9rem] items-center rounded-lg px-3 py-1.5 text-left text-sm hover:bg-zinc-800">
              <span class="flex min-w-0 items-center gap-3 ${e.name.startsWith(".") ? "opacity-60" : ""}">
                ${appArt(e.dir ? "folder" : "file", "h-7 w-7 drop-shadow-[0_2px_2px_rgb(0_0_0/0.3)]", fileColor(e.name))}
                <span class="truncate">${esc(e.name)}</span>
              </span>
              <span class="text-right font-mono text-xs text-zinc-500">${e.dir ? "" : fmtSize(e.size)}</span>
              <span class="text-right font-mono text-xs text-zinc-500">${esc(e.mtime)}</span>
            </button>`)
          .join("")
      : `<p class="px-3 py-6 text-center text-xs text-zinc-600">Empty folder</p>`;
    list.querySelectorAll<HTMLElement>("[data-fi]").forEach((b) => {
      const e = entries[+b.dataset.fi!];
      b.onclick = () => (e.dir ? go(joinPath(cur, e.name)) : preview(e));
    });
  }

  // ---- editor: changes stay local until Save ----
  const body = q("[data-fbody]");
  const saveBtn = q<HTMLButtonElement>("[data-fsave]");
  let file: { path: string; saved: string; eol: string } | null = null; // null = nothing editable open
  const dirty = () => !!file && ed.get() !== file.saved;
  const stat = (text: string, cls = "text-zinc-500") => {
    const s = q("[data-fstat]");
    s.textContent = s.title = text;
    s.className = `max-w-[50%] truncate text-xs ${cls}`;
  };
  const onEdit = () => {
    saveBtn.disabled = !dirty();
    if (file) stat(dirty() ? "● Unsaved changes" : "", "text-amber-400");
  };
  const ed = createEditor(q("[data-fed]"), onEdit);
  const showEditor = (on: boolean) => {
    body.classList.toggle("hidden", on);
    q("[data-fed]").classList.toggle("hidden", !on);
  };
  /** True when it's fine to drop what's in the editor. */
  const canLeave = async () => !dirty() || confirmBox("Discard changes?", `${file!.path} has unsaved changes.`, "Discard");

  async function preview(e: Entry) {
    if (!(await canLeave())) return;
    const path = joinPath(cur, e.name);
    file = null;
    onEdit();
    stat("");
    q("[data-fname]").textContent = path;
    body.textContent = "Loading…";
    showEditor(false);
    showPrev(true);
    try {
      const r = await run(readScript(path));
      if (r.code) throw r.out.trim() || `exit ${r.code}`;
      if (/[\0�]/.test(r.out)) return void (body.textContent = "Binary file, no preview.");
      const cut = e.size > PREVIEW_BYTES; // saving a partial read would truncate the file
      ed.set(r.out, modeFor(e.name), cut);
      if (cut) stat(`Read-only: first ${fmtSize(PREVIEW_BYTES)} of ${fmtSize(e.size)}`, "text-amber-400");
      else file = { path, saved: ed.get(), eol: r.out.includes("\r\n") ? "\r\n" : "\n" };
      showEditor(true);
      ed.focus();
    } catch (err) {
      body.textContent = String(err);
    }
  }

  async function save() {
    if (!file || !dirty()) return;
    const f = file;
    const text = ed.get();
    saveBtn.disabled = true;
    stat("Saving…");
    try {
      const content = text.replace(/\n/g, f.eol);
      let r = await invoke<ExecOut>("remote_exec", { sid, command: writeScript(f.path), stdin: content });
      if (r.code && /permission denied/i.test(r.out)) {
        // not ours (e.g. /etc): retry as root with the saved login password
        const pw = await invoke<string>("get_secret", { id: connId });
        if (!pw) throw "Permission denied; save the login password (edit button) to write as root via sudo";
        stat("Saving with sudo…");
        r = await invoke<ExecOut>("remote_exec", { sid, command: sudoWriteScript(f.path), stdin: `${pw}\n${content}` });
      }
      if (r.code) throw r.out.trim() || `exit ${r.code}`;
      f.saved = text;
      if (file !== f) return;
      if (dirty()) onEdit(); // typed more while saving
      else stat(`✓ Saved ${new Date().toLocaleTimeString([], { hour12: false })}`, "text-emerald-400");
      go(cur); // size / modified time
    } catch (err) {
      if (file === f) {
        saveBtn.disabled = false;
        stat(`Save failed: ${err}`, "text-red-400");
      }
    }
  }

  saveBtn.onclick = save;
  q("[data-fprev]").addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      save();
    }
  });
  q("[data-up]").onclick = () => go(parentOf(cur));
  q("[data-frefresh]").onclick = () => go(cur);
  q<HTMLFormElement>("[data-fbar]").onsubmit = (e) => (e.preventDefault(), go(input.value.trim() || "~"));
  q("[data-fx]").onclick = async () => {
    if (!(await canLeave())) return;
    file = null;
    onEdit();
    showPrev(false);
  };

  return () => {
    if (!opened) {
      opened = true;
      go("~");
    }
  };
}

// ---------- deploy page (list, YAML editor, apply) ----------

type ExecOut = { out: string; code: number };
type DeployCtx = { sid: number; connId: number; log: (level: LogLevel, text: string) => void };

// Login shell so PATH matches an interactive session (nvm, pm2, …).
const SHELL = "bash -l -s";
const remote = (ctx: DeployCtx, command: string, stdin?: string, stream = false) =>
  invoke<ExecOut>("remote_exec", { sid: ctx.sid, command, stdin, stream });

/** Timestamped, coloured log lines appended to `box`. */
function makeLog(box: HTMLElement) {
  return (level: LogLevel, text: string) => {
    const time = new Date().toLocaleTimeString([], { hour12: false });
    box.insertAdjacentHTML(
      "beforeend",
      `<div class="whitespace-pre-wrap"><span class="text-zinc-600">${time}</span>  <span class="${LOG_COLOR[level]}">${esc(text)}</span></div>`,
    );
    while (box.childElementCount > 3000) box.firstElementChild!.remove(); // ponytail: cap DOM for long builds
    box.scrollTop = box.scrollHeight;
  };
}

/** Wires the Deploy page of one machine; returns a function to call each time the page is shown. */
function deployPage(ctx: DeployCtx, root: HTMLElement) {
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  let current: string | null = null; // selected deployment, null = new
  let shYaml: string | null = null; // YAML kept aside while showing the generated sh
  let opened = false;
  const ed = createEditor(q("[data-yaml]"), () => shYaml === null && validate());
  const flow = createFlow(q("[data-flowbox]"), (text, step) => ctx.log(step ? "step" : "info", `[sim] ${text}`));
  const flowOn = () => !q("[data-flowbox]").classList.contains("hidden");
  const showFlow = (on: boolean) => {
    q("[data-flowbox]").classList.toggle("hidden", !on);
    q("[data-yaml]").classList.toggle("hidden", on);
    q("[data-flow]").textContent = on ? "Back to YAML" : "Flow";
    if (!on) return;
    const m = parseManifest(ed.get());
    flow.render(compile(m, { tag: "<tag>", discard: m.targets.map((t) => t.name), sudoPassword: "********" }), `${m.gitUrl} @ ${m.version}`);
  };

  const validate = () => {
    try {
      parseManifest(ed.get());
      q("[data-err]").textContent = "";
      return true;
    } catch (e) {
      q("[data-err]").textContent = (e as Error).message;
      return false;
    }
  };
  const showYaml = (text = shYaml ?? ed.get()) => {
    shYaml = null;
    showFlow(false);
    ed.set(text, "manifest");
    q("[data-sh]").textContent = "View sh";
  };
  const resetDel = () => {
    const b = q("[data-del]");
    b.textContent = "Delete";
    delete b.dataset.armed;
  };
  const setCurrent = (name: string | null) => {
    current = name;
    q("[data-title]").textContent = name ? `deployments/${name}.yaml` : "New deployment";
    q("[data-del]").classList.toggle("hidden", !name);
    resetDel();
    root.querySelectorAll<HTMLElement>("[data-dep]").forEach((b) => b.classList.toggle("bg-zinc-800", b.dataset.dep === name));
  };

  async function select(name: string | null) {
    showYaml(TEMPLATE);
    setCurrent(name);
    if (name) {
      try {
        ed.set((await remote(ctx, scripts.read(name))).out);
      } catch (err) {
        ctx.log("err", `[${name}] cannot read manifest: ${err}`);
      }
    }
    validate();
    ed.focus();
  }

  async function refresh() {
    const list = q("[data-list]");
    list.innerHTML = `<p class="px-3 py-2 text-xs text-zinc-500">Loading…</p>`;
    try {
      // each line: "<name> <tag> ok|failed <date> <time>" or "<name> never"
      const rows = (await remote(ctx, scripts.list)).out.trim().split("\n").filter(Boolean).map((l) => l.split(" "));
      list.innerHTML = rows.length
        ? rows
            .map(([name, ...st]) => `
              <button data-dep="${esc(name)}" class="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-zinc-800">
                ${dot(st[1] === "ok" ? "live" : st[1] === "failed" ? "closed" : undefined)}
                <span class="min-w-0 flex-1">
                  <span class="block truncate font-mono text-sm">${esc(name)}</span>
                  <span class="block truncate text-[11px] text-zinc-500">${esc(st[0] === "never" ? "never deployed" : st.join(" "))}</span>
                </span>
              </button>`)
            .join("")
        : `<p class="px-3 py-2 text-xs text-zinc-500">None yet</p>`;
      list.querySelectorAll<HTMLElement>("[data-dep]").forEach((b) => (b.onclick = () => select(b.dataset.dep!)));
      setCurrent(current);
    } catch (err) {
      list.innerHTML = `<p class="px-3 py-2 text-xs text-red-400">${esc(err)}</p>`;
    }
  }

  q("[data-new]").onclick = () => select(null);
  q("[data-refresh]").onclick = refresh;
  // Preview what will actually run on the machine.
  q("[data-manual]").onclick = openManual;
  q("[data-flow]").onclick = () => {
    if (flowOn()) return showFlow(false);
    if (shYaml !== null) showYaml();
    if (validate()) showFlow(true);
  };
  q("[data-sh]").onclick = () => {
    if (shYaml !== null) return showYaml();
    if (!validate()) return;
    showFlow(false);
    shYaml = ed.get();
    ed.set(compile(parseManifest(shYaml), { tag: "<chosen at deploy>", discard: [], sudoPassword: "********" }), "sh", true);
    q("[data-sh]").textContent = "Back to YAML";
  };
  q("[data-apply]").onclick = async () => {
    if (shYaml !== null) showYaml();
    if (!validate()) return;
    showFlow(true); // watch the steps light up while it runs
    const btn = q<HTMLButtonElement>("[data-apply]");
    btn.disabled = true;
    try {
      await startDeploy(ctx, ed.get(), flow);
    } finally {
      btn.disabled = false;
    }
    setCurrent(parseManifest(ed.get()).name);
    refresh();
  };
  q("[data-del]").onclick = async () => {
    const b = q("[data-del]");
    if (!b.dataset.armed) {
      b.dataset.armed = "1";
      b.textContent = "Delete manifest?";
      return;
    }
    if (!current) return;
    const r = await remote(ctx, scripts.remove(current)).catch((e) => ({ out: String(e), code: 1 }));
    ctx.log(r.code ? "err" : "ok", `[${current}] ${r.out.trim()}`);
    await select(null);
    refresh();
  };

  return () => {
    if (!opened) {
      opened = true;
      select(null);
    }
    refresh();
  };
}

// ----- the "are you sure" step: pick a tag, confirm discarding local changes -----

type RunChoice = { tag: string; discard: string[] };
let runResolve: ((c: RunChoice | null) => void) | null = null;

function askRun(m: Manifest, tags: string[], dirty: Map<string, string[]>): Promise<RunChoice | null> {
  $("#run-title").textContent = `Deploy ${m.name}`;
  const pickTag = m.version === "tag";
  $("#run-tag-wrap").classList.toggle("hidden", !pickTag);
  $<HTMLSelectElement>("#run-tag").innerHTML = (pickTag ? tags : [m.version])
    .map((t, i) => `<option value="${esc(t)}">${esc(t)}${i === 0 && pickTag ? "  (latest)" : ""}</option>`)
    .join("");
  $("#run-dirty").innerHTML = m.targets
    .filter((t) => dirty.has(t.name))
    .map((t) => {
      const files = `<pre class="mt-2 max-h-32 overflow-auto font-mono text-[11px] text-zinc-400">${esc(dirty.get(t.name)!.join("\n"))}</pre>`;
      const head = `<p class="font-medium">${esc(t.name)}: working tree has local changes</p>`;
      if (t.dirty === "ask")
        return `<div class="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-400">${head}${files}
          <label class="mt-2 flex items-center gap-2 text-zinc-200"><input type="checkbox" data-discard="${esc(t.name)}" class="accent-amber-500" />
          Discard these changes (git reset --hard + git clean -fd)</label></div>`;
      const note = t.dirty === "discard" ? "will be discarded (dirty: discard)" : "deploy will stop here (dirty: fail)";
      return `<div class="rounded-lg border border-zinc-800 p-3 text-sm text-zinc-400">${head}${files}<p class="mt-2 text-xs">${note}</p></div>`;
    })
    .join("");
  const boxes = [...document.querySelectorAll<HTMLInputElement>("#run-dirty [data-discard]")];
  const sync = () => $<HTMLButtonElement>("#run-go").toggleAttribute("disabled", boxes.some((b) => !b.checked));
  boxes.forEach((b) => (b.onchange = sync));
  sync();
  $<HTMLDialogElement>("#run").showModal();
  return new Promise((res) => (runResolve = res));
}

function wireRunDialog() {
  const dlg = $<HTMLDialogElement>("#run");
  const done = (c: RunChoice | null) => {
    dlg.close();
    runResolve?.(c);
    runResolve = null;
  };
  $("#run-cancel").onclick = () => done(null);
  dlg.addEventListener("cancel", (e) => (e.preventDefault(), done(null)));
  $<HTMLFormElement>("#run-form").onsubmit = (e) => {
    e.preventDefault();
    const discard = [...document.querySelectorAll<HTMLInputElement>("#run-dirty [data-discard]")].map((b) => b.dataset.discard!);
    done({ tag: $<HTMLSelectElement>("#run-tag").value, discard });
  };
}

/** Our "kubectl apply": save manifest -> precheck -> ask -> compile to bash -> run (streamed). */
async function startDeploy(ctx: DeployCtx, text: string, flow?: { step(): void; end(ok: boolean): void }) {
  const m = parseManifest(text);
  const tag = `[${m.name}]`;
  try {
    const saved = await remote(ctx, scripts.save(m, text));
    if (saved.code) return ctx.log("err", `${tag} cannot save manifest: ${saved.out.trim()}`);
    ctx.log("info", `${tag} manifest saved, checking ${m.version === "tag" ? "tags and " : ""}working trees…`);

    const pre = await remote(ctx, SHELL, scripts.precheck(m));
    const tags: string[] = [];
    const dirty = new Map<string, string[]>();
    let cur: string[] | null = null;
    for (const line of pre.out.split("\n")) {
      if (line.startsWith("tag ")) tags.push(line.slice(4).trim());
      else if (line.startsWith("dirty ")) dirty.set(line.slice(6).trim(), (cur = []));
      else if (line.startsWith("  ") && cur) cur.push(line.slice(2));
    }
    tags.reverse(); // newest first
    if (m.version === "tag" && !tags.length) return ctx.log("err", `${tag} no tags found\n${pre.out.trim()}`);

    const choice = await askRun(m, tags, dirty);
    if (!choice) return ctx.log("warn", `${tag} cancelled`);

    let sudoPassword: string | undefined;
    if (m.sudo === "login-password") {
      sudoPassword = await invoke<string>("get_secret", { id: ctx.connId });
      if (!sudoPassword) return ctx.log("err", `${tag} sudo needs the saved login password; set it with the edit button`);
    }
    const script = compile(m, { ...choice, sudoPassword });

    ctx.log("info", `${tag} deploying ${choice.tag}…`);
    const decoder = new TextDecoder();
    let partial = "";
    const emit = (line: string) => {
      if (line.startsWith("==> ")) flow?.step();
      ctx.log(line.startsWith("==> ") ? "step" : line.startsWith("!! ") ? "err" : "info", line);
    };
    const un = await listen<number[]>(`exec-data-${ctx.sid}`, (e) => {
      const lines = (partial + decoder.decode(new Uint8Array(e.payload), { stream: true })).split(/\r?\n/);
      partial = lines.pop()!;
      lines.filter((l) => l.trim()).forEach(emit);
    });
    try {
      const r = await remote(ctx, SHELL, script, true);
      if (partial.trim()) emit(partial);
      flow?.end(!r.code);
      ctx.log(r.code ? "err" : "ok", r.code ? `${tag} deploy failed (exit ${r.code})` : `${tag} deployed ${choice.tag}`);
    } finally {
      un();
    }
  } catch (e) {
    ctx.log("err", `${tag} ${e}`);
  }
}

/** Our own yes/no dialog (no native confirm). Resolves true on the OK button. */
function confirmBox(title: string, text: string, ok: string) {
  const dlg = $<HTMLDialogElement>("#confirm");
  $("#confirm-title").textContent = title;
  $("#confirm-text").textContent = text;
  $("#confirm-ok").textContent = ok;
  dlg.returnValue = "";
  dlg.showModal();
  $("#confirm-ok").focus();
  return new Promise<boolean>((res) => dlg.addEventListener("close", () => res(dlg.returnValue === "ok"), { once: true }));
}

function closeTab(key: number) {
  const i = tabs.findIndex((t) => t.key === key);
  if (i < 0) return;
  tabs[i].close();
  tabs[i].pane.remove();
  tabs.splice(i, 1);
  if (activeKey === key) activeKey = (tabs[i] ?? tabs[i - 1])?.key ?? 0;
  renderTabs();
  renderList();
}

/** Bottom-left breadcrumb: which machine / page / path is on screen. */
function showWhere() {
  const el = $("#where");
  el.textContent = el.title = tabs.find((t) => t.key === activeKey)?.where ?? "/devops";
}

function renderTabs() {
  $("#tabs").innerHTML = tabs.map((t) => `
    <div data-tab="${t.key}" class="group flex max-w-56 cursor-pointer items-center gap-2 rounded-t-lg border-x border-t px-3 py-2 text-sm ${
      t.key === activeKey ? "border-zinc-800 bg-zinc-950 text-zinc-100" : "border-transparent text-zinc-500 hover:text-zinc-300"
    }">
      ${dot(t.status)}
      <span class="truncate">${esc(t.conn.name)}</span>
      ${t.status === "closed" ? `<button data-re="${t.key}" title="Reconnect" class="rounded p-1 text-amber-400 hover:bg-zinc-800">${icon("refresh", "h-3.5 w-3.5")}</button>` : ""}
      <button data-x="${t.key}" title="Close" class="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">${icon("x", "h-3.5 w-3.5")}</button>
    </div>`).join("");

  tabs.forEach((t) => t.pane.classList.toggle("hidden", t.key !== activeKey));
  showWhere();
  if (!tabs.length) {
    $("#stage").querySelector("#empty")?.remove();
    $("#stage").insertAdjacentHTML("beforeend", `
      <div id="empty" class="absolute inset-0 grid place-items-center">
        <div class="text-center">
          <div class="mx-auto mb-4 w-fit">${logo("h-20 w-20")}</div>
          <p class="font-medium">No open machines</p>
          <p class="mt-1 text-sm text-zinc-500">Pick a server on the left, or add a new one.</p>
          <button id="add2" class="mt-5 rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-black hover:bg-amber-400">+ New connection</button>
        </div>
      </div>`);
    $("#add2").onclick = () => $("#add").click();
  } else {
    $("#stage").querySelector("#empty")?.remove();
  }

  document.querySelectorAll<HTMLElement>("[data-tab]").forEach((el) =>
    (el.onclick = () => {
      activeKey = +el.dataset.tab!;
      renderTabs();
    }));
  document.querySelectorAll<HTMLElement>("[data-x]").forEach((b) =>
    (b.onclick = async (e) => {
      e.stopPropagation();
      const t = tabs.find((t) => t.key === +b.dataset.x!);
      if (!t) return;
      // A dead connection has nothing to lose; only ask when it's still open.
      if (t.status !== "closed" && !(await confirmBox(`Close ${t.conn.name}?`, "The SSH session and its terminal will be disconnected.", "Disconnect"))) return;
      closeTab(t.key);
    }));
  document.querySelectorAll<HTMLElement>("[data-re]").forEach((b) =>
    (b.onclick = (e) => (e.stopPropagation(), connect(tabs.find((t) => t.key === +b.dataset.re!)!))));
}

app();

/** Offline manual: bundled markdown (src/manual.md), rendered on first open. */
function openManual() {
  const body = $("#manual-body");
  if (!body.innerHTML) body.innerHTML = marked.parse(manualMd, { async: false });
  $<HTMLDialogElement>("#manual").showModal();
}
