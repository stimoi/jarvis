// Lance serveur + agent PC ensemble (et les relance s'ils plantent).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const procs = [];

function run(label, script) {
  const child = spawn(process.execPath, [path.join(root, script)], { cwd: root, stdio: 'inherit' });
  procs.push(child);
  child.on('exit', (code) => {
    if (stopping) return;
    console.log(`[${label}] arrêté (code ${code}), relance dans 2 s…`);
    setTimeout(() => run(label, script), 2000);
  });
}

let stopping = false;
const stop = () => {
  stopping = true;
  procs.forEach((p) => p.kill());
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

run('serveur', 'server/index.js');
setTimeout(() => run('agent', 'agent/index.js'), 1500);
