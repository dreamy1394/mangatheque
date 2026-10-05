// Ma mangathèque : application Android (Capacitor). Données et couvertures stockées sur le téléphone.
import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import { Filesystem, Directory } from "@capacitor/filesystem";
import { LocalNotifications } from "@capacitor/local-notifications";
import { App } from "@capacitor/app";

const $ = (id) => document.getElementById(id);
const UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Mobile Safari/537.36";
const state = { series: [], meta: {}, loaded: false, tab: "shelf", detailId: null, filter: "all", q: "", editing: null, sheetVol: null, busyVol: null, shelfScroll: 0, checking: false };

// ---------- Outils ----------
const todayISO = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const daysUntil = (iso) => Math.round((new Date(iso + "T00:00:00") - new Date(todayISO() + "T00:00:00")) / 86400000);
const fmtDate = (iso, opts) => new Date(iso + "T00:00:00").toLocaleDateString("fr-FR", opts || { day: "numeric", month: "short" });
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const icon = (n, fill) => `<span class="ms${fill ? " fill" : ""}" aria-hidden="true">${n}</span>`;
const statusLabel = (s) => ({ ongoing: "En cours", done: "Terminée", paused: "En pause" }[s || "ongoing"]);
const norm = (t) => String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/\((les|le|la|l')\)\s*$/, "").replace(/^(les|le|la|l')\s*/, "").replace(/&/g, " et ").replace(/[^a-z0-9]+/g, " ").trim();

function parseOwned(text) {
  const out = new Set();
  for (const part of String(text || "").split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) throw new Error(`« ${part} » n'est pas un numéro ou une plage (ex. 1-12).`);
    const a = +m[1], b = m[2] ? +m[2] : a;
    if (b < a || b - a > 500) throw new Error(`La plage « ${part} » est invalide.`);
    for (let i = a; i <= b; i++) out.add(i);
  }
  return [...out].sort((x, y) => x - y);
}
function formatOwned(arr) {
  const a = [...arr].sort((x, y) => x - y), parts = [];
  for (let i = 0; i < a.length; i++) {
    let j = i; while (j + 1 < a.length && a[j + 1] === a[j] + 1) j++;
    parts.push(i === j ? `${a[i]}` : `${a[i]}-${a[j]}`); i = j;
  }
  return parts.join(", ");
}

// Vue calculée : un tome annoncé dont la date est passée compte comme paru.
function view(s) {
  const owned = new Set(s.owned || []);
  const next = s.next && s.next.vol ? s.next : null;
  const nextOut = next && next.date && daysUntil(next.date) <= 0;
  const published = Math.max(s.published || 0, nextOut ? next.vol : 0);
  const missing = [];
  for (let i = 1; i <= published; i++) if (!owned.has(i)) missing.push(i);
  const upcoming = next && !nextOut && !owned.has(next.vol) ? next : null;
  return { s, owned, published, missing, upcoming, total: Math.max(published, upcoming ? upcoming.vol : 0, ...owned) };
}
const find = (id) => state.series.find((s) => s.id === id);
const clone = (s) => JSON.parse(JSON.stringify(s));
function nextToBuy(s) {
  const v = view(s);
  return v.missing[0] || (v.upcoming ? v.upcoming.vol : Math.max(v.published, ...v.owned, 0) + 1);
}

// ---------- Stockage local ----------
async function persist() {
  await Preferences.set({ key: "series", value: JSON.stringify(state.series) });
  await Preferences.set({ key: "meta", value: JSON.stringify(state.meta) });
}
async function load() {
  const { value } = await Preferences.get({ key: "series" });
  if (value) state.series = JSON.parse(value);
  else {
    // Premier lancement : reprend la collection exportée depuis la version web, couvertures comprises.
    try { const r = await fetch("seed.json"); if (r.ok) state.series = (await r.json()).series || []; } catch {}
    for (const s of state.series) {
      for (const [vol, path] of Object.entries(s.seedCovers || {})) {
        try { const r = await fetch(path); if (r.ok) await storeCover(s, +vol, await blobToBase64(await r.blob())); } catch {}
      }
      delete s.seedCovers;
    }
    await persist();
  }
  const m = await Preferences.get({ key: "meta" });
  state.meta = m.value ? JSON.parse(m.value) : {};
  try { state.filter = (await Preferences.get({ key: "filter" })).value || "all"; } catch {}
  state.loaded = true;
}
async function upsert(s, msg) {
  s.updatedAt = new Date().toISOString();
  const i = state.series.findIndex((x) => x.id === s.id);
  if (i >= 0) state.series[i] = s; else state.series.push(s);
  try { await persist(); } catch { snack("Échec de l'enregistrement."); return false; }
  render(); scheduleNotifications();
  if (msg) snack(msg);
  return true;
}

// ---------- Couvertures (fichiers dans le stockage de l'appli) ----------
const coverSrc = new Map();
function coverUrl(file) {
  if (!file) return null;
  if (coverSrc.has(file)) return coverSrc.get(file);
  coverSrc.set(file, null);
  (async () => {
    try {
      if (Capacitor.isNativePlatform()) {
        const { uri } = await Filesystem.getUri({ path: file, directory: Directory.Data });
        coverSrc.set(file, Capacitor.convertFileSrc(uri));
      } else {
        const { data } = await Filesystem.readFile({ path: file, directory: Directory.Data });
        coverSrc.set(file, typeof data === "string" ? `data:image/jpeg;base64,${data}` : URL.createObjectURL(data));
      }
      render();
    } catch {}
  })();
  return null;
}
const imgTag = (file) => { const u = coverUrl(file); return u ? `<img src="${esc(u)}" alt="" loading="lazy">` : ""; };
function coverFor(v) {
  const c = v.s.covers || {};
  const vols = Object.keys(c).map(Number).filter((n) => c[n]);
  if (!vols.length) return null;
  const ownedWith = vols.filter((n) => v.owned.has(n));
  const vol = ownedWith.length ? Math.max(...ownedWith) : Math.min(...vols);
  return { vol, file: c[vol] };
}
const cvHtml = (v, cls = "cv") => { const c = coverFor(v); const img = c && imgTag(c.file); return `<div class="${cls}">${img || (Math.max(...v.owned, 0) || icon("menu_book"))}</div>`; };

