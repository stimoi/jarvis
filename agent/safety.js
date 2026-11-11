import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Moteur de risque. La décision est prise ICI, sur l'ordinateur, et jamais déléguée au modèle.
 *   safe     -> jamais de question
 *   moderate -> demande seulement en mode "prudent"
 *   risky    -> demande en modes "prudent" et "équilibré" (défaut)
 *   danger   -> demande TOUJOURS (non désactivable)
 */
export const LEVEL = { safe: 0, moderate: 1, risky: 2, danger: 3 };
const NAMES = ['safe', 'moderate', 'risky', 'danger'];
const max = (a, b) => (LEVEL[a] >= LEVEL[b] ? a : b);
const res = (level, reason) => ({ level, reason });

export const AUTONOMY_THRESHOLD = { cautious: 1, balanced: 2, trusting: 3 };

export function needsApproval(level, autonomy = 'balanced') {
  if (level === 'danger') return true;
  return LEVEL[level] >= (AUTONOMY_THRESHOLD[autonomy] ?? 2);
}

// ---------------- Chemins ----------------
const norm = (p) => path.resolve(p).toLowerCase().replace(/[\\/]+$/, '');
const HOME = norm(os.homedir());
const SYSTEM_DIRS = [process.env.SystemRoot || 'C:\\Windows', process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramData]
  .filter(Boolean)
  .map(norm);
const inside = (p, dir) => p === dir || p.startsWith(`${dir}\\`);

const SENSITIVE_RE =
  /(\\\.ssh\\|\\\.aws\\|\\\.gnupg\\|\\\.kube\\|\\\.docker\\config|id_rsa|id_ed25519|\.kdbx?$|\.pem$|\.pfx$|\.ppk$|\\login data|\\cookies$|\\web data$|\\credentials\\|\\microsoft\\protect|wallet|\\\.env(\.|$)|\\ntds\.dit|\\config\\sam$|\\\.npmrc$|\\\.git-credentials|\\token|password|motdepasse)/i;

export function resolvePath(p) {
  const s = String(p ?? '').trim();
  if (!s || s === '~') return os.homedir();
  if (s.startsWith('~\\') || s.startsWith('~/')) return path.join(os.homedir(), s.slice(2));
  return path.resolve(os.homedir(), s);
}

export function assessPath(p, { write = false, destructive = false } = {}) {
  const abs = resolvePath(p);
  const n = norm(abs);
  const isRoot = path.parse(abs).root.toLowerCase().replace(/[\\/]+$/, '') === n;
  if (isRoot) return res('danger', `Racine de disque : ${abs}`);
  if (SYSTEM_DIRS.some((d) => inside(n, d))) return write || destructive ? res('danger', `Dossier système : ${abs}`) : res('moderate', 'Lecture système');
  if (SENSITIVE_RE.test(`\\${n}`)) return write || destructive ? res('danger', `Fichier sensible : ${abs}`) : res('risky', `Fichier potentiellement sensible : ${abs}`);
  if (n === HOME) return destructive ? res('danger', 'Dossier utilisateur entier') : res('safe', '');
  if (!write && !destructive) return res('safe', '');
  const exists = fs.existsSync(abs);
  if (destructive) return inside(n, HOME) ? res('risky', `Suppression : ${abs}`) : res('danger', `Suppression hors dossier utilisateur : ${abs}`);
  if (!inside(n, HOME)) return res('risky', `Écriture hors dossier utilisateur : ${abs}`);
  return exists ? res('risky', `Écrase un fichier existant : ${abs}`) : res('moderate', `Nouveau fichier : ${abs}`);
}

