# ChurchOverlay — Plan de secours (à imprimer et garder au poste de régie)

Trois pannes possibles, et quoi faire dans chaque cas. Le mode manuel du
tableau de bord fonctionne **indépendamment** du micro et d'Internet — c'est
le filet de sécurité dans tous les cas ci-dessous.

---

## 🎤 Le micro ne capte plus / la détection automatique ne réagit plus

1. Ouvrir le tableau de bord (`dashboard.html`).
2. Cliquer sur **"Saisir Réf"** (au-dessus de l'affichage du verset).
3. Taper la référence (ex. "Jean 3:16") et valider — le verset s'affiche
   immédiatement sur l'overlay, comme s'il avait été détecté automatiquement.
4. Continuer ainsi manuellement pour le reste du culte.

Pas besoin d'attendre une réparation technique : le mode manuel a la même
sortie visuelle que la détection automatique.

## 🌐 Pas d'accès Internet

Sans Internet, Groq et Deepgram (transcription automatique) sont
inaccessibles — la détection automatique de versets ne fonctionnera pas.

1. Utiliser le mode manuel décrit ci-dessus (aucune connexion requise pour
   afficher un verset saisi à la main : la Bible est mise en cache
   localement après consultation, voir `bible-lookup-with-api.js`).
2. Si une référence n'a encore jamais été consultée sur cet ordinateur, elle
   peut ne pas être disponible hors-ligne — préparer si possible les
   passages prévus (lecture biblique du jour, etc.) avant le culte pendant
   qu'Internet est disponible, pour les mettre en cache.

## 🖥️ L'overlay ne s'affiche pas dans OBS

1. Vérifier que la source Navigateur (Browser Source) dans OBS pointe bien
   vers `http://127.0.0.1:8765` (ou l'URL configurée) et que "Actualiser le
   cache de navigateur au moment de l'activation de la scène" est coché.
2. Dans le tableau de bord, onglet **Aperçu Overlay**, cliquer sur
   **"Actualiser Iframe"** — si le verset apparaît là mais pas dans OBS, le
   problème vient d'OBS (source à recharger : clic droit sur la source →
   "Actualiser").
3. Si l'application ChurchOverlay elle-même semble bloquée (icône dans la
   barre système), utiliser le bouton **"Redémarrer"** du menu de l'icône —
   le pipeline redémarre automatiquement en cas de plantage, mais un
   redémarrage manuel force une remise à zéro immédiate si besoin.
4. Utiliser **"🛑 Arrêt d'Urgence"** dans le tableau de bord à tout moment
   pour masquer instantanément l'overlay (écran noir/transparent selon le
   thème), par exemple en cas d'affichage incorrect en plein culte.

---

_Avant chaque culte : bouton "✅ Tester avant le culte" dans le tableau de
bord, onglet Paramètres — vérifie la connexion et les clés Groq/Deepgram en
un clic (voir checklist mise en production, point 9)._