const blobToBase64 = (blob) => new Promise((ok, ko) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1]); r.onerror = ko; r.readAsDataURL(blob); });
async function shrinkToBase64(blob) {
  try {
    const url = URL.createObjectURL(blob);
    const img = await new Promise((ok, ko) => { const i = new Image(); i.onload = () => ok(i); i.onerror = ko; i.src = url; });
    const scale = Math.min(1, 600 / img.naturalHeight);
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    return c.toDataURL("image/jpeg", 0.85).split(",")[1];
  } catch { return blobToBase64(blob); }
}
async function storeCover(s, vol, base64) {
  const file = `covers/${s.id}-${vol}-${Date.now().toString(36)}.img`;
  await Filesystem.writeFile({ path: file, data: base64, directory: Directory.Data, recursive: true });
  const old = (s.covers || {})[vol];
  s.covers = { ...(s.covers || {}), [vol]: file };
  if (old) Filesystem.deleteFile({ path: old, directory: Directory.Data }).catch(() => {});
}
// Télécharge une image (pas de restriction de site dans l'appli native).
async function downloadImage(url) {
  if (Capacitor.isNativePlatform()) {
    const r = await CapacitorHttp.get({ url, responseType: "blob", headers: { "User-Agent": UA } });
    if (r.status !== 200 || !r.data) throw new Error("http " + r.status);
    const ct = String((r.headers && (r.headers["Content-Type"] || r.headers["content-type"])) || "");
    if (ct && !/^image\//i.test(ct)) throw new Error("not image");
    return r.data;
  }
  const r = await fetch(url); if (!r.ok) throw new Error("http " + r.status);
  return blobToBase64(await r.blob());
}
async function getText(url) {
  if (Capacitor.isNativePlatform()) {
    const r = await CapacitorHttp.get({ url, headers: { "User-Agent": UA, "Accept-Language": "fr-FR,fr" } });
    if (r.status !== 200) throw new Error("http " + r.status);
    return typeof r.data === "string" ? r.data : String(r.data);
  }
  const r = await fetch(url); if (!r.ok) throw new Error("http " + r.status); return r.text();
}

// ---------- Catalogue de la BnF (dépôt légal, API publique SRU) ----------
// Manga-news et Nautiljon bloquent les applis (protection Cloudflare) : on s'appuie sur les données ouvertes de la BnF.
const BNF = "https://catalogue.bnf.fr/api/SRU";
const cleanPublisher = (p) => String(p || "").replace(/\s*\([^)]*\)\s*$/, "").trim();
// « Frieren. Vol. 13 / scénario… », « Valkyrie apocalypse. 25 », « One Piece - Édition originale - Tome 112 »
function parseVolumeTitle(raw) {
  const main = String(raw || "").split(" / ")[0].replace(/\s+/g, " ").trim();
  let m = main.match(/^(.+?)\s*[.,-]\s*(?:(?:vol(?:ume)?|tome|t)\.?\s*)?(\d{1,3})(?:\s*[:,.].*)?$/i)
    || main.match(/^(.+?)\s*-\s*(?:.+?\s*-\s*)?(?:tome|vol\.?)\s*(\d{1,3})\b/i)
    || main.match(/^(.+?)\s+(\d{1,3})(?:\s*:.*)?$/);
  if (!m) return null;
  const base = m[1].replace(/\s*[-.:]\s*$/, "").trim();
  return base ? { base, vol: +m[2] } : null;
}
// « Yamada, Kanehito. Auteur du texte » -> « Kanehito Yamada »
const flipName = (n) => { const m = String(n || "").replace(/\s*\(.*?\)\s*/g, " ").trim().match(/^([^,]+),\s*(.+)$/); return (m ? `${m[2]} ${m[1]}` : String(n || "")).replace(/\.\.\.$/, "").trim(); };
// Mentions de responsabilité : « scénario, Kanehito Yamada ; dessin, Tsukasa Abe » ou « Eiichiro Oda »
function parseCredits(rawTitle, creators, contributors) {
  let author = "", artist = "";
  const stmt = String(rawTitle || "").split(" / ").slice(1).join(" / ");
  for (const part0 of stmt.split(/\s*;\s*/)) {
    const part = part0.replace(/\[.*?\]/g, "").replace(/\.\.\.$/, "").replace(/\.\s*\d+\s*$/, "").trim();
    let m;
    if ((m = part.match(/^(?:scénar(?:io|iste)|scenar(?:io|iste)|texte|récit|story|auteure?)\s*[,:]\s*(.+)$/i))) author ||= m[1];
    else if ((m = part.match(/^(?:dessin(?:s|ateur|atrice)?|illustrat(?:ions?|eur|rice)|art)\s*[,:]\s*(.+)$/i))) artist ||= m[1];
    else if ((m = part.match(/^(?:(?:une\s+)?(?:œuvre|oeuvre)\s+de|par|de)\s+(.+)$/i)) && !author) { author = m[1]; artist ||= m[1]; }
    else if (!author && !artist && part && !/trad|adapt|couleur|lettrage|original|réal|d'après/i.test(part) && part.split(" ").length <= 4) { author = part; artist = part; }
  }
  const stripRole = (x) => flipName(x.replace(/\.\s+(?:auteur|illustrat|dessinat|scénar|traduct|adaptat)[^.]*$/i, ""));
  if (!author) { const c = creators.find((x) => /auteur|scénariste|texte/i.test(x)) || creators[0]; if (c) author = stripRole(c); }
  if (!artist) { const c = [...creators, ...contributors].find((x) => /illustrat|dessinat/i.test(x)); if (c) artist = stripRole(c); }
  if (!artist && creators.length === 1 && !contributors.some((x) => /illustrat|dessin/i.test(x)) && !/texte/i.test(creators[0])) artist = author;
  return { author: author.trim(), artist: artist.trim() };
}
const topOf = (counts) => Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
async function bnfSearch(title) {
  const q = `bib.title all "${title.replace(/"/g, " ")}" and bib.doctype any "a"`;
  const url = `${BNF}?version=1.2&operation=searchRetrieve&query=${encodeURIComponent(q)}&recordSchema=dublincore&maximumRecords=200`;
  const xml = await getText(url);
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const groups = new Map();
  for (const rec of doc.getElementsByTagNameNS("*", "dc")) {
    const get = (tag) => [...rec.getElementsByTagNameNS("*", tag)].map((e) => e.textContent.trim());
    const lang = get("language").join(" ");
    if (lang && !/fre|fran/i.test(lang)) continue;
    const pv = parseVolumeTitle(get("title")[0]);
    if (!pv) continue;
    const key = norm(pv.base);
    const g = groups.get(key) || { key, title: pv.base, vols: new Set(), publishers: {}, authors: {}, artists: {}, lastYear: 0 };
    const cr = parseCredits(get("title")[0], get("creator"), get("contributor"));
    if (cr.author) g.authors[cr.author] = (g.authors[cr.author] || 0) + 1;
    if (cr.artist) g.artists[cr.artist] = (g.artists[cr.artist] || 0) + 1;
    g.vols.add(pv.vol);
    const pub = cleanPublisher(get("publisher")[0]);
    if (pub) g.publishers[pub] = (g.publishers[pub] || 0) + 1;
    const y = parseInt(get("date")[0], 10); if (y > g.lastYear) g.lastYear = y;
    if (/^[A-Z0-9]/.test(pv.base) && !/^[A-Z0-9]/.test(g.title)) g.title = pv.base;
    groups.set(key, g);
  }
  const wanted = norm(title);
  return [...groups.values()]
    .map((g) => ({ ...g, count: Math.max(...g.vols), publisher: topOf(g.publishers), author: topOf(g.authors), artist: topOf(g.artists) }))
    .sort((a, b) => (b.key === wanted) - (a.key === wanted) || b.count - a.count)
    .slice(0, 6);
}
// Vérifie dans le catalogue si de nouveaux tomes sont parus pour chaque série en cours.
async function checkReleases({ silent } = {}) {
  if (state.checking) return;
  state.checking = true; render();
  let changes = 0, errors = 0;
  const found = [];
  for (const orig of state.series.filter((s) => (s.status || "ongoing") === "ongoing")) {
    try {
      const key = orig.bnfKey || norm(orig.title);
      const g = (await bnfSearch(orig.title)).find((x) => x.key === key);
      if (!g || g.count <= (orig.published || 0)) continue;
      const s = clone(orig);
      s.published = g.count;
      if (s.next && s.next.vol <= g.count) { s.next = null; s.pinned = false; }
      s.updatedAt = new Date().toISOString();
      state.series[state.series.findIndex((x) => x.id === s.id)] = s;
      changes++; found.push(`${s.title} t.${g.count}`);
    } catch { errors++; }
  }
  if (errors && !changes && errors === state.series.length) { state.checking = false; render(); if (!silent) snack("Le catalogue de la BnF ne répond pas. Vérifie ta connexion."); return; }
  state.meta = { ...state.meta, checkedAt: new Date().toISOString(), source: "BnF" };
  await persist();
  state.checking = false; render(); scheduleNotifications();
  if (changes) snack(`Nouveau${changes > 1 ? "x" : ""} tome${changes > 1 ? "s" : ""} paru${changes > 1 ? "s" : ""} : ${found.join(", ")}`);
  else if (!silent) snack("Aucun nouveau tome paru depuis la dernière vérification.");
}

// ---------- Notifications le jour de la sortie ----------
const notifId = (s, vol) => { let h = 7; for (const c of s.id + ":" + vol) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h) % 2000000000 + 1; };
async function scheduleNotifications() {
  if (!Capacitor.isNativePlatform()) return;
  try {
    const perm = await LocalNotifications.checkPermissions();
    if (perm.display !== "granted") return;
    const pending = await LocalNotifications.getPending();
    if (pending.notifications.length) await LocalNotifications.cancel({ notifications: pending.notifications.map((n) => ({ id: n.id })) });
    const list = [];
    for (const s of state.series) {
      const v = view(s);
      if (!s.pinned || !v.upcoming || !v.upcoming.date) continue;
      const at = new Date(v.upcoming.date + "T09:00:00");
      if (at <= new Date()) continue;
      list.push({ id: notifId(s, v.upcoming.vol), title: `${s.title} t.${v.upcoming.vol} sort aujourd'hui`, body: "Pense à le récupérer en librairie.", schedule: { at, allowWhileIdle: true } });
    }
    if (list.length) await LocalNotifications.schedule({ notifications: list });
  } catch {}
}
async function askNotifications() {
  if (!Capacitor.isNativePlatform()) return;
  try { const p = await LocalNotifications.checkPermissions(); if (p.display === "prompt" || p.display === "prompt-with-rationale") await LocalNotifications.requestPermissions(); } catch {}
}