// ---------------- Commandes shell ----------------
const DANGER_PATTERNS = [
  [/\bformat(-volume)?\s+[^|;]*\b[a-z]:/i, 'Formatage de disque'],
  [/\b(diskpart|clear-disk|remove-partition|initialize-disk|bcdedit|bootrec)\b/i, 'Gestion des disques / démarrage'],
  [/\b(remove-item|ri|rm|del|erase|rd|rmdir)\b[^|;&]*(-recurse|-r\b|-rf\b|\s\/s\b|\s\/q\b)/i, 'Suppression récursive'],
  [/\b(remove-item|ri|rm|del|erase|rd|rmdir)\b[^|;&]*(\\windows|system32|program files|\bc:\\\s*$|\s\/\s*$)/i, 'Suppression de fichiers système'],
  [/\breg(\.exe)?\s+(delete|add|import|load|restore)\b/i, 'Modification du registre'],
  [/\b(remove|set|new)-itemproperty\b[^|;]*hk(lm|cu|ey)/i, 'Modification du registre'],
  [/\b(shutdown|stop-computer|restart-computer|logoff)\b/i, "Extinction / redémarrage"],
  [/\b(net\s+user|net\s+localgroup|new-localuser|add-localgroupmember|set-localuser)\b/i, 'Gestion des comptes'],
  [/\b(set-executionpolicy|set-mppreference|add-mppreference|disable-windowsoptionalfeature|netsh\s+advfirewall|set-netfirewall|disable-netfirewall)/i, 'Réglages de sécurité'],
  [/\b(vssadmin|wbadmin|cipher\s+\/w|wevtutil\s+cl|clear-eventlog|sdelete)\b/i, 'Destruction de sauvegardes / journaux'],
  [/\b(takeown|icacls|cacls)\b/i, 'Permissions'],
  [/\b(sc(\.exe)?\s+(delete|config|stop)|schtasks[^|;]*\/(create|delete|change)|register-scheduledtask|new-service|remove-service)/i, 'Services / tâches planifiées'],
  [/(iwr|invoke-webrequest|curl|wget|irm|invoke-restmethod|bitsadmin|certutil)[^|;]*\|\s*(iex|invoke-expression|powershell|cmd|sh|bash)/i, 'Téléchargement + exécution'],
  [/\b(iex|invoke-expression)\b/i, 'Exécution dynamique de code'],
  [/-enc(odedcommand)?\b|frombase64string/i, 'Commande encodée'],
  [/\b(taskkill|stop-process|kill)\b[^|;]*(\/f|-force)[^|;]*\b(csrss|winlogon|lsass|wininit|services|smss|system)\b/i, 'Processus système critique'],
  [/\b(mimikatz|procdump|sekurlsa|hashdump)\b/i, "Outil d'extraction d'identifiants"],
  [/(\bcmdkey\b|vaultcmd|get-credential|\.ssh\\|id_rsa|\\login data|\\cookies\b)/i, 'Accès aux identifiants'],
  [/\b(wmic)\b[^|;]*\b(delete|call)\b/i, 'WMIC modification'],
  [/\b(manage-bde|disable-bitlocker)\b/i, 'BitLocker'],
];

const SAFE_CMDS = new Set([
  'get-childitem', 'gci', 'dir', 'ls', 'get-location', 'pwd', 'cd', 'set-location', 'echo', 'write-output', 'write-host',
  'whoami', 'hostname', 'date', 'get-date', 'ver', 'tree', 'where', 'where.exe', 'findstr', 'select-string', 'sls',
  'where-object', 'select-object', 'select', 'sort-object', 'sort', 'measure-object', 'measure', 'format-table', 'ft',
  'format-list', 'fl', 'out-string', 'convertto-json', 'tasklist', 'ipconfig', 'systeminfo', 'netstat', 'ping', 'nslookup',
  'tracert', 'nvidia-smi', 'test-path', 'resolve-path', 'split-path', 'join-path', 'get-content', 'cat', 'type', 'gc',
  'get-process', 'get-service', 'get-computerinfo', 'get-volume', 'get-disk', 'get-psdrive', 'get-netipaddress', 'get-ciminstance',
  'get-wmiobject', 'get-item', 'get-itemproperty', 'get-command', 'get-help', 'get-host', 'get-uptime', 'get-timezone', 'get-clipboard',
  'get-startapps', 'get-package', 'get-hotfix', 'get-netadapter', 'get-nettcpconnection', 'get-childitemproperty', 'get-filehash', 'hostname.exe',
]);
const SAFE_VERSION_BINS = new Set(['node', 'npm', 'python', 'python3', 'py', 'git', 'dotnet', 'java', 'pip', 'go', 'cargo', 'rustc', 'pnpm', 'yarn', 'winget']);
const SAFE_GIT_SUB = new Set(['status', 'log', 'diff', 'branch', 'show', 'remote', 'rev-parse', 'describe', 'tag', 'blame', 'shortlog', 'ls-files']);

