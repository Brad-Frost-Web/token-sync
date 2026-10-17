// The token-sync/1 wire message (FEATURE-SPEC §6, eddie-design-system#2447).
//
//   { v, room, op, props, scope, from, ts }
//
// One message per change, JSON. `ts` is assigned by the relay (or the local
// channel standing in for one), never trusted from a client clock.

import { checkSafety } from './values.js';

export const PROTOCOL_VERSION = 1;
export const OPS = ['set', 'reset', 'lock', 'unlock', 'snapshot'];
export const ROLES = ['controller', 'presenter', 'source'];
/** Ops only a presenter may send. */
export const PRESENTER_OPS = ['reset', 'lock', 'unlock'];

const ROOM = /^[a-z0-9][a-z0-9-]{0,63}$/i;
const CUSTOM_PROPERTY = /^--[a-z0-9_-]{1,120}$/i;
const CONTRACT_KEY = /^contract:[a-z0-9][a-z0-9.-]{0,120}$/i;
const THEME_ID = /^[a-z0-9][a-z0-9-]{0,63}$/i;
const MAX_PROPS = 500;

/** Is this a key `props` may carry? A custom property, or a contract knob. */
export function isPropKey(key) {
  return typeof key === 'string' && (CUSTOM_PROPERTY.test(key) || CONTRACT_KEY.test(key));
}

/** Is this a valid room code? */
export function isRoom(room) {
  return typeof room === 'string' && ROOM.test(room);
}

/**
 * Validate a message. Refuses the whole message on any problem: a change that
 * arrives half-applied is harder to reason about than one that didn't arrive.
 *
 * @param {unknown} msg
 * @param {{ requireTs?: boolean }} [options] `requireTs: false` for a message a
 *   client is about to send, before the channel stamps it.
 * @returns {{ ok: true, message: object } | { ok: false, errors: string[] }}
 */
export function validateMessage(msg, { requireTs = true } = {}) {
  const errors = [];
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return { ok: false, errors: ['message must be an object'] };
  }
  const m = /** @type {Record<string, unknown>} */ (msg);

  const known = new Set(['v', 'room', 'op', 'props', 'scope', 'from', 'ts']);
  for (const key of Object.keys(m)) {
    if (!known.has(key)) errors.push(`unknown field "${key}"`);
  }
  if (m.v !== PROTOCOL_VERSION) errors.push(`v must be ${PROTOCOL_VERSION}`);
  if (!isRoom(m.room)) errors.push('room must be 1–64 letters, digits or hyphens');
  if (!OPS.includes(/** @type {string} */ (m.op))) errors.push(`op must be one of ${OPS.join(', ')}`);
  if (!ROLES.includes(/** @type {string} */ (m.from))) errors.push(`from must be one of ${ROLES.join(', ')}`);
  if (m.scope !== undefined && m.scope !== '*' && !(typeof m.scope === 'string' && THEME_ID.test(m.scope))) {
    errors.push('scope must be a theme id or "*"');
  }
  if (requireTs || m.ts !== undefined) {
    if (typeof m.ts !== 'number' || !Number.isFinite(m.ts) || m.ts < 0) errors.push('ts must be a non-negative number');
  }
  if (PRESENTER_OPS.includes(/** @type {string} */ (m.op)) && m.from !== 'presenter') {
    errors.push(`${m.op} may only come from a presenter`);
  }

  const needsProps = m.op === 'set' || m.op === 'snapshot';
  if (needsProps) {
    if (!m.props || typeof m.props !== 'object' || Array.isArray(m.props)) {
      errors.push(`${m.op} needs a props object`);
    } else {
      const entries = Object.entries(m.props);
      if (m.op === 'set' && entries.length === 0) errors.push('set needs at least one prop');
      if (entries.length > MAX_PROPS) errors.push(`props may hold at most ${MAX_PROPS} keys`);
      for (const [key, value] of entries) {
        if (!isPropKey(key)) {
          errors.push(`"${key}" is not a custom property or contract:<path> key`);
          continue;
        }
        const safety = checkSafety(value);
        if (!safety.ok) errors.push(`${key}: ${safety.reason}`);
      }
    }
  } else if (m.props !== undefined) {
    errors.push(`${m.op} carries no props`);
  }

  if (errors.length) return { ok: false, errors };

  return { ok: true, message: m };
}

/**
 * Build a message, leaving `ts` for the channel to stamp.
 * @param {{ room: string, op: string, from: string, props?: Record<string, string>, scope?: string }} fields
 */
export function createMessage({ room, op, from, props, scope }) {
  const msg = { v: PROTOCOL_VERSION, room, op, from };
  if (props !== undefined) msg.props = props;
  if (scope !== undefined) msg.scope = scope;

  return msg;
}
