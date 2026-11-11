import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { userFromToken, deviceFromToken } from './auth.js';
import { devices } from './db.js';
import { rcOpts, cleanAppState } from '../shared/rc.js';

const send = (ws, msg) => {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
};

/** Le jeton voyage dans l'en-tête Sec-WebSocket-Protocol : « jarvis.v1, <jeton> » (jamais dans l'URL). */
export function tokenFromProtocols(header) {
  const parts = String(header || '').split(',').map((s) => s.trim()).filter(Boolean);
  return parts.find((p) => p !== 'jarvis.v1') || '';
}

/**
 * Hub de routage : clients (PC/téléphone) <-> serveur <-> agents (PC pilotés).
 * Les validations de sécurité transitent ici : l'agent demande, n'importe quel client
 * authentifié du même compte répond.
 */
export class Hub {
  constructor() {
    this.users = new Map(); // userId -> { clients:Set, agents:Map<deviceId,{ws,info}> }
    this.calls = new Map(); // callId -> { resolve, reject, timer, userId, agentId }
    this.approvals = new Map(); // callId -> { userId, agentId, request }
    this.onChat = null;
    this.onCancel = null;
    this.busy = new Set();
  }

  u(userId) {
    if (!this.users.has(userId)) this.users.set(userId, { clients: new Set(), agents: new Map() });
    return this.users.get(userId);
  }

  agentsOf(userId) {
    return [...this.u(userId).agents.entries()].map(([id, a]) => ({ id, ...a.info }));
  }

  pendingApprovals(userId) {
    return [...this.approvals.values()].filter((a) => a.userId === userId).map((a) => a.request);
  }

  toUser(userId, msg) {
    for (const ws of this.u(userId).clients) send(ws, msg);
  }

  pushState(userId) {
    this.toUser(userId, { type: 'state', agents: this.agentsOf(userId), busy: this.busy.has(userId) });
  }

  setBusy(userId, busy) {
    busy ? this.busy.add(userId) : this.busy.delete(userId);
    this.pushState(userId);
  }

  // Les agents n'envoient leurs statistiques système que si quelqu'un les regarde.
  syncStatsSub(userId) {
    const u = this.u(userId);
    for (const a of u.agents.values()) send(a.ws, { type: 'stats_sub', on: u.clients.size > 0 });
  }

