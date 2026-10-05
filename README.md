# Ma mangathèque (Android)

Application Android pour suivre sa collection de mangas : tomes possédés, tomes manquants, prochaines sorties et notifications le jour J.

## Installer sur le téléphone

1. Ouvre sur ton téléphone : <https://github.com/dreamy1394/mangatheque/releases/latest/download/mangatheque.apk>
2. Ouvre le fichier téléchargé. Android demande d'autoriser l'installation depuis le navigateur : accepte.
3. Pour mettre à jour, refais la même chose : la nouvelle version s'installe par-dessus et garde tes données.

## Fonctionnement

- Les données et couvertures sont enregistrées sur le téléphone (menu ⋮ de l'Étagère pour sauvegarder ou restaurer).
- « Compléter automatiquement » et la détection des nouveaux tomes parus s'appuient sur l'[API SRU du catalogue de la BnF](https://www.bnf.fr/fr/api-et-jeux-de-donnees) (titre, éditeur, auteur, dessinateur, nombre de tomes). Manga-news et Nautiljon bloquent les applis. Les dates à venir se saisissent à la main.
- Une sortie épinglée déclenche une notification à 9 h le jour de sa sortie.

## Import CSV

Menu ⋮ de l'Étagère > « Choisir un fichier CSV ». Une ligne par tome possédé : `titre ; numéro du tome ; lien de l'image de couverture ; auteur ; dessinateur` (virgule ou point-virgule, en-tête facultatif). Modèle : [`modele-import.csv`](modele-import.csv).

## Développement

```bash
npm install
npm run build          # génère www/app.js et la police d'icônes
npx cap add android    # une fois, nécessite le SDK Android
npx cap sync android && npx cap open android
```

Chaque push sur `main` compile l'APK via GitHub Actions (`.github/workflows/android.yml`) et le publie dans les Releases.

Le keystore de signature (`keystore/`) est versionné volontairement : appli perso installée hors Play Store, il garantit que chaque nouvelle version s'installe par-dessus la précédente. Ne pas réutiliser cette clé pour une appli publiée.