// ---------- Snackbar ----------
let snackTimer;
function snack(msg) {
  const el = $("snack"), host = document.querySelector("dialog[open]") || document.body;
  if (el.parentNode !== host) host.appendChild(el);
  el.textContent = msg; el.hidden = false;
  clearTimeout(snackTimer); snackTimer = setTimeout(() => (el.hidden = true), 4000);
}

// ---------- Actions ----------
async function setOwned(s0, vol, own) {
  const s = clone(s0), set = new Set(s.owned || []);
  own ? set.add(vol) : set.delete(vol);
  s.owned = [...set].sort((x, y) => x - y);
  if (own && vol > (s.published || 0)) s.published = vol;
  if (own && s.next && s.next.vol === vol) { s.next = null; s.pinned = false; }
  await upsert(s, own ? `${s.title} t.${vol} ajouté à l'étagère` : `${s.title} t.${vol} retiré`);
}

// ---------- Vues ----------
function seriesCard(v) {
  const s = v.s, pct = v.published ? Math.round((v.owned.size / Math.max(v.published, v.owned.size)) * 100) : 0;
  let tag = "";
  if (v.missing.length) tag = `<span class="tag err">${v.missing.length} manquant${v.missing.length > 1 ? "s" : ""}</span>`;
  else if (v.owned.size) tag = `<span class="tag ok">${icon("check")}À jour</span>`;
  const nextTag = v.upcoming && v.upcoming.date ? `<span class="tag next">${icon("event")}t.${v.upcoming.vol} · ${fmtDate(v.upcoming.date)}</span>` : "";
  return `<div class="s-card" role="button" tabindex="0" data-act="open" data-id="${esc(s.id)}">
    ${cvHtml(v)}
    <div class="s-body">
      <div class="s-t">${esc(s.title)}</div>
      <div class="s-sub">${esc([s.author, s.publisher, statusLabel(s.status)].filter(Boolean).join(" · "))}${s.example ? " · exemple" : ""}</div>
      <div class="progress" aria-hidden="true"><span style="width:${pct}%"></span></div>
      <div class="s-foot"><span class="num">${v.owned.size} / ${v.published}</span>${tag}${nextTag}</div>
    </div>
    <button class="icon-btn tonal" type="button" data-act="plus" data-id="${esc(s.id)}" aria-label="J'ai acheté le tome ${nextToBuy(s)} de ${esc(s.title)}">${icon("add")}</button>
  </div>`;
}
function matches(v) {
  if (state.q && !(`${v.s.title} ${v.s.publisher || ""} ${v.s.author || ""} ${v.s.artist || ""}`).toLowerCase().includes(state.q)) return false;
  if (state.filter === "missing") return v.missing.length > 0;
  if (state.filter === "ongoing") return (v.s.status || "ongoing") === "ongoing";
  if (state.filter === "done") return v.s.status === "done";
  return true;
}
function shelfView(views) {
  if (!state.loaded) return `<div class="empty">${icon("hourglass_empty")}<span>Chargement…</span></div>`;
  const tomes = views.reduce((n, v) => n + v.owned.size, 0);
  const chips = [["all", "Toutes"], ["missing", "À compléter"], ["ongoing", "En cours"], ["done", "Terminées"]]
    .map(([k, l]) => `<button class="chip" type="button" data-act="filter" data-f="${k}" aria-pressed="${state.filter === k}">${state.filter === k ? icon("check") : ""}${l}</button>`).join("");
  let html = `<p class="summary"><span><b class="num">${views.length}</b> série${views.length > 1 ? "s" : ""}</span><span><b class="num">${tomes}</b> tome${tomes > 1 ? "s" : ""}</span></p><div class="chips" role="group" aria-label="Filtrer">${chips}</div>`;
  if (!views.length) return html + `<div class="empty">${icon("auto_stories")}<strong>Ton étagère est vide</strong><span>Ajoute ta première série avec le bouton « Série ».</span></div>`;
  const shown = views.filter(matches).sort((a, b) =>
    (b.missing.length > 0) - (a.missing.length > 0) ||
    ((a.upcoming && a.upcoming.date) || "9999").localeCompare((b.upcoming && b.upcoming.date) || "9999") ||
    a.s.title.localeCompare(b.s.title, "fr"));
  if (!shown.length) return html + `<div class="empty">${icon("filter_alt_off")}<span>Aucune série ne correspond.</span></div>`;
  return html + `<div class="list">${shown.map(seriesCard).join("")}</div>`;
}
function releaseItem(v) {
  const d = v.upcoming.date, n = d ? daysUntil(d) : null;
  const tile = d ? `<div class="date-tile ${n <= 7 ? "soon" : ""}"><b class="num">${new Date(d + "T00:00:00").getDate()}</b><span>${fmtDate(d, { month: "short" }).replace(".", "")}</span></div>` : `<div class="date-tile"><b>?</b><span>date</span></div>`;
  const when = d ? (n === 0 ? "Sort aujourd'hui" : n === 1 ? "Sort demain" : n <= 7 ? `Dans ${n} jours` : fmtDate(d, { weekday: "long", day: "numeric", month: "long" })) : "Date non annoncée";
  return `<div class="li">${tile}<div class="li-body" data-act="open" data-id="${esc(v.s.id)}" role="button" tabindex="0"><div class="li-t">${esc(v.s.title)} <span class="num">t.${v.upcoming.vol}</span></div><div class="li-s ${d && n <= 7 ? "hot" : ""}">${when}</div></div>
    <button class="icon-btn ${v.s.pinned ? "on" : ""}" type="button" data-act="pin" data-id="${esc(v.s.id)}" aria-pressed="${!!v.s.pinned}" aria-label="${v.s.pinned ? "Désépingler" : "Épingler et me prévenir"}">${icon("push_pin", v.s.pinned)}</button></div>`;
}
function buyView(views) {
  const now = views.filter((v) => v.missing.length).sort((a, b) => a.s.title.localeCompare(b.s.title, "fr"));
  const pinned = views.filter((v) => v.upcoming && v.s.pinned).sort((a, b) => (a.upcoming.date || "9999").localeCompare(b.upcoming.date || "9999"));
  let html = `<div class="section-title">En librairie <span>${now.reduce((n, v) => n + v.missing.length, 0)} tome(s)</span></div>`;
  html += now.length ? `<div class="card">${now.map((v) => {
    const first = v.missing[0];
    return `<div class="li">${cvHtml(v)}<div class="li-body" data-act="open" data-id="${esc(v.s.id)}" role="button" tabindex="0"><div class="li-t">${esc(v.s.title)}</div><div class="li-s num">Tome${v.missing.length > 1 ? "s" : ""} ${esc(formatOwned(v.missing))}</div></div>
      <button class="btn tonal small" type="button" data-act="buy" data-id="${esc(v.s.id)}" data-vol="${first}">${icon("check")}t.${first}</button></div>`;
  }).join("")}</div>` : `<div class="info">${icon("task_alt")}<span>Rien en retard : toutes tes séries sont à jour.</span></div>`;
  html += `<div class="section-title">Épinglés <span>notification le jour de la sortie</span></div>`;
  html += pinned.length ? `<div class="card">${pinned.map(releaseItem).join("")}</div>` : `<div class="info">${icon("push_pin")}<span>Épingle une sortie depuis l'onglet Sorties : tu recevras une notification le jour J.</span></div>`;
  return html;
}
function soonView(views) {
  const m = state.meta;
  let html = `<div class="info">${icon(state.checking ? "hourglass_top" : "sync")}<span>${state.checking ? "Recherche de nouveaux tomes dans le catalogue de la BnF…" : `${m && m.checkedAt ? `Nouveaux tomes vérifiés le ${new Date(m.checkedAt).toLocaleDateString("fr-FR", { day: "numeric", month: "long" })}. ` : ""}Touche ⟳ pour chercher les tomes parus. Les dates à venir se saisissent dans la fiche de la série.`}</span></div>`;
  const up = views.filter((v) => v.upcoming).sort((a, b) => (a.upcoming.date || "9999").localeCompare(b.upcoming.date || "9999"));
  if (!up.length) html += `<div class="empty">${icon("event_busy")}<strong>Aucune sortie annoncée</strong><span>Les prochains tomes de tes séries en cours apparaîtront ici.</span></div>`;
  let month = null;
  for (const v of up) {
    const key = v.upcoming.date ? fmtDate(v.upcoming.date, { month: "long", year: "numeric" }) : "Date à venir";
    if (key !== month) { if (month !== null) html += `</div>`; html += `<div class="section-title">${key.charAt(0).toUpperCase() + key.slice(1)}</div><div class="card">`; month = key; }
    html += releaseItem(v);
  }
  if (month !== null) html += `</div>`;
  const waiting = views.filter((v) => !v.upcoming && (v.s.status || "ongoing") === "ongoing");
  if (waiting.length) html += `<div class="section-title">Pas encore annoncé <span>${waiting.length}</span></div><p class="summary">${waiting.map((v) => esc(v.s.title)).join(" · ")}</p>`;
  return html;
}
function creditsHtml(s) {
  const a = (s.author || "").trim(), d = (s.artist || "").trim();
  if (!a && !d) return "";
  if (a && d && norm(a) !== norm(d)) return `<span class="credits"><span>Scénario <b>${esc(a)}</b></span><span>Dessin <b>${esc(d)}</b></span></span>`;
  return `<span class="credits"><span>Auteur <b>${esc(a || d)}</b></span></span>`;
}
function detailView() {
  const s = find(state.detailId);
  if (!s) return `<div class="empty">${icon("search_off")}<span>Cette série n'existe plus.</span></div>`;
  const v = view(s), covers = s.covers || {};
  let html = `<div class="hero">${cvHtml(v, "hero-cv")}<div class="hero-txt">
    <span class="tag">${esc(statusLabel(s.status))}</span>
    <h2>${esc(s.title)}</h2>
    ${creditsHtml(s)}
    <span class="s-sub">${esc(s.publisher || "Éditeur non renseigné")}${s.example ? " · exemple" : ""}</span></div></div>
    <div class="stats"><div><b class="num">${v.owned.size}</b><span>possédés</span></div><div><b class="num">${v.published}</b><span>parus</span></div><div><b class="num" style="${v.missing.length ? "color:var(--error)" : ""}">${v.missing.length}</b><span>manquants</span></div></div>`;
  if (v.upcoming) html += `<div class="next-card">${icon("event_upcoming")}<div class="grow"><div style="font-weight:500">Tome ${v.upcoming.vol}</div><div style="font-size:13px">${v.upcoming.date ? fmtDate(v.upcoming.date, { weekday: "long", day: "numeric", month: "long" }) : "Date non annoncée"}</div></div>
    <button class="icon-btn" type="button" data-act="pin" data-id="${esc(s.id)}" aria-pressed="${!!s.pinned}" aria-label="${s.pinned ? "Désépingler" : "Épingler et me prévenir"}">${icon("push_pin", s.pinned)}</button></div>`;
  html += `<div class="actions"><button class="btn filled" type="button" data-act="plus" data-id="${esc(s.id)}">${icon("add")}J'ai le tome ${nextToBuy(s)}</button><button class="btn outlined" type="button" data-act="edit" data-id="${esc(s.id)}">${icon("edit")}Modifier</button></div>`;
  html += `<div class="section-title">Tomes</div><p class="summary">Touche un tome pour le cocher ou changer sa couverture.</p><div class="tiles">`;
  for (let i = 1; i <= Math.max(v.total, 1); i++) {
    const own = v.owned.has(i), isNext = v.upcoming && v.upcoming.vol === i, miss = !own && !isNext && i <= v.published;
    const img = covers[i] && imgTag(covers[i]);
    const lbl = own ? "Possédé" : isNext ? (v.upcoming.date ? fmtDate(v.upcoming.date) : "Annoncé") : miss ? "Manquant" : "";
    html += `<button class="tile ${miss ? "miss" : ""} ${isNext ? "next" : ""} ${!own ? "notown" : ""}" type="button" data-act="tome" data-vol="${i}" aria-label="Tome ${i}, ${lbl || "non paru"}">
      <div class="art">${img || `<span class="num">${i}</span>`}${own ? `<span class="st">${icon("check")}</span>` : ""}</div>
      <span class="lbl"><span class="num">t.${i}</span><span>${lbl}</span></span></button>`;
  }
  return html + `</div>`;
}
function sheetView() {
  const s = find(state.detailId), i = state.sheetVol;
  if (!s || !i) return "";
  const v = view(s), file = (s.covers || {})[i], own = v.owned.has(i);
  const q = encodeURIComponent(`${s.title} tome ${i} ${s.publisher || ""} manga couverture`);
  return `<div class="sheet-head"><div class="cv">${(file && imgTag(file)) || i}</div><div><h3>Tome ${i}</h3><div class="s-sub">${esc(s.title)}${state.busyVol === i ? " · enregistrement de la couverture…" : ""}</div></div></div>
    <button class="menu-item" type="button" data-act="s-own">${icon(own ? "remove_done" : "check_circle")}${own ? "Retirer de mon étagère" : "Je l'ai"}</button>
    <button class="menu-item" type="button" data-act="s-file">${icon("add_photo_alternate")}${file ? "Changer la couverture (photo ou image)" : "Ajouter une couverture (photo ou image)"}</button>
    <div class="paste">${icon("link")}<input id="urlZone" type="url" inputmode="url" placeholder="Colle le lien d'une image" aria-label="Lien de l'image de couverture" autocomplete="off"><button class="btn text small" type="button" data-act="s-url">OK</button></div>
    <a class="menu-item" href="https://www.google.com/search?tbm=isch&q=${q}" target="_blank" rel="noopener">${icon("image_search")}Chercher la couverture</a>
    ${file ? `<button class="menu-item danger" type="button" data-act="s-delcover">${icon("hide_image")}Enlever la couverture</button>` : ""}`;
}

