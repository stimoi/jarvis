# J.A.R.V.I.S

Assistant vocal personnel : il **écoute « Jarvis »**, comprend la suite, puis **agit sur ton PC** (fichiers, applis, commandes, souris/clavier, captures d'écran, web…), depuis le PC **ou le téléphone**. Les actions risquées demandent ta validation. Voix masculine grave façon JARVIS, interface HUD.

**Site en ligne : <https://jarvis.avenox.fr>** — accueil/présentation, création de compte, téléchargement de l'appli, et `/chat` pour discuter.
**Téléchargement direct (Windows) : <https://jarvis.avenox.fr/download>** — redirige vers le dernier zip de la [Release GitHub](https://github.com/stimoi/jarvis/releases/latest).

```
 Téléphone / navigateur ──► jarvis.avenox.fr (Cloudflare Worker) ◄── Agent PC (appli de bureau)
   micro → VAD → « jarvis »      ├─ comptes (D1) · invitations           exécute les outils,
                                 ├─ Durable Object / utilisateur          décide du risque,
                                 │    hub WebSocket + cerveau LLM         voix Piper (grave)
                                 └─ Groq : Whisper (voix) + gpt-oss-120b (outils)
```

## Premiers pas

1. Ouvre <https://jarvis.avenox.fr/auth/> et **crée le compte administrateur** : le tout premier compte exige le *code d'installation* (secret Cloudflare `SETUP_CODE`, empêche qu'un inconnu prenne la place d'admin).
2. Installe l'**appli de bureau** sur le PC à piloter (section *Télécharger* du site, ou `npm run desktop` depuis ce dossier) : connecte-toi, le PC s'associe tout seul à ton compte. L'icône reste près de l'horloge, l'écoute continue même fenêtre fermée ; menu de l'icône : *suspendre le contrôle du PC*, *lancer au démarrage*, *quitter*.
3. Clique sur le **micro** et dis « *Jarvis, ouvre le bloc-notes* ».
4. D'autres personnes : **Réglages → Invitations → créer un code**, à leur donner pour s'inscrire (inscription fermée sans code). Chaque compte ne pilote que ses propres PC.

Téléphone : ouvre le site, connecte-toi, « Ajouter à l'écran d'accueil ». Le micro marche (HTTPS fourni par Cloudflare) tant que la page est ouverte et l'écran allumé.

## La voix

- **Entrée** : le navigateur détecte localement quand quelqu'un parle (VAD) et n'envoie que ces phrases à Whisper (Groq) ; le mot « jarvis » (et ses variantes de transcription) déclenche l'écoute. Mode conversation : 7 s pour enchaîner sans redire « Jarvis ». ⚠ En veille, chaque phrase captée est transcrite chez le fournisseur : coupe le micro pour la discrétion.
- **Sortie** : voix neuronale masculine **Piper** (`fr_FR-tom`) synthétisée *sur le PC* par l'agent, puis assombrie dans le navigateur (lecture à 0,86×, graves renforcés, réverbération discrète). Réglage « Profondeur de la voix » dans les Réglages. Sans Piper, repli sur la voix du navigateur la plus grave disponible.
- Piper est inclus dans l'archive de l'appli (`resources/piper`) ; en développement il est dans `data/piper` (nécessite le runtime Visual C++ x64).

## Écran à distance (voir et piloter le PC, pensé pour le téléphone)

Quand un PC est connecté, le bouton **🖥** du chat ouvre son écran **en direct**, en plein écran (et en paysage automatiquement sur téléphone).

**Affichage et taille de l'écran**
- **Zoom** : pincer pour zoomer (jusqu'à ×8), deux doigts pour déplacer la vue, boutons ＋ / － / ⤢ ; préréglages *Ajuster*, *Remplir*, ×2, ×3, ×4. La résolution reçue augmente toute seule quand on zoome (qualité *Auto*).
- **Plein écran + paysage** : le bouton ⛶ (automatique à l'ouverture sur téléphone, réglable). La barre du haut peut se replier (▴).
- Bord de la vue : en glissant le doigt près d'un bord d'une vue zoomée, elle défile toute seule. Un **ascenseur** à droite (ou à gauche en mode gaucher) fait défiler le PC.

**Souris — trois modes** (⚙ → Souris)
- **Direct** : toucher = clic à cet endroit ; glisser = cliquer-déposer ; appui long ou deux doigts = clic droit.
- **Viser** : le curseur suit le doigt (décalé au-dessus pour ne pas être caché) puis reste en place ; boutons *Clic*, *Double*, *Droit*, *Glisser* pour agir avec précision.
- **Pavé tactile** : comme un trackpad (déplacement relatif, vitesse réglable) ; toucher = clic, deux doigts = clic droit, appui long = glisser.

**Clavier — trois modes** (⌨ ou ⚙ → Clavier)
- **JARVIS** (défaut sur téléphone) : clavier AZERTY personnalisé, jamais celui du téléphone. Accents en appui long (é è ê ë à ù ç…), Maj / Maj verrouillée, Ctrl / Alt / Win collants, chiffres et symboles, **F1-F12**, flèches, Suppr, Début/Fin, PgHaut/PgBas, raccourcis (Copier, Coller, Couper, Tout, Annuler, Alt+Tab, Win+D…), répétition des touches, vibration. Touches petites / moyennes / grandes.
- **Téléphone** : le clavier du système, avec une barre de touches spéciales ; le champ est toujours re-sélectionné.
- **Masqué** : pour un clavier physique (Bluetooth ou PC).
- En paysage le clavier se superpose et se range tout seul après 5 s sans frappe (touche ⌨ flottante pour le rappeler).

**Réglages** : qualité (Auto / Fluide / Équilibré / Net), gaucher, verrouillage du zoom, orientation, tout est mémorisé.

Techniquement : l'agent PC lance un processus PowerShell persistant (`agent/rc-worker.ps1`) qui capture l'écran (JPEG binaire, curseur dessiné) et injecte les entrées (SendInput) ; les trames passent par le Durable Object en WebSocket binaire. La diffusion ne démarre que si quelqu'un regarde, et s'arrête 30 s après.

Garde-fous : même compte obligatoire · bloqué par l'interrupteur **PAUSE** · une notification Windows s'affiche sur le PC au début d'une session · chaque session est écrite dans `agent-audit.log` · désactivable avec `"remote": false` dans `agent.json`. ⚠ Contrairement aux ordres donnés à Jarvis, ce contrôle manuel n'est **pas** filtré par le moteur de risque : tu pilotes toi-même.
## Sécurité

Le niveau de risque est calculé **sur le PC par l'agent** (`agent/safety.js`), jamais par le modèle ni par le serveur ; la validation s'affiche sur tous tes appareils (le premier qui répond gagne).

| Niveau | Exemples | Comportement |
|---|---|---|
| `safe` | heure, lister un dossier, `git status`, ouvrir une URL web | automatique |
| `moderate` | ouvrir une appli, capture d'écran, clic, saisie, nouveau fichier | automatique (demande en mode *Prudent*) |
| `risky` | supprimer/écraser, installer, tuer un processus, commande inconnue, fichiers sensibles | **validation** (mode *Équilibré*, défaut) |
| `danger` | formatage, registre, `iex`/commande encodée, dossiers système, extinction | **validation toujours**, tactile uniquement |

Suppressions = Corbeille · contenu web/fichiers/presse-papiers = données, jamais des ordres · journal d'audit `agent-audit.log` · interrupteur d'urgence (menu de l'icône ou fichier `PAUSE`) · jetons WebSocket dans le sous-protocole (jamais dans l'URL) · mots de passe PBKDF2 · anti-force-brute sur la connexion · CSP stricte.

## Déploiement Cloudflare (déjà fait)

Worker `jarvis` (`wrangler.jsonc`) : API + Durable Object `UserHub` (SQLite) + interface statique (`web/`) + base D1 `jarvis` + domaine `jarvis.avenox.fr`.

```bash
npx wrangler login                    # une fois (compte Cloudflare)
npm run cf:deploy                     # publie le site / l'API
npx wrangler secret put AI_API_KEY    # clé Groq (ou xAI)  ·  JWT_SECRET  ·  SETUP_CODE
npm run package                       # construit l'appli de bureau -> downloads/JARVIS-windows-x64.zip
npm run publish:app                   # construit l'appli, la découpe en morceaux de 20 Mo (web/dl/) et redéploie : 100 % gratuit
```

> **Téléchargement de l'appli** : sans R2 (payant). Cloudflare limite les fichiers statiques à 25 Mo : l'archive est donc servie en morceaux de 20 Mo dans `web/dl/` ; le navigateur les télécharge, vérifie leur SHA-256 et réassemble le zip (`web/js/landing.js`).

Quotas gratuits Groq : repli automatique `gpt-oss-120b` → `gpt-oss-20b` → `qwen3.8-27b` (la liste réelle des modèles du compte est relue ; un modèle disparu est ignoré, un quota atteint met le modèle en pause jusqu'à l'heure de reprise annoncée, et l'erreur affichée dit combien de temps attendre), limite de 200 messages/h par compte, et l'appli limite elle-même les envois à Whisper en veille (≈ 14/min).

## Développement local

```bash
npm install
npm start                # serveur Node local + agent (http://localhost:8787, sans Cloudflare)
npm run desktop:local    # appli de bureau en mode local (npm run desktop = mode en ligne)
npm run cf:dev           # Worker en local (wrangler dev)
npm test                 # 18 tests e2e contre le serveur Node
npm run test:worker      # les mêmes contre le Worker local (Durable Object + D1)
npm run test:remote      # écran/souris/clavier à distance (vraies images, vrai clic ; -- --worker pour le Worker local)
npm run test:ai          # chaîne de modèles (quota, modèle disparu…) contre un faux fournisseur`nnpm run check            # test réel de ta clé : LLM + appel d'outil + Whisper + « jarvis »
```

Si ton routeur met en cache un DNS erroné pour `jarvis.avenox.fr` (après un nouveau déploiement), l'agent accepte `JARVIS_DNS=1.1.1.1`.

## Structure

```
cloud/     Worker Cloudflare : index.js (API, WebSocket → DO), hub.js (Durable Object : hub + cerveau), schema.sql (D1)
server/    Serveur Node équivalent pour le développement local (Express + SQLite)
agent/     Agent PC : 33 outils Windows, safety.js, stats, voix Piper (tts.js), audit
desktop/   Appli Electron (fenêtre + icône de zone de notification + agent), mode en ligne ou local
web/       Site : accueil, /auth, /chat (HUD, réacteur Arc), PWA ; js/wake.js = VAD + détection « jarvis »
shared/    Outils exposés au modèle, prompt, configuration IA, client Groq/xAI (communs Node & Worker)
scripts/   e2e.js, package.js, publish-app.js, live-check.js, make-icons.js
```

## Limites connues

- L'agent cible **Windows** (PowerShell, SendInput).
- Pas de notification push quand l'appli mobile est fermée (une validation en attente apparaît à la réouverture ; expire après 2 min).
- Pas de double authentification : mot de passe long conseillé.
- Les noms de modèles gratuits évoluent : `AI_CHAT_MODEL` / `AI_FALLBACK_MODELS` (variables du Worker) permettent d'ajuster.
