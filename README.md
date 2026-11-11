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

- **Changer de voix** : Réglages → « Voix de JARVIS » (Tom par défaut ; Gilles, Pierre, Jessica, Siwis). Une voix se télécharge une fois (≈ 60-75 Mo, dépôt officiel `rhasspy/piper-voices`) par clic sur « Télécharger », puis se sélectionne. Aucune URL libre : seul le catalogue de `agent/tts.js` est accepté.

## IA de secours (quand Groq atteint sa limite)

Ordre d'essai, automatique : **Groq** (chaîne de modèles) → fournisseurs de secours dont une clé est enregistrée (**Mistral**, **Gemini**, **OpenRouter**, **Cerebras**) → **Cloudflare Workers AI** (aucune clé, quota gratuit quotidien du compte, `@cf/openai/gpt-oss-120b` puis `-20b`, Llama 4 Scout). La transcription vocale bascule aussi sur le Whisper de Workers AI.
Pour ajouter une clé de secours : Réglages → « IA de secours » (clé testée avant enregistrement, chiffrée AES-GCM dans D1), ou secret Cloudflare (`MISTRAL_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `CEREBRAS_API_KEY`). Les clés se créent sur les sites des fournisseurs (liens dans les Réglages) ; les quotas gratuits changent souvent.

## 2e écran, météo, emploi du temps, mails, messages

- **2e écran** : `https://jarvis.avenox.fr/dash/` (ou menu de l'icône → « Ouvrir le 2e écran » : plein écran sur le moniteur secondaire). Horloge, météo (Open-Meteo, sans clé), emploi du temps, boîte mail (non lus), état du PC, conversation + zone de saisie. Les mails sont lus sur ton PC à la demande : rien n'est stocké côté site.
- **Météo / emploi du temps** : Réglages → « Infos du quotidien » (admin) : ville, lien de calendrier **ICS** (Google Agenda « adresse secrète au format iCal », ENT, Pronote…) et/ou planning hebdomadaire saisi à la main (`lundi 08:00-09:30 Maths @ salle 12`). « Jarvis, qu'ai-je demain ? », « quel temps fait-il ? ».
- **Boîte mail** (appli de bureau → Réglages) : IMAP/SMTP avec **mot de passe d'application** ; identifiants chiffrés par Windows (DPAPI) sur le PC, jamais envoyés au site. Lire = niveau « modéré » ; **envoyer un mail demande toujours ta validation**. Le contenu des mails est traité comme une donnée, jamais comme une instruction.
- **Messages** : Telegram (bot) et Discord (webhook), même coffre chiffré, **validation obligatoire** à chaque envoi.

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
## Mises à jour à distance de l'appli de bureau

À partir de la **v0.4.0**, l'appli se met à jour toute seule : elle cherche une nouvelle version au démarrage puis toutes les 6 h, la télécharge (≈ 300 Ko), la vérifie, et propose **« Redémarrer maintenant »** (bannière en haut du chat, menu de l'icône, ou redémarrage automatique si tu coches l'option). Aucune réinstallation, aucun droit administrateur.

- **Depuis le téléphone / le site** : dans le panneau « PC connecté », la ligne *Appli* affiche la version installée ; si une version plus récente existe, le bouton **« Mettre à jour le PC »** lance le téléchargement et le redémarrage sur le PC (progression affichée en direct).
- **Réglages (⚙ → Appli de bureau)** et menu de l'icône : rechercher maintenant, téléchargement automatique, redémarrage automatique.
- **Sécurité** : le manifeste `update.json` est **signé (Ed25519)** avec une clé privée qui reste sur le PC du développeur (`data/update-key.pem`, jamais versionnée) ; la clé publique est dans l'appli (`desktop/boot.cjs`). L'archive est en plus vérifiée par SHA-256. Un site ou un compte GitHub piraté ne peut donc pas faire exécuter de code chez les utilisateurs. Les versions plus anciennes sont refusées.
- **Filet de sécurité** : une version qui plante au chargement est supprimée et l'appli repart aussitôt sur la précédente (et n'est plus reproposée) ; une version jamais « confirmée » après 3 lancements est abandonnée.
- **Réinstallation nécessaire** seulement quand le moteur (Electron) change : l'appli le signale (« version majeure ») et ouvre la page de téléchargement.
- **Les applis installées avant la v0.4.0** ne savent pas se mettre à jour : à réinstaller une fois depuis `/download`.

Publier une version : monter `version` dans `package.json`, puis `npm run publish:app` (reconstruit l'appli, signe la mise à jour, crée la Release GitHub avec `JARVIS-windows-x64.zip` + `JARVIS-update-X.Y.Z.zip` + `update.json`, met à jour `jarvis.avenox.fr/update.json`). ⚠ **Sauvegarde `data/update-key.pem`** : sans elle, les applis déjà installées ne pourraient plus être mises à jour. Une version corrigée doit avoir un numéro supérieur à celle annulée.
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
npm run test:update      # module de mise à jour (signature, SHA-256, rétrogradation, archive incomplète…)
node scripts/e2e-update.js  # mise à jour réelle sur l'appli empaquetée (nécessite npm run package)
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
- Boîte mail : testée contre de faux serveurs IMAP/SMTP, pas contre une vraie boîte. Outlook/Hotmail personnels imposent parfois OAuth (mot de passe d'application refusé).
- Pas de jeu vidéo automatisé (Fortnite…) : trop lent via une IA de chat et contraire aux règles anti-triche.
- Les noms de modèles gratuits évoluent : `AI_CHAT_MODEL` / `AI_FALLBACK_MODELS` (variables du Worker) permettent d'ajuster.