// ---------- Rendu ----------
function render() {
  const views = state.series.map(view);
  const inDetail = !!state.detailId;
  $("backBtn").hidden = !inDetail;
  $("appbar").classList.toggle("with-back", inDetail);
  $("searchBtn").hidden = inDetail || state.tab !== "shelf";
  $("menuBtn").hidden = inDetail || state.tab !== "shelf";
  $("checkBtn").hidden = inDetail || state.tab !== "soon";
  $("checkBtn").disabled = state.checking;
  $("editBtn").hidden = !inDetail || !find(state.detailId);
  $("searchbar").hidden = inDetail || state.tab !== "shelf" || !state.searchOpen;
  $("barTitle").textContent = inDetail ? (find(state.detailId)?.title || "") : { shelf: "Ma mangathèque", buy: "À acheter", soon: "Prochaines sorties" }[state.tab];
  $("fab").hidden = inDetail;
  for (const b of document.querySelectorAll(".nav-item")) b.setAttribute("aria-current", !inDetail && b.dataset.tab === state.tab ? "page" : "false");
  const nBuy = views.reduce((n, v) => n + v.missing.length, 0);
  $("buyBadge").hidden = !nBuy; $("buyBadge").textContent = nBuy > 99 ? "99+" : nBuy;
  const html = inDetail ? detailView() : state.tab === "buy" ? buyView(views) : state.tab === "soon" ? soonView(views) : shelfView(views);
  const key = inDetail ? "d:" + state.detailId : state.tab, main = $("main");
  if (main.dataset.key !== key) { main.innerHTML = `<div class="view">${html}</div>`; main.dataset.key = key; }
  else main.firstElementChild.innerHTML = html;
  if ($("sheet").open) {
    const keep = $("urlZone") ? $("urlZone").value : "";
    const focused = document.activeElement && document.activeElement.id === "urlZone";
    $("sheetBody").innerHTML = sheetView();
    if ($("urlZone")) { $("urlZone").value = keep; if (focused) $("urlZone").focus(); }
  }
}
function go(tab) { state.tab = tab; state.detailId = null; closeSheet(); render(); window.scrollTo(0, 0); }
function openDetail(id) { state.shelfScroll = window.scrollY; state.detailId = id; render(); window.scrollTo(0, 0); }
function back() { state.detailId = null; closeSheet(); render(); window.scrollTo(0, state.shelfScroll); }
window.addEventListener("scroll", () => $("appbar").classList.toggle("scrolled", window.scrollY > 4), { passive: true });

