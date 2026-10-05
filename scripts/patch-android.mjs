// Ajuste le projet Android généré par « cap add android » (le dossier android/ n'est pas versionné).
import { readFileSync, writeFileSync } from "node:fs";

const path = "android/app/src/main/AndroidManifest.xml";
let xml = readFileSync(path, "utf8");
// Lecteur de code-barres de Google (ML Kit) : téléchargé par les services Google Play au premier scan.
if (!xml.includes("com.google.mlkit.vision.DEPENDENCIES")) {
  xml = xml.replace(/(<application[^>]*>)/, `$1\n        <meta-data android:name="com.google.mlkit.vision.DEPENDENCIES" android:value="barcode_ui"/>`);
}
writeFileSync(path, xml);
console.log("AndroidManifest.xml ajusté");
