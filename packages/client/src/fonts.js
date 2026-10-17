// Google Fonts sync, in preview sessions only (FEATURE-SPEC §10 Q3).
//
// When a room sets a font-family token to a family this page doesn't have,
// the applier asks Google Fonts for it, so the preview shows the real face
// instead of a fallback. The guardrails are the point:
//
// - Only fonts.googleapis.com is requested (it serves the files from
//   fonts.gstatic.com). The URL is built with the URL API, never by joining
//   strings, and a family name may only hold letters, digits and spaces.
// - Only while a tab is in a room: the loader exists only inside a started
//   session, and its <link>s are removed when the tab leaves.
// - A family the page already has (its theme's own @font-face fonts, which
//   document.fonts lists) is never requested, and neither is a common system
//   family (Arial, Georgia…), which the visitor's machine already has.
// - Only what was applied: the caller passes values the applier wrote, so a
//   refused value never causes a request.
// - At most eight families per session (Eddie's limit), compared without case.
// - Google serves the regular weight when only a family is named. Requesting
//   more weights fails for a family that lacks one of them, so bold faces in a
//   preview may be synthesised. Good enough to judge a face; not a proof.
//
// This is the documented exception to AGENTS.md §2.2's no-Google-Fonts rule:
// preview-only by construction. Never copy it into a shipping page.

const CSS_ENDPOINT = 'https://fonts.googleapis.com/css2';
const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong', 'inherit', 'initial', 'unset', 'revert']);
const SYSTEM = new Set(['arial', 'helvetica', 'helvetica neue', 'times', 'times new roman', 'georgia', 'verdana', 'tahoma', 'trebuchet ms', 'courier', 'courier new', 'segoe ui', 'san francisco', 'sf pro', 'sf pro text', 'sf pro display', 'menlo', 'monaco', 'consolas', 'impact', 'palatino', 'garamond', 'apple color emoji', 'segoe ui emoji', 'blinkmacsystemfont', '-apple-system']);
export const MAX_FAMILIES = 8;
const NAME = /^[A-Za-z0-9 ]{1,60}$/;

/** The named families in a font-family list: generics and anything that isn't a plain name are left out. */
export function familiesIn(value) {
  if (typeof value !== 'string') return [];

  return value
    .split(',')
    .map((part) => part.trim().replace(/^(["'])(.*)\1$/, '$2').trim())
    .filter((name) => name && !GENERIC.has(name.toLowerCase()) && NAME.test(name) && !/^var$/i.test(name));
}

/** The Google Fonts stylesheet for one family, or null for a name that isn't allowed. */
export function googleFontsUrl(family) {
  if (!NAME.test(family)) return null;
  const url = new URL(CSS_ENDPOINT);
  url.searchParams.set('family', family);
  url.searchParams.set('display', 'swap');

  return url.href;
}

/**
 * @param {{ document?: Document }} [options]
 */
export function createFontLoader({ document = globalThis.document, max = MAX_FAMILIES } = {}) {
  // Keyed by lower-cased family, so "Fraunces" and "fraunces" are one request.
  const links = new Map();

  /** Families this page already has, from its own @font-face rules. */
  function onPage() {
    const have = new Set();
    for (const face of document?.fonts ?? []) have.add(String(face.family).replace(/^["']|["']$/g, '').toLowerCase());

    return have;
  }

  return {
    /**
     * Make sure every family named in a font-family value is available.
     * @returns {string[]} the families requested now
     */
    ensure(value) {
      if (!document?.head) return [];
      const have = onPage();
      const requested = [];
      for (const family of familiesIn(value)) {
        const key = family.toLowerCase();
        if (links.has(key) || have.has(key) || SYSTEM.has(key)) continue;
        if (links.size >= max) break;
        const href = googleFontsUrl(family);
        if (!href) continue;
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        link.dataset.tokenSyncFont = family;
        document.head.append(link);
        links.set(key, link);
        requested.push(family);
      }

      return requested;
    },
    /** Take every requested font back out of the page. */
    remove() {
      try {
        for (const link of links.values()) link.remove();
      } finally {
        links.clear();
      }
    },
  };
}