// ---------- Événements ----------
document.querySelector(".navbar").addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) go(b.dataset.tab); });
$("backBtn").addEventListener("click", back);
$("editBtn").addEventListener("click", () => openForm(find(state.detailId)));
$("fab").addEventListener("click", () => openForm(null));
$("checkBtn").addEventListener("click", () => checkReleases());
$("searchBtn").addEventListener("click", () => { state.searchOpen = true; render(); $("search").focus(); });
$("searchClose").addEventListener("click", () => { state.searchOpen = false; state.q = ""; $("search").value = ""; render(); });
$("search").addEventListener("input", (e) => { state.q = e.target.value.trim().toLowerCase(); render(); });

$("main").addEventListener("click", async (ev) => {
  const el = ev.target.closest("[data-act]"); if (!el) return;
  const act = el.dataset.act, s = el.dataset.id ? find(el.dataset.id) : find(state.detailId), vol = +el.dataset.vol;
  if (act === "filter") { state.filter = el.dataset.f; Preferences.set({ key: "filter", value: state.filter }).catch(() => {}); render(); return; }
  if (!s) return;
  if (act === "open") openDetail(s.id);
  if (act === "plus") setOwned(s, nextToBuy(s), true);
  if (act === "buy") setOwned(s, vol, true);
  if (act === "pin") {
    const c = clone(s); c.pinned = !c.pinned;
    if (c.pinned) await askNotifications();
    await upsert(c, c.pinned ? "Épinglé : notification le jour de la sortie" : "Désépinglé");
  }
  if (act === "edit") openForm(s);
  if (act === "tome") openSheet(vol);
});
$("main").addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target.matches("[role=button][data-act]")) { e.preventDefault(); e.target.click(); } });

