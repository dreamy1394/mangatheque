// Ma mangathèque : application Android (Capacitor). Données et couvertures stockées sur le téléphone.
import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import { Filesystem, Directory } from "@capacitor/filesystem";
import { LocalNotifications } from "@capacitor/local-notifications";
import { App } from "@capacitor/app";

const $ = (id) => document.getElementById(id);
const MN = "https://www.manga-news.com";
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
const slugFromUrl = (u) => { const m = String(u || "").match(/manga-news\.com\/index\.php\/(?:serie|manga)\/([^/?#]+)/i); return m ? decodeURIComponent(m[1]) : null; };

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
    const r = await CapacitorHttp.get({ url, responseType: "blob", headers: { "User-Agent": UA, Referer: MN + "/" } });
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

// ---------- Sorties Manga-news ----------
// Lit le planning mensuel : chaque tome est un lien /index.php/manga/<slug>/vol-<n> titré « manga <Titre> Vol.<n> », suivi de « Sortie le JJ/MM/AAAA ».
function parsePlanning(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const byHref = new Map();
  for (const a of doc.querySelectorAll('a[href*="/index.php/manga/"]')) {
    const href = a.getAttribute("href") || "";
    const hm = href.match(/\/index\.php\/manga\/([^/?#]+)\/vol-(\d+)/);
    if (!hm) continue;
    const e = byHref.get(hm[0]) || { slug: decodeURIComponent(hm[1]), vol: +hm[2], title: null, date: null, img: null };
    const tm = (a.getAttribute("title") || "").match(/^manga\s+(.+?)\s+Vol\.\s*\d+\s*$/i);
    if (tm) e.title = tm[1];
    const img = a.querySelector("img");
    if (img) {
      const src = img.getAttribute("data-src") || img.getAttribute("data-original") || img.getAttribute("src") || "";
      if (/\/public\/images\/vols\//.test(src)) e.img = new URL(src, MN).href;
    }
    let el = a.parentElement;
    for (let k = 0; k < 3 && el && !e.date; k++, el = el.parentElement) {
      const dm = (el.textContent || "").match(/Sortie le (\d{2})\/(\d{2})\/(\d{4})/);
      if (dm && el.querySelectorAll('a[href*="/vol-"]').length <= 4) e.date = `${dm[3]}-${dm[2]}-${dm[1]}`;
    }
    byHref.set(hm[0], e);
  }
  return [...byHref.values()].filter((e) => e.title || e.date);
}
async function checkReleases({ silent } = {}) {
  if (state.checking) return;
  state.checking = true; render();
  const now = new Date(), entries = [];
  let failures = 0;
  for (let k = 0; k < 3; k++) {
    const d = new Date(now.getFullYear(), now.getMonth() + k, 1);
    try { entries.push(...parsePlanning(await getText(`${MN}/index.php/planning?p_year=${d.getFullYear()}&p_month=${d.getMonth() + 1}&p_editor=`))); }
    catch { failures++; }
  }
  if (failures === 3) { state.checking = false; render(); if (!silent) snack("Manga-news ne répond pas. Vérifie ta connexion et réessaie."); return; }
  let changes = 0, covers = 0;
  for (const orig of state.series) {
    const s = clone(orig), key = norm(s.title);
    const mine = entries.filter((e) => (s.mnSlug && e.slug === s.mnSlug) || (e.title && norm(e.title) === key));
    if (!mine.length) continue;
    let touched = false;
    if (!s.mnSlug) { s.mnSlug = mine[0].slug; touched = true; }
    const top = Math.max(s.published || 0, ...(s.owned || []), 0);
    for (const e of mine) if (e.date && daysUntil(e.date) <= 0 && e.vol > (s.published || 0)) { s.published = e.vol; touched = true; }
    const future = mine.filter((e) => e.date && daysUntil(e.date) > 0 && e.vol > top).sort((a, b) => a.vol - b.vol)[0];
    if (future && (!s.next || s.next.vol !== future.vol || s.next.date !== future.date)) {
      if (!s.next || s.next.vol !== future.vol) s.pinned = false;
      s.next = { vol: future.vol, date: future.date, source: "Manga-news" }; touched = true; changes++;
    }
    for (const e of mine) {
      if (e.img && !(s.covers || {})[e.vol] && covers < 30) {
        try { await storeCover(s, e.vol, await downloadImage(e.img)); covers++; touched = true; } catch {}
      }
    }
    if (touched) { s.updatedAt = new Date().toISOString(); state.series[state.series.findIndex((x) => x.id === s.id)] = s; }
  }
  state.meta = { ...state.meta, checkedAt: new Date().toISOString(), source: "Manga-news" };
  await persist();
  state.checking = false; render(); scheduleNotifications();
  if (!silent || changes) snack(changes ? `${changes} sortie${changes > 1 ? "s" : ""} mise${changes > 1 ? "s" : ""} à jour${covers ? `, ${covers} couverture(s)` : ""}` : `Aucune nouvelle sortie${covers ? `, ${covers} couverture(s) ajoutée(s)` : ""}`);
}
// Couvertures des tomes possédés depuis les fiches Manga-news (meilleur effort).
async function fetchSeriesCovers(s0) {
  const s = clone(s0);
  if (!s.mnSlug) { snack("Ajoute le lien Manga-news de la série (Modifier) ou lance une vérification des sorties."); return; }
  const v = view(s), todo = [];
  for (let i = 1; i <= v.total; i++) if (!(s.covers || {})[i]) todo.push(i);
  if (!todo.length) { snack("Toutes les couvertures sont déjà là."); return; }
  snack(`Recherche de ${Math.min(todo.length, 20)} couverture(s)…`);
  let n = 0;
  for (const vol of todo.slice(0, 20)) {
    try {
      const html = await getText(`${MN}/index.php/manga/${encodeURIComponent(s.mnSlug)}/vol-${vol}`);
      const doc = new DOMParser().parseFromString(html, "text/html");
      const srcs = [...doc.querySelectorAll("img")].map((i) => i.getAttribute("data-src") || i.getAttribute("src") || "").filter((x) => /\/public\/images\/vols\//.test(x));
      const best = srcs.find((x) => !/_(small|medium)\./.test(x)) || srcs[0];
      if (best) { await storeCover(s, vol, await downloadImage(new URL(best, MN).href)); n++; }
    } catch {}
  }
  await upsert(s, n ? `${n} couverture(s) ajoutée(s)` : "Aucune couverture trouvée sur Manga-news.");
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
      <div class="s-sub">${esc([s.publisher, statusLabel(s.status)].filter(Boolean).join(" · "))}${s.example ? " · exemple" : ""}</div>
      <div class="progress" aria-hidden="true"><span style="width:${pct}%"></span></div>
      <div class="s-foot"><span class="num">${v.owned.size} / ${v.published}</span>${tag}${nextTag}</div>
    </div>
    <button class="icon-btn tonal" type="button" data-act="plus" data-id="${esc(s.id)}" aria-label="J'ai acheté le tome ${nextToBuy(s)} de ${esc(s.title)}">${icon("add")}</button>
  </div>`;
}
function matches(v) {
  if (state.q && !(`${v.s.title} ${v.s.publisher || ""}`).toLowerCase().includes(state.q)) return false;
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
  let html = `<div class="info">${icon(state.checking ? "hourglass_top" : "sync")}<span>${state.checking ? "Vérification sur Manga-news…" : m && m.checkedAt ? `Sorties vérifiées le ${new Date(m.checkedAt).toLocaleDateString("fr-FR", { day: "numeric", month: "long" })} sur Manga-news. Touche ⟳ en haut pour revérifier.` : "Touche ⟳ en haut pour récupérer les dates sur Manga-news."}</span></div>`;
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
function detailView() {
  const s = find(state.detailId);
  if (!s) return `<div class="empty">${icon("search_off")}<span>Cette série n'existe plus.</span></div>`;
  const v = view(s), covers = s.covers || {};
  let html = `<div class="hero">${cvHtml(v, "hero-cv")}<div class="hero-txt">
    <span class="tag">${esc(statusLabel(s.status))}</span>
    <h2>${esc(s.title)}</h2>
    <span class="s-sub">${esc(s.publisher || "Éditeur non renseigné")}${s.example ? " · exemple" : ""}</span></div></div>
    <div class="stats"><div><b class="num">${v.owned.size}</b><span>possédés</span></div><div><b class="num">${v.published}</b><span>parus</span></div><div><b class="num" style="${v.missing.length ? "color:var(--error)" : ""}">${v.missing.length}</b><span>manquants</span></div></div>`;
  if (v.upcoming) html += `<div class="next-card">${icon("event_upcoming")}<div class="grow"><div style="font-weight:500">Tome ${v.upcoming.vol}</div><div style="font-size:13px">${v.upcoming.date ? fmtDate(v.upcoming.date, { weekday: "long", day: "numeric", month: "long" }) : "Date non annoncée"}</div></div>
    <button class="icon-btn" type="button" data-act="pin" data-id="${esc(s.id)}" aria-pressed="${!!s.pinned}" aria-label="${s.pinned ? "Désépingler" : "Épingler et me prévenir"}">${icon("push_pin", s.pinned)}</button></div>`;
  html += `<div class="actions"><button class="btn filled" type="button" data-act="plus" data-id="${esc(s.id)}">${icon("add")}J'ai le tome ${nextToBuy(s)}</button><button class="btn outlined" type="button" data-act="covers" data-id="${esc(s.id)}">${icon("photo_library")}Couvertures</button></div>`;
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
  if (act === "covers") fetchSeriesCovers(s);
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
  $("f-status").value = s ? s.status || "ongoing" : "ongoing";
  $("f-published").value = s ? s.published || "" : "";
  $("f-owned").value = s ? formatOwned(s.owned || []) : "";
  $("f-nextvol").value = s && s.next ? s.next.vol || "" : "";
  $("f-nextdate").value = s && s.next ? s.next.date || "" : "";
  $("f-mn").value = s && s.mnSlug ? `${MN}/index.php/serie/${s.mnSlug}` : "";
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
  const mnRaw = $("f-mn").value.trim(), mnSlug = mnRaw ? slugFromUrl(mnRaw) : null;
  if (mnRaw && !mnSlug) return err("Le lien Manga-news doit ressembler à https://www.manga-news.com/index.php/serie/…");
  const prev = state.editing ? find(state.editing) : null;
  const s = {
    ...(prev ? clone(prev) : {}),
    id: prev ? prev.id : (title.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "serie") + "-" + Math.random().toString(36).slice(2, 6),
    title, publisher: $("f-publisher").value.trim(), status: $("f-status").value, published, owned,
    next: nextVol ? { vol: nextVol, date: nextDate || null, source: prev && prev.next && prev.next.vol === nextVol && prev.next.date === (nextDate || null) ? prev.next.source || null : "saisie" } : null,
    pinned: $("f-pinned").checked && !!nextVol,
  };
  if (mnSlug) s.mnSlug = mnSlug; else delete s.mnSlug;
  if (prev) delete s.example;
  if (s.pinned) await askNotifications();
  if (await upsert(s, prev ? "Série mise à jour" : `${title} ajoutée`)) { $("formDlg").close(); if (!prev) openDetail(s.id); }
});

// ---------- Sauvegarde ----------
$("menuBtn").addEventListener("click", () => {
  const data = state.series.map((s) => { const c = clone(s); delete c.covers; return c; });
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
