// Instance jetable pour tester l'interface sans clé ni compte réel : faux IA + base temporaire.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockAi } from './mock-ai.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ui-'));
await startMockAi(8899);
const env = { ...process.env, PORT: '8791', HOST: '127.0.0.1', JARVIS_DATA_DIR: tmp, JARVIS_AGENT_CONFIG: path.join(tmp, 'agent.json'), AI_API_KEY: 'gsk_test', AI_BASE_URL: 'http://127.0.0.1:8899', JWT_SECRET: 'ui' };
const server = spawn(process.execPath, [path.join(root, 'server/index.js')], { env, stdio: 'inherit' });
console.log('UI de test : http://127.0.0.1:8791 (données temporaires :', tmp, ')');
process.on('SIGTERM', () => { server.kill(); process.exit(0); });
process.on('SIGINT', () => { server.kill(); process.exit(0); });