// ---------- Feuille d'un tome ----------
function openSheet(vol) { state.sheetVol = vol; $("sheetBody").innerHTML = sheetView(); $("sheet").showModal(); }
function closeSheet() { if ($("sheet").open) $("sheet").close(); }
$("sheet").addEventListener("close", () => { state.sheetVol = null; });
$("sheet").addEventListener("click", async (e) => {
  if (e.target === $("sheet")) { closeSheet(); return; }
  const el = e.target.closest("[data-act]"); if (!el) return;
  const s = find(state.detailId), i = state.sheetVol; if (!s || !i) return;
  if (el.dataset.act === "s-own") { closeSheet(); setOwned(s, i, !(s.owned || []).includes(i)); }
  if (el.dataset.act === "s-file") $("coverFile").click();
  if (el.dataset.act === "s-url") coverFromUrl(i);
  if (el.dataset.act === "s-delcover") {
    const c = clone(s), old = (c.covers || {})[i];
    delete c.covers[i];
    if (await upsert(c, `Couverture du tome ${i} enlevée`)) { Filesystem.deleteFile({ path: old, directory: Directory.Data }).catch(() => {}); closeSheet(); }
  }
});
$("sheet").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.id === "urlZone") { e.preventDefault(); coverFromUrl(state.sheetVol); } });
async function withBusy(vol, fn) {
  state.busyVol = vol; render();
  try { await fn(); } finally { state.busyVol = null; render(); }
}
async function coverFromUrl(vol) {
  const url = ($("urlZone")?.value || "").trim();
  if (!/^https?:\/\//i.test(url)) { snack("Colle un lien qui commence par https://"); return; }
  const s = clone(find(state.detailId));
  await withBusy(vol, async () => {
    try {
      const b64 = await downloadImage(url);
      await storeCover(s, vol, b64);
      if (await upsert(s, `Couverture du tome ${vol} ajoutée`)) closeSheet();
    } catch { snack("Impossible de récupérer cette image. Vérifie que le lien mène bien à une image."); }
  });
}
$("coverFile").addEventListener("change", async (e) => {
  const f = e.target.files && e.target.files[0], vol = state.sheetVol;
  e.target.value = "";
  if (!f || !vol) return;
  const s = clone(find(state.detailId));
  await withBusy(vol, async () => {
    try { await storeCover(s, vol, await shrinkToBase64(f)); if (await upsert(s, `Couverture du tome ${vol} ajoutée`)) closeSheet(); }
    catch { snack("Échec de l'enregistrement de l'image."); }
  });
});

// ---------- Formulaire ----------
function openForm(s) {
  state.editing = s ? s.id : null;
  $("formTitle").textContent = s ? "Modifier la série" : "Nouvelle série";
  $("f-title").value = s ? s.title : "";
  $("f-publisher").value = s ? s.publisher || "" : "";
  $("f-author").value = s ? s.author || "" : "";
  $("f-artist").value = s ? s.artist || "" : "";
  $("f-status").value = s ? s.status || "ongoing" : "ongoing";
  $("f-published").value = s ? s.published || "" : "";
  $("f-owned").value = s ? formatOwned(s.owned || []) : "";
  $("f-nextvol").value = s && s.next ? s.next.vol || "" : "";
  $("f-nextdate").value = s && s.next ? s.next.date || "" : "";
  $("bnfResults").innerHTML = ""; $("bnfNote").hidden = true; state.bnfPick = null;
  $("f-pinned").checked = !!(s && s.pinned);
  $("formErr").hidden = true;
  $("delBtn").hidden = !s;
  $("formDlg").showModal();
}
$("formClose").addEventListener("click", () => $("formDlg").close());
$("delBtn").addEventListener("click", () => {
  const s = find(state.editing); if (!s) return;
  $("confirmTxt").textContent = `${s.title} et ses ${(s.owned || []).length} tome(s) cochés seront retirés de ton étagère.`;
  $("confirmDlg").showModal();
});
$("confirmNo").addEventListener("click", () => $("confirmDlg").close());
$("confirmYes").addEventListener("click", async () => {
  const s = find(state.editing);
  $("confirmDlg").close();
  if (!s) return;
  state.series = state.series.filter((x) => x.id !== s.id);
  await persist();
  for (const f of Object.values(s.covers || {})) Filesystem.deleteFile({ path: f, directory: Directory.Data }).catch(() => {});
  $("formDlg").close(); if (state.detailId === s.id) back(); else render();
  scheduleNotifications(); snack(`${s.title} supprimée`);
});
$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = (m) => { $("formErr").textContent = m; $("formErr").hidden = false; };
  const title = $("f-title").value.trim();
  if (!title) return err("Donne un titre à la série.");
  let owned;
  try { owned = parseOwned($("f-owned").value); } catch (x) { return err(x.message); }
  const published = Math.max(+$("f-published").value || 0, owned.length ? owned[owned.length - 1] : 0);
  const nextVol = +$("f-nextvol").value || 0, nextDate = $("f-nextdate").value;
  if (nextDate && !nextVol) return err("Indique le numéro du prochain tome pour cette date.");
  const prev = state.editing ? find(state.editing) : null;
  const s = {
    ...(prev ? clone(prev) : {}),
    id: prev ? prev.id : (title.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "serie") + "-" + Math.random().toString(36).slice(2, 6),
    title, publisher: $("f-publisher").value.trim(), author: $("f-author").value.trim(), artist: $("f-artist").value.trim(), status: $("f-status").value, published, owned,
    next: nextVol ? { vol: nextVol, date: nextDate || null, source: prev && prev.next && prev.next.vol === nextVol && prev.next.date === (nextDate || null) ? prev.next.source || null : "saisie" } : null,
    pinned: $("f-pinned").checked && !!nextVol,
  };
  delete s.mnSlug;
  if (state.bnfPick && norm(title) === norm(state.bnfPick.title)) s.bnfKey = state.bnfPick.key;
  else if (prev && prev.title !== title) delete s.bnfKey;
  if (prev) delete s.example;
  if (s.pinned) await askNotifications();
  if (await upsert(s, prev ? "Série mise à jour" : `${title} ajoutée`)) { $("formDlg").close(); if (!prev) openDetail(s.id); }
});

