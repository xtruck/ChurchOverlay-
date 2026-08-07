# Audit round 7 — backend (server.js, main.js, wrappers de transcription)

Contexte : les rounds 1 à 6 (voir AUDIT.md, AUDIT-round4.md, AUDIT-round5.md,
et les correctifs "audit round 6" déjà présents dans le code sans document
associé) avaient déjà couvert la recherche de versets, le packaging Electron,
le chiffrement des secrets, le stockage des thèmes/config hors `app.asar`, et
plusieurs bugs de détection. Ce round part directement du problème signalé en
usage réel : **la connexion du tableau de bord reste bloquée sur
« Déconnecté — reconnexion en cours » sans jamais se rétablir**, et cherche
la cause côté backend plutôt que côté interface.

## 1. CRITIQUE — Le worker ne distinguait pas un port déjà occupé d'un vrai crash

`server.js` quitte immédiatement (`process.exit(1)`) si `httpServer.listen()`
échoue avec `EADDRINUSE` (port 3000 déjà pris par une autre instance de
l'app qui ne s'est pas fermée proprement, ou un `node server.js` lancé à la
main). C'est correct en soi — mais côté `main.js`, le handler `worker.on('exit')`
traitait cette sortie exactement comme n'importe quel crash aléatoire :
nouvelle tentative automatique après 500ms, sans savoir que la vraie cause
(le port) ne peut pas se libérer en 500ms. Résultat : 3 tentatives échouent
en ~1,5 seconde, le budget de crashes (`WORKER_MAX_CRASHES = 3` en 60s) est
épuisé quasi instantanément, le pipeline s'arrête pour de bon avec un message
générique (« Pipeline arrêté après 4 crashes rapprochés ») — et le tableau de
bord reste bloqué en reconnexion WebSocket perpétuelle sans que rien
n'indique que le vrai problème est _un autre processus qui occupe déjà le
port_.

**C'est très probablement la cause du problème persistant signalé.**

Correctif (`main.js`) :

- `lastAlertCode` / `lastAlertMessage` mémorisent la dernière alerte reçue du
  worker avant sa sortie.
- Quand la sortie suit une alerte `server-listen-error`, plus aucune
  tentative automatique n'est faite : le pipeline passe directement en
  erreur avec le message précis déjà connu, au lieu du message générique
  après épuisement du budget de crashes.
- Ce suivi est réinitialisé à chaque nouveau démarrage (`startServer()`) et
  à chaque passage en `running`, pour ne jamais faire porter à un crash sans
  rapport la responsabilité d'un ancien problème de port déjà résolu.

**Action recommandée côté utilisateur** en attendant de relancer l'app avec
ce correctif : `netstat -ano | findstr :3000` dans PowerShell pendant que
l'app est censée tourner. Si une ligne `LISTENING` apparaît alors que le
tableau de bord affiche déjà « Déconnecté », c'est un processus `node.exe`
zombie (ancienne instance de ChurchOverlay mal fermée) qu'il faut arrêter
via le Gestionnaire des tâches.

## 2. MOYEN — Fuite de requêtes HTTP en cas de timeout Groq/Deepgram

`groq-wrapper.transcribeWithFallback` fait courir Groq et Deepgram en
parallèle via `Promise.race` contre un timeout (5s par défaut). Mais
`Promise.race` n'annule jamais la requête perdante : le `fetch()` Groq (ou
Deepgram) continuait de tourner en arrière-plan indéfiniment après le
timeout, jusqu'à ce que le réseau réponde ou que le timeout TCP par défaut
du système expire (potentiellement plusieurs minutes). Sur un service de
plusieurs heures avec un réseau instable, chaque segment audio en timeout
laissait une connexion HTTP orpheline ouverte — accumulation progressive de
sockets non fermées.

Correctif : `transcribeFile` (Groq et Deepgram) accepte maintenant un
`AbortSignal` optionnel ; `transcribeWithFallback` crée un
`AbortController` par fournisseur et annule explicitement la requête perdante
dès qu'un timeout est atteint ou qu'un fournisseur répond le premier.

Fichiers modifiés : `groq-wrapper.js`, `deepgram-wrapper.js`.

## 3. MOYEN — L'arrêt « gracieux » du pipeline ne l'était jamais vraiment

`rate-limiter.js` démarre un `setInterval` de nettoyage (5 minutes) dès sa
création, sans jamais l'arrêter ni l'`unref()`. Résultat : après un message
`shutdown` envoyé par `main.js`, le worker fermait bien le serveur HTTP/WS
mais son boucle d'événements restait active à cause de ce timer — il ne
terminait donc jamais tout seul. `main.js` (`stopServerGracefully`) attendait
alors systématiquement les 5 secondes de son délai de sécurité avant de
forcer un `worker.terminate()`. Autrement dit : **chaque redémarrage du
pipeline (bouton « Redémarrer », changement de paramètres, fermeture de
l'app) coûtait 5 secondes inutiles et ne se terminait jamais par un arrêt
propre**, uniquement par un kill forcé.

Correctif :

- `connRateLimiter.stopCleanup()` est appelé dans le handler `shutdown` et
  dans le handler `SIGTERM` de `server.js`, suivi d'un `process.exit(0)`
  explicite (borné à 2s pour laisser `plugins.shutdown()` se terminer).
- `rate-limiter.js` : le timer de nettoyage est désormais `unref()`é par
  défaut, en filet de sécurité, même si un futur chemin de sortie oubliait
  d'appeler `stopCleanup()`.

Fichiers modifiés : `server.js`, `rate-limiter.js`.

## Vérifié, sans changement nécessaire

- `npm test` : 9 + 12 tests (validation, rate-limiter, config-validator,
  detector, intégration citation) — 100% OK avant et après, aucune
  régression.
- `node --check` sur tous les fichiers modifiés : aucune erreur de syntaxe.
- Le reste du pipeline (validation des messages WebSocket, limitation de
  débit par IP, cache API biblique, chiffrement des secrets via
  `safeStorage`, `contextIsolation`/`nodeIntegration` côté Electron) est
  resté conforme aux rounds précédents — aucune anomalie trouvée à la
  lecture.

## Non testé ici (nécessite Windows + matériel réel)

Comme pour les rounds précédents, la capture micro native
(`getUserMedia` → IPC → worker) et la connexion effective à Groq/Deepgram en
conditions réelles de culte n'ont pas pu être exercées de bout en bout dans
cet environnement Linux sans matériel. Le correctif n°1 (EADDRINUSE) cible
directement le symptôme observé en usage réel ; les correctifs n°2 et n°3
sont des durcissements de robustesse trouvés par lecture de code et
confirmés par la logique des modules concernés (pas de reproduction en
conditions réelles possible ici, mais aucune régression sur la suite de
tests existante).