  callTool(userId, agentId, name, args, timeoutMs) {
    const agent = this.u(userId).agents.get(agentId);
    if (!agent) return Promise.reject(new Error("Le PC n'est pas connecté."));
    const callId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(callId);
        this.approvals.delete(callId);
        reject(new Error(`Délai dépassé pour l'outil ${name}.`));
      }, timeoutMs);
      this.calls.set(callId, { resolve, reject, timer, userId, agentId });
      send(agent.ws, { type: 'tool_call', callId, name, args });
    });
  }

  failAgentCalls(userId, agentId, reason) {
    for (const [id, c] of this.calls) {
      if (c.userId === userId && c.agentId === agentId) {
        clearTimeout(c.timer);
        this.calls.delete(id);
        c.reject(new Error(reason));
      }
    }
    for (const [id, a] of this.approvals) {
      if (a.userId === userId && a.agentId === agentId) {
        this.approvals.delete(id);
        this.toUser(userId, { type: 'approval_resolved', id, approved: false, reason: 'agent déconnecté' });
      }
    }
  }

  attach(server) {
    const wss = new WebSocketServer({
      server,
      path: '/ws',
      maxPayload: 32 * 1024 * 1024,
      handleProtocols: (protocols) => (protocols.has('jarvis.v1') ? 'jarvis.v1' : false),
    });
    wss.on('connection', (ws, req) => this.#connection(ws, req));
    setInterval(() => {
      for (const ws of wss.clients) {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
      }
    }, 25000).unref();
    return wss;
  }

  #connection(ws, req) {
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    ws.on('error', () => {});

    const token = tokenFromProtocols(req.headers['sec-websocket-protocol']);
    const ctx = this.#authenticate(ws, token);
    if (!ctx) {
      send(ws, { type: 'auth_error' });
      return ws.close(4003, 'unauthorized');
    }

    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        // Trame d'écran (octet 0x01 + JPEG) d'un agent -> uniquement les clients qui regardent cet agent.
        if (ctx.role === 'agent' && raw[0] === 1) {
          for (const c of this.u(ctx.userId).clients) if (c.rc === ctx.deviceId && c.readyState === 1) c.send(raw, { binary: true });
        }
        return;
      }
      const text = raw.toString();
      if (text === 'ping') return ws.send('pong');
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (ctx.role === 'agent') this.#fromAgent(ctx, msg, ws);
      else this.#fromClient(ctx, msg, ws);
    });

    ws.on('close', () => {
      const u = this.u(ctx.userId);
      if (ctx.role === 'client') {
        u.clients.delete(ws);
        this.syncStatsSub(ctx.userId);
        this.#rcSync(ctx.userId);
      } else if (u.agents.get(ctx.deviceId)?.ws === ws) {
        u.agents.delete(ctx.deviceId);
        this.failAgentCalls(ctx.userId, ctx.deviceId, "Le PC s'est déconnecté.");
        this.pushState(ctx.userId);
      }
    });
  }

  #authenticate(ws, token) {
    if (String(token).startsWith('jda_')) {
      const dev = deviceFromToken(token);
      if (!dev) return null;
      const u = this.u(dev.user_id);
      u.agents.get(dev.id)?.ws.close(4000, 'replaced');
      u.agents.set(dev.id, { ws, info: { name: dev.name, os: '', user: '', home: '', connectedAt: Date.now() } });
      devices.touch(dev.id);
      send(ws, { type: 'ready', deviceId: dev.id });
      send(ws, { type: 'stats_sub', on: u.clients.size > 0 });
      this.pushState(dev.user_id);
      this.#rcSync(dev.user_id);
      return { role: 'agent', userId: dev.user_id, deviceId: dev.id };
    }
    const user = userFromToken(token);
    if (!user) return null;
    const u = this.u(user.id);
    u.clients.add(ws);
    send(ws, { type: 'ready', user: { id: user.id, username: user.username } });
    send(ws, { type: 'state', agents: this.agentsOf(user.id), busy: this.busy.has(user.id) });
    for (const req of this.pendingApprovals(user.id)) send(ws, { type: 'approval_request', ...req });
    this.syncStatsSub(user.id);
    return { role: 'client', userId: user.id };
  }

  #fromAgent(ctx, msg) {
    const u = this.u(ctx.userId);
    if (msg.type === 'hello') {
      const a = u.agents.get(ctx.deviceId);
      if (a) {
        a.info = {
          ...a.info,
          name: String(msg.info?.name || a.info.name).slice(0, 60),
          os: String(msg.info?.os || '').slice(0, 80),
          user: String(msg.info?.user || '').slice(0, 60),
          home: String(msg.info?.home || '').slice(0, 200),
          tts: !!msg.info?.tts,
          appVersion: String(msg.info?.version || '').slice(0, 20),
          canUpdate: !!msg.info?.canUpdate,
        };
        this.pushState(ctx.userId);
      }
    } else if (msg.type === 'stats') {
      this.toUser(ctx.userId, { type: 'stats', agentId: ctx.deviceId, stats: msg.stats });
    } else if (msg.type === 'app_status') {
      this.toUser(ctx.userId, { type: 'app_status', agentId: ctx.deviceId, state: cleanAppState(msg.state) });
    } else if (msg.type === 'rc_error') {
      for (const c of u.clients) if (c.rc === ctx.deviceId) send(c, { type: 'rc_error', message: String(msg.message || '').slice(0, 200) });
    } else if (msg.type === 'tool_result') {
      const c = this.calls.get(msg.callId);
      if (!c || c.userId !== ctx.userId || c.agentId !== ctx.deviceId) return;
      clearTimeout(c.timer);
      this.calls.delete(msg.callId);
      this.approvals.delete(msg.callId);
      c.resolve(msg);
    } else if (msg.type === 'approval_request') {
      const c = this.calls.get(msg.callId);
      if (!c || c.userId !== ctx.userId) return;
      const request = {
        id: msg.callId,
        tool: String(msg.tool).slice(0, 60),
        level: msg.level === 'danger' ? 'danger' : 'risky',
        summary: String(msg.summary || '').slice(0, 1500),
        reason: String(msg.reason || '').slice(0, 400),
        agentName: u.agents.get(ctx.deviceId)?.info.name,
        expiresAt: Date.now() + 120000,
      };
      this.approvals.set(msg.callId, { userId: ctx.userId, agentId: ctx.deviceId, request });
      this.toUser(ctx.userId, { type: 'approval_request', ...request });
    } else if (msg.type === 'approval_cancelled') {
      if (this.approvals.delete(msg.callId)) this.toUser(ctx.userId, { type: 'approval_resolved', id: msg.callId, approved: false, reason: 'expiré' });
    }
  }

  #fromClient(ctx, msg, ws) {
    switch (msg.type) {
      case 'chat':
        if (typeof msg.text === 'string' && msg.text.trim()) this.onChat?.(ctx.userId, msg);
        break;
      case 'cancel':
        this.onCancel?.(ctx.userId);
        break;
      case 'approval': {
        const a = this.approvals.get(msg.id);
        if (!a || a.userId !== ctx.userId) return;
        this.approvals.delete(msg.id);
        const agent = this.u(ctx.userId).agents.get(a.agentId);
        if (agent) send(agent.ws, { type: 'approval_decision', callId: msg.id, approved: !!msg.approved });
        this.toUser(ctx.userId, { type: 'approval_resolved', id: msg.id, approved: !!msg.approved });
        break;
      }
      case 'app_cmd': { // mise à jour de l'appli de bureau demandée depuis le site/téléphone
        const a = this.u(ctx.userId).agents.get(msg.agentId);
        if (a) send(a.ws, { type: 'app_cmd', cmd: msg.cmd === 'update' ? 'update' : 'check' });
        break;
      }
      case 'rc_start': {
        if (!this.u(ctx.userId).agents.has(msg.agentId)) return send(ws, { type: 'rc_error', message: "Le PC n'est pas connecté." });
        ws.rc = msg.agentId;
        ws.rcOpts = rcOpts(msg.opts);
        send(ws, { type: 'rc_started', agentId: msg.agentId });
        this.#rcSync(ctx.userId);
        break;
      }
      case 'rc_stop':
        ws.rc = null;
        this.#rcSync(ctx.userId);
        break;
      case 'rc_input': {
        const a = ws.rc && this.u(ctx.userId).agents.get(ws.rc);
        if (a) send(a.ws, { type: 'rc_input', ev: msg.ev });
        break;
      }
      case 'ping':
        send(ws, { type: 'pong' });
        break;
    }
  }

  /** Dit à chaque agent s'il doit diffuser son écran (au moins un client le regarde). */
  #rcSync(userId) {
    const u = this.u(userId);
    for (const [id, a] of u.agents) {
      const viewers = [...u.clients].filter((c) => c.rc === id && c.readyState === 1);
      send(a.ws, { type: 'rc_sub', on: viewers.length > 0, opts: viewers[viewers.length - 1]?.rcOpts });
    }
  }
}
