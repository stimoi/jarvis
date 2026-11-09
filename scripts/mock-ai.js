// Faux fournisseur IA compatible OpenAI/Groq, utilisé uniquement par les tests (scripts/e2e.js).
import http from 'node:http';

export function startMockAi(port) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    res.setHeader('Content-Type', 'application/json');

    if (req.url.endsWith('/audio/transcriptions')) {
      calls.push({ url: req.url, bytes: raw.length });
      return res.end(JSON.stringify({ text: 'Jarvis, quelle heure est-il ?' }));
    }
    if (req.url.endsWith('/chat/completions')) {
      const body = JSON.parse(raw.toString());
      calls.push({ url: req.url, model: body.model, tools: body.tools?.length, reasoning: body.reasoning_effort });
      if (body.model === 'quota-model') {
        res.statusCode = 429;
        return res.end(JSON.stringify({ error: { message: 'rate limit' } }));
      }
      const last = body.messages[body.messages.length - 1];
      const msg = (content, tool_calls) => res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content, tool_calls } }] }));
      const call = (name, args) => msg(null, [{ id: `call_${Math.random().toString(36).slice(2, 8)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }]);
      if (last.role === 'tool') return msg(`Résultat reçu : ${String(last.content).slice(0, 80)}`);
      const text = String(last.content);
      if (/systeme/i.test(text)) return call('get_system_info', {});
      if (/supprime (.+)/i.test(text)) return call('delete_path', { path: text.match(/supprime (.+)/i)[1].trim() });
      if (/danger/i.test(text)) return call('run_command', { command: 'Remove-Item -Recurse -Force C:\\Temp\\jarvis-e2e-nope', purpose: 'test' });
      if (/note/i.test(text)) return call('remember', { fact: 'aime le café' });
      return msg('Bonjour, je suis Jarvis.');
    }
    res.statusCode = 404;
    res.end('{}');
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, calls })));
}
