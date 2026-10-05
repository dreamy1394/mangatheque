// Construit www/ : bundle JS + police d'icônes embarquée (l'appli marche hors ligne).
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("www/fonts", { recursive: true });
copyFileSync("node_modules/material-symbols/material-symbols-rounded.woff2", "www/fonts/material-symbols-rounded.woff2");
await build({ entryPoints: ["src/app.js"], bundle: true, format: "iife", target: "es2020", outfile: "www/app.js", minify: true });
console.log("www/ prêt");