// ---------- Sauvegarde ----------
$("menuBtn").addEventListener("click", () => {
  const data = state.series.map((s) => { const c = clone(s); delete c.covers; return c; });
  $("csvStatus").hidden = true;
  $("backupText").value = JSON.stringify({ app: "mangatheque", version: 1, series: data }, null, 1);
  $("backupDlg").showModal();
});
$("backupClose").addEventListener("click", () => $("backupDlg").close());
$("backupCopy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("backupText").value); snack("Sauvegarde copiée"); }
  catch { $("backupText").select(); snack("Sélectionne le texte et copie-le."); }
});
$("backupRestore").addEventListener("click", async () => {
  try {
    const d = JSON.parse($("backupText").value);
    if (!d || !Array.isArray(d.series) || d.series.some((s) => !s.id || !s.title)) throw new Error();
    const covers = new Map(state.series.map((s) => [s.id, s.covers]));
    state.series = d.series.map((s) => ({ ...s, covers: s.covers || covers.get(s.id) || undefined }));
    await persist(); render(); scheduleNotifications();
    $("backupDlg").close(); snack(`${state.series.length} série(s) restaurée(s)`);
  } catch { snack("Ce texte n'est pas une sauvegarde valide."); }
});

// ---------- Bouton retour Android ----------
App.addListener("backButton", () => {
  const open = [...document.querySelectorAll("dialog[open]")].pop();
  if (open) { open.close(); return; }
  if (state.searchOpen) { $("searchClose").click(); return; }
  if (state.detailId) { back(); return; }
  if (state.tab !== "shelf") { go("shelf"); return; }
  App.exitApp();
}).catch(() => {});
App.addListener("resume", () => { render(); }).catch(() => {});

// ---------- Démarrage ----------
render();
load().then(() => {
  render(); scheduleNotifications();
  const last = state.meta && state.meta.checkedAt ? new Date(state.meta.checkedAt) : null;
  if (Capacitor.isNativePlatform() && (!last || Date.now() - last > 3 * 86400000)) checkReleases({ silent: true });
});

