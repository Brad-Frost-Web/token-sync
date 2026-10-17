// The smallest WebSocket server that serves a browser: RFC 6455's opening
// handshake, masked text frames in, unmasked text frames out, ping/pong and
// close. No dependency.
//
// Deliberately refused, with a close code rather than a guess: fragmented
// messages and binary frames (1003 — browsers send small text messages
// whole), unmasked client frames, reserved bits, unknown opcodes and control
// frames over 125 bytes (1002), invalid UTF-8 (1007), and frames larger than
// `maxPayload` (1009).
//
// A connection that goes quiet is checked with a ping every `pingMs`; one
// that hasn't answered anything by the next ping is dropped. A half-closed
// connection (FIN without a close frame) is dropped at once.

import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa };

/** The Sec-WebSocket-Accept value for a client's key (RFC 6455 §4.2.2). */
export function acceptKey(key) {
  return createHash('sha1').update(key + GUID).digest('base64');
}

/** Encode one unmasked server frame. */
export function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  return Buffer.concat([header, payload]);
}

/**
 * Pull complete frames off the front of a buffer.
 * @returns {{ frames: { fin: boolean, opcode: number, masked: boolean, payload: Buffer }[], rest: Buffer, tooLarge: boolean }}
 */
export function decodeFrames(buffer, maxPayload) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (buffer.length - cursor < 2) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (buffer.length - cursor < 8) break;
      const big = buffer.readBigUInt64BE(cursor);
      if (big > BigInt(maxPayload)) return { frames, rest: Buffer.alloc(0), tooLarge: true };
      length = Number(big);
      cursor += 8;
    }
    if (length > maxPayload) return { frames, rest: Buffer.alloc(0), tooLarge: true };
    const maskBytes = masked ? 4 : 0;
    if (buffer.length - cursor < maskBytes + length) break;
    const mask = masked ? buffer.subarray(cursor, cursor + 4) : null;
    cursor += maskBytes;
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    frames.push({ fin: (first & 0x80) !== 0, rsv: (first & 0x70) !== 0, opcode: first & 0x0f, masked, payload });
    offset = cursor + length;
  }

  return { frames, rest: buffer.subarray(offset), tooLarge: false };
}

/**
 * Complete the handshake on an HTTP `upgrade` and hand back a tiny socket API.
 * Returns null (and answers 400) when the request is not a WebSocket upgrade.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:stream').Duplex} socket
 * @param {Buffer} head bytes that arrived with the upgrade request (a pipelined first frame)
 * @param {{ maxPayload?: number, pingMs?: number, onMessage: (text: string) => void, onClose: () => void }} handlers
 */
export function acceptWebSocket(req, socket, head, { maxPayload = 64 * 1024, pingMs = 30000, onMessage, onClose }) {
  const key = req.headers['sec-websocket-key'];
  if (req.headers.upgrade?.toLowerCase() !== 'websocket' || typeof key !== 'string') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');

    return null;
  }
  socket.write(
    ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${acceptKey(key)}`, '', ''].join('\r\n'),
  );

  let buffered = Buffer.alloc(0);
  let closed = false;
  let heard = true;
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  const ping = setInterval(() => {
    if (!heard) return socket.destroy();
    heard = false;
    socket.write(encodeFrame(OP.ping));
  }, pingMs);
  ping.unref?.();
  const close = (code = 1000, reason = '') => {
    if (closed) return;
    closed = true;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    socket.end(encodeFrame(OP.close, body));
  };

  const receive = (chunk) => {
    heard = true;
    buffered = Buffer.concat([buffered, chunk]);
    const { frames, rest, tooLarge } = decodeFrames(buffered, maxPayload);
    buffered = rest;
    for (const frame of frames) {
      if (closed) return;
      const control = frame.opcode >= 0x8;
      if (!frame.masked) return close(1002, 'client frames must be masked');
      if (frame.rsv) return close(1002, 'reserved bits must be zero');
      if (control && frame.payload.length > 125) return close(1002, 'control frames carry at most 125 bytes');
      if (!frame.fin || frame.opcode === OP.continuation) return close(1003, 'fragmented messages are not supported');
      if (frame.opcode === OP.text) {
        let text;
        try {
          text = utf8.decode(frame.payload);
        } catch {
          return close(1007, 'text frames must be UTF-8');
        }
        onMessage(text);
      } else if (frame.opcode === OP.ping) socket.write(encodeFrame(OP.pong, frame.payload));
      else if (frame.opcode === OP.close) close(1000);
      else if (frame.opcode === OP.binary) return close(1003, 'only text frames are supported');
      else if (frame.opcode !== OP.pong) return close(1002, 'unknown opcode');
    }
    if (tooLarge) close(1009, 'frame too large');
  };
  socket.on('data', receive);
  // FIN without a close frame (a killed tab, a dropped network): drop it now,
  // or the half-open socket would sit in its room forever.
  socket.on('end', () => socket.destroy());
  socket.on('close', () => {
    closed = true;
    clearInterval(ping);
    onClose();
  });
  // Deferred, so the caller has finished wiring up this connection before its first message arrives.
  if (head?.length) queueMicrotask(() => receive(head));

  return {
    send(text) {
      if (!closed) socket.write(encodeFrame(OP.text, Buffer.from(text, 'utf8')));
    },
    close,
  };
}
