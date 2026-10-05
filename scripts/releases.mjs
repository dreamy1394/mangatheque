// Construit data/releases.json à partir des lignes « Titre | Vol.N | JJ/MM/AAAA | Éditeur » relevées sur le planning Manga-news.
// Usage : node scripts/releases.mjs lignes.txt
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const src = process.argv[2];
if (!src) { console.error("Usage : node scripts/releases.mjs lignes.txt"); process.exit(1); }
const seen = new Map(), items = [];
for (const line of readFileSync(src, "utf8").split(/\r?\n/)) {
  const parts = line.split("|").map((x) => x.trim());
  if (parts.length !== 4) continue;
  const [t0, vol, date, p] = parts;
  const t = t0.replace(/\s+(?:Vol\.?|T\.?|Tome)\s*\d+\s*$/i, "").trim(); // « Wait, I Love You Vol.2 » -> « Wait, I Love You »
  const v = (vol.match(/(\d+)/) || [])[1], d = date.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!t || !v || !d) continue; // artbooks et coffrets sans numéro : ignorés
  const it = { t, v: +v, d: `${d[3]}-${d[2]}-${d[1]}`, p };
  // Un même tome relevé à deux dates (pages qui se chevauchent) : on garde la plus tardive.
  const k = `${t.toLowerCase()}|${it.v}`, prev = seen.get(k);
  if (prev && prev.d >= it.d) continue;
  if (prev) items.splice(items.indexOf(prev), 1);
  seen.set(k, it); items.push(it);
}
items.sort((a, b) => a.d.localeCompare(b.d) || a.t.localeCompare(b.t, "fr"));
if (items.length < 50) { console.error(`Seulement ${items.length} sorties : planning incomplet, fichier non modifié.`); process.exit(2); }
const out = "data/releases.json";
const old = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null;
if (old && JSON.stringify(old.items) === JSON.stringify(items)) { console.log("Planning inchangé."); process.exit(0); }
writeFileSync(out, JSON.stringify({ source: "Manga-news (https://www.manga-news.com/index.php/planning)", updatedAt: new Date().toISOString(), from: items[0].d, to: items[items.length - 1].d, count: items.length, items }, null, 0) + "\n");
console.log(`${items.length} sorties écrites du ${items[0].d} au ${items[items.length - 1].d}.`);