// ---------- Remplissage automatique (catalogue BnF) ----------
$("bnfBtn").addEventListener("click", async () => {
  const title = $("f-title").value.trim(), note = $("bnfNote");
  if (title.length < 2) { note.textContent = "Tape d'abord le titre de la série."; note.hidden = false; return; }
  $("bnfBtn").disabled = true; note.hidden = false; note.textContent = "Recherche dans le catalogue de la BnF…"; $("bnfResults").innerHTML = "";
  try {
    const res = await bnfSearch(title);
    state.bnfResults = res;
    if (!res.length) { note.textContent = "Aucune série trouvée. Vérifie l'orthographe ou saisis les infos à la main."; return; }
    $("bnfResults").innerHTML = res.map((g, i) => `<button class="pick" type="button" data-i="${i}" role="listitem">${icon("menu_book")}<span><span class="li-t" style="display:block;white-space:normal">${esc(g.title)}</span><span class="li-s">${esc([g.author, g.publisher || "Éditeur inconnu"].filter(Boolean).join(" · "))} · ${g.count} tome${g.count > 1 ? "s" : ""} · dernier en ${g.lastYear || "?"}</span></span></button>`).join("");
    note.textContent = "Choisis la bonne série. Source : catalogue de la BnF (dépôt légal), qui peut avoir quelques semaines de retard sur les dernières sorties.";
  } catch { note.textContent = "Le catalogue de la BnF ne répond pas. Vérifie ta connexion."; }
  finally { $("bnfBtn").disabled = false; }
});
$("bnfResults").addEventListener("click", (e) => {
  const b = e.target.closest(".pick"); if (!b) return;
  const g = state.bnfResults[+b.dataset.i];
  state.bnfPick = g;
  $("f-title").value = g.title;
  if (g.publisher) $("f-publisher").value = g.publisher;
  if (g.author) $("f-author").value = g.author;
  if (g.artist) $("f-artist").value = g.artist;
  $("f-published").value = g.count;
  $("bnfResults").innerHTML = "";
  $("bnfNote").textContent = `${g.title} : ${g.count} tome${g.count > 1 ? "s" : ""} chez ${g.publisher || "un éditeur inconnu"}. Indique maintenant les tomes que tu possèdes.`;
  $("f-owned").focus();
});

// ---------- Import CSV : titre ; numéro du tome ; lien de couverture ; auteur ; dessinateur ----------
function parseCsv(text) {
  text = text.replace(/^﻿/, "");
  const first = text.split(/\r?\n/)[0] || "";
  const delim = [";", ",", "\t"].sort((a, b) => first.split(b).length - first.split(a).length)[0];
  const rows = []; let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.map((r) => r.map((x) => x.trim())).filter((r) => r.some(Boolean));
}
function csvRecords(rows) {
  const cols = { title: 0, vol: 1, cover: 2, author: 3, artist: 4 };
  const head = rows[0] ? rows[0].map(norm) : [];
  if (head.some((h) => /^(titre|title|serie|nom)/.test(h))) {
    const find = (re) => head.findIndex((h) => re.test(h));
    const idx = { title: find(/^(titre|title|serie|nom)/), vol: find(/(tome|numero|volume|vol)/), cover: find(/(image|couverture|cover|lien|url)/), author: find(/(auteur|scenar|author|writer)/), artist: find(/(dessin|illustr|artist)/) };
    for (const k in idx) if (idx[k] >= 0) cols[k] = idx[k]; else cols[k] = -1;
    rows = rows.slice(1);
  }
  const at = (r, k) => (cols[k] >= 0 ? (r[cols[k]] || "").trim() : "");
  return rows.map((r, i) => ({ line: i + 1, title: at(r, "title"), vol: parseInt(at(r, "vol").replace(/\D+/g, ""), 10) || 0, cover: at(r, "cover"), author: at(r, "author"), artist: at(r, "artist") })).filter((r) => r.title);
}
async function importCsv(text) {
  const status = (m) => { $("csvStatus").textContent = m; $("csvStatus").hidden = false; };
  const recs = csvRecords(parseCsv(text));
  if (!recs.length) { status("Aucune ligne exploitable : vérifie que la première colonne contient le titre."); return; }
  let created = 0, updated = new Set(), tomes = 0, coversOk = 0, coversKo = 0;
  const byKey = new Map(state.series.map((s) => [s.bnfKey || norm(s.title), s]));
  for (const s of state.series) byKey.set(norm(s.title), s);
  const work = new Map();
  for (const r of recs) {
    const key = norm(r.title);
    let s = work.get(key);
    if (!s) {
      const existing = byKey.get(key);
      s = existing ? clone(existing) : { id: (key.replace(/\s+/g, "-").slice(0, 60) || "serie") + "-" + Math.random().toString(36).slice(2, 6), title: r.title, publisher: "", status: "ongoing", published: 0, owned: [], next: null, pinned: false };
      if (!existing) created++;
      work.set(key, s);
    }
    if (r.author && !s.author) s.author = r.author;
    if (r.artist && !s.artist) s.artist = r.artist;
    if (r.vol) {
      const owned = new Set(s.owned || []);
      if (!owned.has(r.vol)) { owned.add(r.vol); tomes++; }
      s.owned = [...owned].sort((a, b) => a - b);
      s.published = Math.max(s.published || 0, r.vol);
      if (s.next && s.next.vol <= r.vol) { s.next = null; s.pinned = false; }
    }
    if (byKey.has(key)) updated.add(key);
  }
  const withCover = recs.filter((r) => r.vol && /^https?:\/\//i.test(r.cover));
  let n = 0;
  for (const r of withCover) {
    n++; status(`Couvertures : ${n} / ${withCover.length}…`);
    const s = work.get(norm(r.title));
    try { await storeCover(s, r.vol, await downloadImage(r.cover)); coversOk++; } catch { coversKo++; }
  }
  for (const s of work.values()) { s.updatedAt = new Date().toISOString(); const i = state.series.findIndex((x) => x.id === s.id); if (i >= 0) state.series[i] = s; else state.series.push(s); }
  await persist(); render(); scheduleNotifications();
  status(`Import terminé : ${recs.length} ligne(s), ${created} série(s) créée(s), ${updated.size} complétée(s), ${tomes} tome(s) ajouté(s)` + (withCover.length ? `, ${coversOk} couverture(s) récupérée(s)${coversKo ? `, ${coversKo} lien(s) en échec` : ""}` : "") + ".");

}
$("csvBtn").addEventListener("click", () => $("csvFile").click());
$("csvFile").addEventListener("change", async (e) => {
  const f = e.target.files && e.target.files[0]; e.target.value = "";
  if (!f) return;
  $("csvBtn").disabled = true;
  try {
    const buf = await f.arrayBuffer();
    let text = new TextDecoder("utf-8").decode(buf);
    if (text.includes("�")) text = new TextDecoder("windows-1252").decode(buf);
    await importCsv(text);
  } catch { $("csvStatus").textContent = "Impossible de lire ce fichier."; $("csvStatus").hidden = false; }
  finally { $("csvBtn").disabled = false; }
});