const ESCAPE_RE = /(`|\$\(|\{|\}|&\s*[\w'"$.\\]|>|<|\bstart-process\b|\binvoke-|\biex\b|\bsaps\b|\bstart\b|\bcall\b)/i;

function segmentSafe(seg) {
  const s = seg.trim();
  if (!s) return true;
  const first = s.match(/^[\s(]*([\w.\-?%]+)/)?.[1]?.toLowerCase();
  if (!first) return false;
  const rest = s.slice(s.toLowerCase().indexOf(first) + first.length).trim();
  if (SAFE_CMDS.has(first)) return true;
  if (SAFE_VERSION_BINS.has(first)) {
    const sub = rest.split(/\s+/)[0]?.toLowerCase() || '';
    if (/^(-v|--version|-version|version|--help|-h)$/.test(sub)) return true;
    if (first === 'git') return SAFE_GIT_SUB.has(sub);
    if (first === 'winget') return ['list', 'search', 'show'].includes(sub);
    if (first === 'npm' || first === 'pnpm' || first === 'yarn') return ['ls', 'list', 'outdated', 'view', 'root'].includes(sub);
    if (first === 'pip') return ['list', 'show', 'freeze'].includes(sub);
  }
  return false;
}

export function assessCommand(cmd) {
  const c = String(cmd || '');
  if (c.length > 8000) return res('risky', 'Script très long');
  for (const [re, why] of DANGER_PATTERNS) if (re.test(c)) return res('danger', why);
  // Redirection vers $null / nul autorisée
  const cleaned = c.replace(/\d?>\s*(\$null|nul)\b/gi, '').replace(/2>&1/g, '');
  if (!ESCAPE_RE.test(cleaned)) {
    const segs = cleaned.split(/\r?\n|;|&&|\|\||\|/);
    if (segs.every(segmentSafe)) {
      if (SENSITIVE_RE.test(`\\${c.toLowerCase()}`)) return res('risky', 'Chemin potentiellement sensible');
      return res('safe', '');
    }
  }
  if (/\b(winget|choco|scoop|pip|npm|msiexec)\b[^|;]*\b(install|add|uninstall|remove)\b/i.test(c)) return res('risky', 'Installation / désinstallation de logiciel');
  if (/\b(remove-item|del|erase|rm|rd|rmdir|move-item|set-content|out-file|new-item|copy-item|rename-item|clear-content)\b|>\s*\S/i.test(c)) return res('risky', 'Modification de fichiers');
  if (/\b(invoke-webrequest|iwr|curl|wget|invoke-restmethod|irm|start-bitstransfer|scp|ftp|nc|ncat)\b/i.test(c)) return res('risky', 'Accès réseau');
  return res('risky', 'Commande non reconnue comme inoffensive');
}

// ---------------- Autres outils ----------------
const PRIVATE_HOST_RE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0|\[?::1\]?|.*\.local$|.*\.internal$)/i;
const CRITICAL_PROCS = new Set(['csrss', 'winlogon', 'lsass', 'wininit', 'services', 'smss', 'system', 'svchost', 'dwm', 'explorer', 'msmpeng']);
const RISKY_COMBOS = [/^alt\+f4$/, /^win\+r$/, /^ctrl\+alt\+(del|delete)$/, /^ctrl\+shift\+esc$/, /^win\+x$/, /^win\+l$/];

export function assess(name, a = {}) {
  switch (name) {
    case 'run_command': return assessCommand(a.command);
    case 'read_file': case 'list_dir': case 'view_image': case 'search_files':
      return assessPath(a.path ?? a.root ?? '~');
    case 'write_file': return assessPath(a.path, { write: true });
    case 'make_dir': return max2(assessPath(a.path, { write: true }), 'moderate');
    case 'delete_path': {
      const r = assessPath(a.path, { destructive: true });
      return res(max(r.level, 'risky'), r.reason || `Suppression : ${a.path}`);
    }
    case 'move_path': case 'copy_path': {
      const s = assessPath(a.from, { write: name === 'move_path', destructive: name === 'move_path' });
      const d = assessPath(a.to, { write: true });
      return res(max(max(s.level, d.level), 'moderate'), s.reason || d.reason);
    }
    case 'open_path': return max2(assessPath(a.path), 'moderate');
    case 'open_app': return /[\\/]|\.(exe|bat|cmd|ps1|vbs|msi|lnk)$/i.test(a.name || '') ? res('risky', "Lancement d'un exécutable par chemin") : res('moderate', `Ouverture de ${a.name}`);
    case 'open_url': {
      try {
        const u = new URL(a.url);
        if (!/^https?:$/.test(u.protocol)) return res('risky', `Protocole ${u.protocol}`);
        return res('safe', '');
      } catch {
        return res('risky', 'URL invalide');
      }
    }
    case 'web_fetch': {
      try {
        const u = new URL(a.url);
        if (!/^https?:$/.test(u.protocol)) return res('risky', `Protocole ${u.protocol}`);
        if (PRIVATE_HOST_RE.test(u.hostname)) return res('risky', 'Adresse du réseau local');
        return res('safe', '');
      } catch {
        return res('risky', 'URL invalide');
      }
    }
    case 'web_search': case 'list_windows': case 'get_system_info': case 'list_processes':
    case 'set_volume': case 'media_control': case 'notify': case 'wait': case 'mouse_move': case 'tts':
      return res('safe', '');
    case 'mail_list': case 'mail_read': return res('moderate', 'Lecture de la boîte mail');
    case 'mail_summary': return res('safe', ''); // affichage du 2e écran de l'utilisateur (jamais appelable par le modèle : liste blanche côté hub)
    case 'mail_send': return res('risky', `Envoi d'un e-mail à ${a.to}`);
    case 'send_message': return res('risky', `Envoi d'un message ${a.channel}`);
    // Voix de JARVIS : réglage demandé par un clic sur le site ; téléchargement limité aux voix du catalogue (adresses fixes).
    case 'tts_voices': case 'tts_select': case 'tts_install':
      return res('safe', '');
    case 'screenshot': case 'clipboard_read': return res('moderate', 'Capture de données à l\'écran / presse-papiers');
    case 'clipboard_write': case 'focus_window': case 'mouse_scroll': return res('moderate', '');
    case 'mouse_click': return res('moderate', 'Clic souris');
    case 'keyboard_type': return res('moderate', 'Saisie clavier');
    case 'key_press': return RISKY_COMBOS.some((r) => r.test(String(a.keys).toLowerCase().replace(/\s/g, ''))) ? res('risky', `Raccourci sensible : ${a.keys}`) : res('moderate', '');
    case 'kill_process': {
      const t = String(a.target).toLowerCase().replace(/\.exe$/, '');
      return CRITICAL_PROCS.has(t) ? res('danger', `Processus système critique : ${a.target}`) : res('risky', `Arrêt du processus ${a.target}`);
    }
    case 'power':
      if (a.action === 'cancel') return res('safe', '');
      if (a.action === 'lock') return res('moderate', 'Verrouillage');
      return res(a.action === 'sleep' ? 'risky' : 'danger', `Alimentation : ${a.action}`);
    default: return res('risky', `Outil inconnu : ${name}`);
  }
}
const max2 = (r, floor) => res(max(r.level, floor), r.reason);

