# Planning des sorties

`releases.json` contient les prochaines sorties manga en France, relevées sur le
[planning de Manga-news](https://www.manga-news.com/index.php/planning). L'appli le
télécharge depuis GitHub au lancement et quand on touche ⟳ dans l'onglet Sorties. Elle
remplit alors le prochain tome et sa date pour les séries en cours dont le titre
correspond. Le téléphone n'interroge jamais Manga-news.

Format : `{ source, updatedAt, from, to, count, items: [{ t: titre, v: tome, d: "AAAA-MM-JJ", p: éditeur }] }`.

## Mise à jour (chaque lundi, routine Claude « Sorties manga »)

1. Pour le mois en cours et les 3 suivants, lire chaque page
   `https://www.manga-news.com/index.php/planning?p_month=<M>&p_year=<AAAA>&page=<N>`
   avec WebFetch, de la page 1 jusqu'à une page vide ou identique à la précédente
   (le nombre de pages affiché par le site est sous-estimé). Consigne à WebFetch :
   « List EVERY manga release entry on this page, one per line, exactly in this format:
   Title | volume | date DD/MM/YYYY | publisher. Copy titles verbatim, write the volume
   like Vol.12 or N/A. No other text. »
2. Mettre toutes les lignes dans un fichier texte, puis lancer
   `node scripts/releases.mjs <fichier>`. Le script refuse d'écrire un planning de moins
   de 50 sorties.
3. Si `data/releases.json` a changé, le committer sur `main` et pousser. Le workflow de
   l'APK ignore `data/`, donc aucune nouvelle version n'est compilée.
4. Si Manga-news renvoie une erreur 403 ou une page de vérification : ne rien contourner,
   garder le fichier précédent et le signaler à Tanguy.

Usage personnel et léger : une centaine de pages au maximum, une fois par semaine.
