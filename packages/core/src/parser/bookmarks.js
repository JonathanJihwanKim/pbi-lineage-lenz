/**
 * Bookmark parser.
 *
 * Power BI authors stack visuals in one region and use buttons plus bookmarks to reveal
 * one at a time. Without the bookmarks, a visual marked `isHidden` looks permanently dead
 * when a button plainly shows it to users — so "hidden" alone is not a usable answer.
 *
 * Scope is narrow on purpose: enough to say *which named state reveals this visual*, not
 * enough to replay a page under each bookmark. `diff/bookmarkDiff.js` reads raw file maps
 * for change detection and is unaffected by this module.
 */

/**
 * Parse bookmark files.
 *
 * @param {Array<{path: string, content: string}>} bookmarkFiles
 * @returns {Array<{id: string, name: string, pages: Array<{pageId: string,
 *   hiddenVisuals: string[], hiddenGroups: string[], shownVisuals: string[]}>}>}
 */
export function parseBookmarks(bookmarkFiles = []) {
  const bookmarks = [];

  for (const { path, content } of bookmarkFiles) {
    let config;
    try {
      config = JSON.parse(content);
    } catch {
      continue; // A malformed bookmark should not take the whole report down.
    }
    if (!config) continue;

    const pages = [];
    for (const [pageId, section] of Object.entries(config.explorationState?.sections || {})) {
      const hiddenVisuals = [];
      const shownVisuals = [];

      for (const [visualId, container] of Object.entries(section.visualContainers || {})) {
        // `display.mode === 'hidden'` is the only explicit hide marker; a container
        // captured without it is being shown in this state.
        if (container?.singleVisual?.display?.mode === 'hidden') hiddenVisuals.push(visualId);
        else shownVisuals.push(visualId);
      }

      const { hiddenGroups, shownGroups } = collectGroupStates(section.visualContainerGroups);

      if (hiddenVisuals.length || shownVisuals.length || hiddenGroups.length || shownGroups.length) {
        pages.push({ pageId, hiddenVisuals, shownVisuals, hiddenGroups, shownGroups });
      }
    }

    bookmarks.push({
      id: config.name || basename(path),
      name: config.displayName || config.name || basename(path),
      pages,
    });
  }

  return bookmarks;
}

/**
 * Collect group ids by the state a bookmark puts them in, at any depth.
 *
 * Both directions matter. `isHidden: false` is not the absence of a rule — it is an
 * explicit reveal, and it is how the common "Show information Pane" button works.
 * Collecting only the hidden side makes every revealed group look permanently dead.
 *
 * Groups nest — `visualContainerGroups.<id>.children.<id>.children.<id>` occurs in real
 * reports — so a flat pass over the top level misses nested groups entirely.
 *
 * @param {object} groups
 * @returns {{hiddenGroups: string[], shownGroups: string[]}}
 */
function collectGroupStates(groups, out = { hiddenGroups: [], shownGroups: [] }) {
  for (const [groupId, group] of Object.entries(groups || {})) {
    if (group?.isHidden === true) out.hiddenGroups.push(groupId);
    else if (group?.isHidden === false) out.shownGroups.push(groupId);
    if (group?.children) collectGroupStates(group.children, out);
  }
  return out;
}

function basename(path) {
  return String(path || '').split(/[\\/]/).pop().replace(/\.bookmark\.json$/i, '');
}

/**
 * Resolve, per visual, whether anything ever reveals it.
 *
 * @param {Array<object>} visuals - Parsed visuals, carrying `id`, `pageId`, `isHidden`,
 *   and `parentGroupName`.
 * @param {Array<object>} bookmarks - Output of parseBookmarks().
 * @returns {Map<string, {isHidden: boolean, revealedBy: string[], hiddenBy: string[],
 *   neverShown: boolean}>} keyed by visual id
 */
export function resolveVisibility(visuals = [], bookmarks = []) {
  const result = new Map();

  for (const visual of visuals) {
    const revealedBy = [];
    const hiddenBy = [];

    for (const bookmark of bookmarks) {
      for (const page of bookmark.pages) {
        if (page.pageId !== visual.pageId && page.pageId !== visual.page) continue;

        // A group visual is addressed by its own id in `visualContainerGroups`; an
        // ordinary visual inherits the state of the group containing it.
        const groupIds = [visual.id, visual.parentGroupName].filter(Boolean);

        if (page.hiddenVisuals.includes(visual.id) || groupIds.some((id) => page.hiddenGroups.includes(id))) {
          hiddenBy.push(bookmark.name);
        } else if (page.shownVisuals.includes(visual.id) || groupIds.some((id) => page.shownGroups.includes(id))) {
          revealedBy.push(bookmark.name);
        }
      }
    }

    result.set(visual.id, {
      isHidden: !!visual.isHidden,
      revealedBy,
      hiddenBy,
      // Dead UI: hidden by default and no bookmark ever brings it back. Measures whose
      // only consumers are such visuals are effectively unreachable.
      neverShown: !!visual.isHidden && revealedBy.length === 0,
    });
  }

  return result;
}
