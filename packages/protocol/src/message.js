// The token-sync/1 wire message (FEATURE-SPEC §6, eddie-design-system#2447).
//
//   { v, room, op, props, scope, from, ts, fonts? }
//
// One message per change, JSON. `ts` is assigned by the relay (or the local
// channel standing in for one), never trusted from a client clock.
//
// Eddie's docs/TOKEN-SYNC.md is the canonical description; this follows it:
// - `null` in props clears a token.
// - A `snapshot` with empty props asks the room for its state; one with props
//   answers, and an answer only fills tokens the receiver hasn't heard of.
// - `contract:<path>` names an Eddie contract path (contract:color.background.brand);
//   `contract:<group>.<knob>` (contract:color.background-brand) is a lab knob.
// - `fonts` names the families the props use. The lab loads families from the
//   font-family values it applies, which covers the same names, so it is
//   validated and otherwise ignored.

import { checkSafety } from './values.js';

export const PROTOCOL_VERSION = 1;
export const OPS = ['set', 'reset', 'lock', 'unlock', 'snapshot'];
export const ROLES = ['controller', 'presenter', 'source'];
/** Ops only a presenter may send. */
export const PRESENTER_OPS = ['reset', 'lock', 'unlock'];

const ROOM = /^[a-z0-9][a-z0-9-]{0,63}$/i;
// Eddie's limits: names to 128 characters, 400 props a message.
const CUSTOM_PROPERTY = /^--[a-z0-9_-]{1,126}$/i;
const CONTRACT_KEY = /^contract:[a-z0-9][a-z0-9.-]{0,120}$/i;
const THEME_ID = /^[a-z0-9][a-z0-9-]{0,63}$/i;
export const MAX_PROPS = 400;
const FONT_FAMILY = /^[A-Za-z0-9 ]{1,64}$/;
export const MAX_FONTS = 8;

/** Is this a key `props` may carry? A custom property, or a contract knob. */
export function isPropKey(key) {
  return typeof key === 'string' && (CUSTOM_PROPERTY.test(key) || CONTRACT_KEY.test(key));
}

/** Is this snapshot a request for the room's state, rather than an answer? */
export function isSnapshotRequest(msg) {
  return msg?.op === 'snapshot' && (!msg.props || Object.keys(msg.props).length === 0);
}

/** Is this a valid room code? */
export function isRoom(room) {
  return typeof room === 'string' && ROOM.test(room);
}

/**
 * Validate a message. A problem with the message itself (its op, room, role,
 * stamp, fonts) refuses all of it. A bad prop is refused on its own, as Eddie
 * does: the result's `message` carries the props that passed, and `refused`
 * says which didn't and why. Refusing the whole message instead let one value
 * the lab can't read (a derived easing, say) throw away a customizer's entire
 * snapshot answer. A set left with no props is refused.
 *
 * @param {unknown} msg
 * @param {{ requireTs?: boolean }} [options] `requireTs: false` for a message a
 *   client is about to send, before the channel stamps it.
 * @returns {{ ok: true, message: object, refused: { name: string, reason: string }[] } | { ok: false, errors: string[] }}
 */
export function validateMessage(msg, { requireTs = true } = {}) {
  const errors = [];
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return { ok: false, errors: ['message must be an object'] };
  }
  const m = /** @type {Record<string, unknown>} */ (msg);

  const known = new Set(['v', 'room', 'op', 'props', 'scope', 'from', 'ts', 'fonts']);
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
  if (m.fonts !== undefined) {
    if (!Array.isArray(m.fonts) || m.fonts.length > MAX_FONTS || !m.fonts.every((f) => typeof f === 'string' && FONT_FAMILY.test(f))) {
      errors.push(`fonts must be at most ${MAX_FONTS} family names (letters, digits and spaces)`);
    }
  }
  if (PRESENTER_OPS.includes(/** @type {string} */ (m.op)) && m.from !== 'presenter') {
    errors.push(`${m.op} may only come from a presenter`);
  }

  const needsProps = m.op === 'set' || m.op === 'snapshot';
  const refused = [];
  let props;
  if (needsProps) {
    if (!m.props || typeof m.props !== 'object' || Array.isArray(m.props)) {
      errors.push(`${m.op} needs a props object`);
    } else {
      const entries = Object.entries(m.props);
      if (m.op === 'set' && entries.length === 0) errors.push('set needs at least one prop');
      if (entries.length > MAX_PROPS) errors.push(`props may hold at most ${MAX_PROPS} keys`);
      props = {};
      for (const [key, value] of entries) {
        if (!isPropKey(key)) {
          refused.push({ name: String(key).slice(0, 128), reason: 'not a custom property or contract:<path> key' });
          continue;
        }
        // null clears the token; it carries nothing to check.
        if (value !== null) {
          const safety = checkSafety(value);
          if (!safety.ok) {
            refused.push({ name: key, reason: safety.reason });
            continue;
          }
        }
        props[key] = value;
      }
      if (m.op === 'set' && entries.length > 0 && Object.keys(props).length === 0) {
        errors.push(...refused.map((r) => `${r.name}: ${r.reason}`));
      }
    }
  } else if (m.props !== undefined) {
    errors.push(`${m.op} carries no props`);
  }

  if (errors.length) return { ok: false, errors };

  return { ok: true, message: props && refused.length ? { ...m, props } : m, refused };
}

/**
 * Build a message, leaving `ts` for the channel to stamp.
 * @param {{ room: string, op: string, from: string, props?: Record<string, string | null>, scope?: string }} fields
 */
export function createMessage({ room, op, from, props, scope }) {
  const msg = { v: PROTOCOL_VERSION, room, op, from };
  if (props !== undefined) msg.props = props;
  if (scope !== undefined) msg.scope = scope;

  return msg;
}
