// The hosted relay: a Cloudflare Worker routing to one Durable Object per room.
//
// Same HTTP and socket protocol as node/server.js, and the same rules, because
// both wrap src/room.js. What the Durable Object adds is a home for each room
// that survives eviction: the presenter key and the room's state are kept in
// its storage, and sockets use the hibernation API so an idle room costs
// nothing while people keep their connections open.
//
//   POST /rooms               → 201 { room, presenterKey }   (body { room? } to pick the code)
//   GET  /rooms/<room>        → 200 { room } if it exists, else 404
//   GET  /rooms/<room>/socket   WebSocket
//
// A room is deleted a day after its last connection closes.
//
// Not deployed from this repo yet: deploying is Brad's call (see README).

import { isRoom } from '../../protocol/src/index.js';
import { createRelayRoom, generatePresenterKey, generateRoomCode } from '../src/room.js';

const IDLE_MS = 24 * 60 * 60 * 1000;
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...CORS } });

export default {
  /** @param {Request} request @param {{ ROOMS: DurableObjectNamespace }} env */
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (request.method === 'POST' && url.pathname === '/rooms') {
      let requested;
      try {
        const text = await request.text();
        if (text.length > 1024) return json(413, { error: 'body too large' });
        requested = text ? JSON.parse(text).room : undefined;
      } catch {
        return json(400, { error: 'body must be JSON' });
      }
      if (requested !== undefined && !isRoom(requested)) return json(400, { error: 'room must be 1–64 letters, digits or hyphens' });
      // A generated code that happens to exist already is simply retried.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const room = requested ?? generateRoomCode();
        const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
        const res = await stub.fetch('https://room/init', { method: 'POST', body: JSON.stringify({ room, presenterKey: generatePresenterKey() }) });
        if (res.status === 201) return json(201, await res.json());
        if (requested !== undefined) return json(409, { error: 'that room already exists' });
      }

      return json(503, { error: 'could not find a free room code; try again' });
    }

    const match = /^\/rooms\/([^/]+)(\/socket)?$/.exec(url.pathname);
    if (match && isRoom(match[1])) {
      const stub = env.ROOMS.get(env.ROOMS.idFromName(match[1]));
      if (match[2]) return stub.fetch(new Request('https://room/socket', request));
      const res = await stub.fetch('https://room/exists');

      return res.status === 200 ? json(200, { room: match[1] }) : json(404, { error: 'no such room' });
    }

    return json(404, { error: 'not found' });
  },
};

/** A socket that's already closing can throw on send; one bad peer must not stop the broadcast. */
function send(ws, text) {
  try {
    ws.send(text);
  } catch {
    // Its close handler will tidy up.
  }
}

export class TokenSyncRoom {
  /** @param {DurableObjectState} ctx */
  constructor(ctx) {
    this.ctx = ctx;
    /** @type {ReturnType<typeof createRelayRoom> | null} */
    this.core = null;
  }

  /** Rebuild the room core from storage — after creation, or after waking from hibernation. */
  async load() {
    if (this.core) return this.core;
    const [room, presenterKey, restore] = await Promise.all([
      this.ctx.storage.get('room'),
      this.ctx.storage.get('presenterKey'),
      this.ctx.storage.get('snapshot'),
    ]);
    if (!room || !presenterKey) return null;
    this.core = createRelayRoom({ room, presenterKey, restore: restore ?? [] });

    return this.core;
  }

  /** @param {Request} request */
  async fetch(request) {
    const { pathname } = new URL(request.url);

    if (pathname === '/init') {
      if (await this.ctx.storage.get('presenterKey')) return new Response('exists', { status: 409 });
      const { room, presenterKey } = await request.json();
      await this.ctx.storage.put({ room, presenterKey });
      await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);

      return new Response(JSON.stringify({ room, presenterKey }), { status: 201 });
    }

    const core = await this.load();
    if (!core) return new Response('no such room', { status: 404 });
    if (pathname === '/exists') return new Response('ok');

    if (pathname === '/socket') {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('expected a WebSocket', { status: 426 });
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment(core.connect());
      await this.ctx.storage.deleteAlarm();

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('not found', { status: 404 });
  }

  /** @param {WebSocket} ws @param {string | ArrayBuffer} message */
  async webSocketMessage(ws, message) {
    const core = await this.load();
    if (!core) return ws.close(4404, 'no such room');
    const client = ws.deserializeAttachment();
    const outbound = core.receive(client, typeof message === 'string' ? message : '');
    ws.serializeAttachment(client);
    let changed = false;
    for (const { to, frame } of outbound) {
      const text = JSON.stringify(frame);
      if (to === 'sender') send(ws, text);
      else {
        changed = true;
        for (const other of this.ctx.getWebSockets()) if (other.deserializeAttachment()?.ready) send(other, text);
      }
    }
    if (changed) await this.ctx.storage.put('snapshot', core.snapshot());
  }

  /** @param {WebSocket} ws @param {number} code @param {string} reason */
  async webSocketClose(ws, code, reason) {
    // 1005 ("no status") and 1006 ("abnormal") describe what happened; they
    // may not be sent back. Answer those with a normal close.
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // Already closed: nothing to answer.
    }
    // The alarm checks for open sockets before deleting anything.
    await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
  }

  /** A socket that ended in an error gets the same clean-up as one that closed. */
  async webSocketError(ws) {
    await this.webSocketClose(ws, 1011, 'error');
  }

  async alarm() {
    if (this.ctx.getWebSockets().length === 0) {
      await this.ctx.storage.deleteAll();
      this.core = null;
    }
  }
}
