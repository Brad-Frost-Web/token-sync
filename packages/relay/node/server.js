// The Node reference relay — run your own room server with no dependencies:
//
//   node packages/relay/node/server.js [--port 8787] [--host 127.0.0.1]
//
// Same protocol and rules as the Cloudflare relay; both wrap src/room.js.
//
//   POST /rooms               → 201 { room, presenterKey }   (body { room? } to pick the code)
//   GET  /rooms/<room>        → 200 { room } if it exists, else 404
//   GET  /rooms/<room>/socket   WebSocket: say { kind: 'hello', key? }, then send { kind: 'msg', msg }
//
// Rooms live in memory and are dropped an hour after their last connection
// leaves. Binds 127.0.0.1 unless told otherwise.

import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { isRoom } from '../../protocol/src/index.js';
import { createRelayRoom, generatePresenterKey, generateRoomCode } from '../src/room.js';
import { acceptWebSocket } from './websocket.js';

const IDLE_MS = 60 * 60 * 1000;

/**
 * @param {{ idleMs?: number, helloMs?: number, maxBodyBytes?: number, allowOrigin?: string }} [options]
 *   `allowOrigin`: the CORS origin allowed to create rooms (default `*`: rooms
 *   are anonymous and keys are only ever returned to whoever created the room).
 */
export function createRelayServer({ idleMs = IDLE_MS, helloMs = 10000, maxBodyBytes = 1024, allowOrigin = '*' } = {}) {
  /** @type {Map<string, { core: ReturnType<typeof createRelayRoom>, sockets: Set<{ send(t: string): void, client: object }>, idle?: NodeJS.Timeout }>} */
  const rooms = new Map();
  const cors = { 'access-control-allow-origin': allowOrigin, 'access-control-allow-headers': 'content-type' };
  const json = (res, status, body) => res.writeHead(status, { 'content-type': 'application/json', ...cors }).end(JSON.stringify(body));

  function createRoom(requested) {
    let room = requested;
    if (room === undefined) {
      do room = generateRoomCode();
      while (rooms.has(room));
    }
    if (!isRoom(room)) return { status: 400, body: { error: 'room must be 1–64 letters, digits or hyphens' } };
    if (rooms.has(room)) return { status: 409, body: { error: 'that room already exists' } };
    const presenterKey = generatePresenterKey();
    const entry = { core: createRelayRoom({ room, presenterKey }), sockets: new Set() };
    rooms.set(room, entry);
    entry.idle = setTimeout(() => rooms.delete(room), idleMs).unref();

    return { status: 201, body: { room, presenterKey } };
  }

  const server = createServer((req, res) => {
    const { pathname } = new URL(req.url ?? '/', 'http://relay');
    if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
    if (req.method === 'POST' && pathname === '/rooms') {
      let body = '';
      let tooLarge = false;
      req.on('data', (chunk) => {
        if (tooLarge) return;
        body += chunk;
        if (body.length > maxBodyBytes) {
          tooLarge = true;
          json(res, 413, { error: 'body too large' });
        }
      });
      req.on('end', () => {
        if (tooLarge) return;
        let requested;
        try {
          requested = body ? JSON.parse(body).room : undefined;
        } catch {
          return json(res, 400, { error: 'body must be JSON' });
        }
        const { status, body: out } = createRoom(requested);
        json(res, status, out);
      });

      return;
    }
    const match = /^\/rooms\/([^/]+)$/.exec(pathname);
    if (req.method === 'GET' && match) {
      return rooms.has(match[1]) ? json(res, 200, { room: match[1] }) : json(res, 404, { error: 'no such room' });
    }
    json(res, 404, { error: 'not found' });
  });

  const connections = new Set();
  server.on('upgrade', (req, socket, head) => {
    // First thing: an error on a socket nobody listens to would crash the
    // process (the HTTP server drops its own listener on upgrade).
    socket.on('error', () => socket.destroy());
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    const { pathname } = new URL(req.url ?? '/', 'http://relay');
    const match = /^\/rooms\/([^/]+)\/socket$/.exec(pathname);
    const entry = match && rooms.get(match[1]);
    if (!entry) {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');

      return;
    }
    const client = entry.core.connect();
    const peer = acceptWebSocket(req, socket, head, {
      onMessage(text) {
        for (const { to, frame } of entry.core.receive(client, text)) {
          const out = JSON.stringify(frame);
          if (to === 'sender') peer.send(out);
          else for (const other of entry.sockets) if (other.client.ready) other.send(out);
        }
      },
      onClose() {
        entry.sockets.delete(member);
        if (entry.sockets.size === 0) entry.idle = setTimeout(() => rooms.delete(match[1]), idleMs).unref();
      },
    });
    if (!peer) return;
    clearTimeout(entry.idle);
    const member = { send: peer.send, client, drop: () => socket.destroy() };
    entry.sockets.add(member);
    // A connection that never says hello is dropped.
    setTimeout(() => client.ready || socket.destroy(), helloMs).unref();
  });

  /** Stop listening and drop every open socket. */
  function close() {
    for (const socket of connections) socket.destroy();
    for (const entry of rooms.values()) clearTimeout(entry.idle);
    server.close();
  }

  return { server, rooms, createRoom, close };
}

// Run directly: start listening.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);

    return i > -1 ? process.argv[i + 1] : fallback;
  };
  const port = Number(arg('port', process.env.PORT ?? 8787));
  const host = arg('host', '127.0.0.1');
  const { server } = createRelayServer();
  server.listen(port, host, async () => {
    console.log(`Token Sync relay: http://${host}:${port}  (ws://${host}:${port}/rooms/<room>/socket)`);
    if (host !== '0.0.0.0') return;
    // Bound to every interface: say which address a phone on the same wifi should use.
    const { networkInterfaces } = await import('node:os');
    const lan = Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal);
    for (const { address } of lan) console.log(`  on your local network: http://${address}:${port}`);
  });
}
