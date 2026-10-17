// Which sites a room may be previewed on. Kept per room, in extension
// storage: syncing a tab adds its site to the current room's list, and the
// extension re-applies the room after navigation only on listed sites (and
// only where the browser has granted the matching host permission).

/** The site (origin) of a page the extension may preview, or null for anything else (chrome://, file:, the web store). */
export function siteOf(url) {
  try {
    const { protocol, origin } = new URL(url);

    return protocol === 'https:' || protocol === 'http:' ? origin : null;
  } catch {
    return null;
  }
}

/** The host-permission pattern for a site: the browser asks the person for exactly this. */
export const permissionFor = (site) => `${site}/*`;

/**
 * @param {Record<string, string[]>} lists room code → sites
 * @returns {Record<string, string[]>}
 */
export function allow(lists, room, site) {
  const sites = lists[room] ?? [];

  return sites.includes(site) ? lists : { ...lists, [room]: [...sites, site].sort() };
}

export function disallow(lists, room, site) {
  const sites = (lists[room] ?? []).filter((s) => s !== site);
  const next = { ...lists, [room]: sites };
  if (!sites.length) delete next[room];

  return next;
}

export const isAllowed = (lists, room, url) => {
  const site = siteOf(url);

  return site !== null && (lists[room] ?? []).includes(site);
};