export const levelName = (n) => NAMES[n];

export function describe(name, a = {}) {
  switch (name) {
    case 'run_command': return `Exécuter (${a.shell || 'powershell'}) :\n${String(a.command).slice(0, 1200)}${a.purpose ? `\n— ${a.purpose}` : ''}`;
    case 'write_file': return `${a.append ? 'Ajouter à' : 'Écrire dans'} ${a.path} (${String(a.content || '').length} caractères)`;
    case 'delete_path': return `Mettre à la Corbeille : ${a.path}`;
    case 'move_path': return `Déplacer ${a.from} → ${a.to}`;
    case 'copy_path': return `Copier ${a.from} → ${a.to}`;
    case 'kill_process': return `Arrêter le processus : ${a.target}`;
    case 'power': return `Alimentation : ${a.action}`;
    case 'open_app': return `Ouvrir l'application : ${a.name}`;
    case 'mail_send': return `Envoyer un e-mail à ${a.to}\nObjet : ${String(a.subject).slice(0, 150)}\n\n${String(a.body).slice(0, 700)}`;
    case 'send_message': return `Envoyer sur ${a.channel} :\n${String(a.text).slice(0, 700)}`;
    case 'key_press': return `Raccourci clavier : ${a.keys}`;
    case 'keyboard_type': return `Taper : ${String(a.text).slice(0, 200)}`;
    default: return `${name}(${JSON.stringify(a).slice(0, 500)})`;
  }
}
