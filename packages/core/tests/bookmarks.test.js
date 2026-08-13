import { describe, it, expect } from 'vitest';
import { parseBookmarks, resolveVisibility } from '../src/parser/bookmarks.js';
import { identifyProjectStructure } from '../src/parser/projectStructure.js';

/** A bookmark file as PBIR writes it. */
function bookmarkFile(displayName, pageId, { visuals = {}, groups = {} } = {}) {
  return {
    path: `bookmarks/${displayName.replace(/\W/g, '')}.bookmark.json`,
    content: JSON.stringify({
      displayName,
      name: displayName.replace(/\W/g, ''),
      explorationState: {
        sections: {
          [pageId]: { visualContainers: visuals, visualContainerGroups: groups },
        },
      },
    }),
  };
}

const hiddenContainer = { singleVisual: { display: { mode: 'hidden' } } };
const shownContainer = { singleVisual: { visualType: 'card' } };

describe('identifyProjectStructure', () => {
  it('collects bookmark files instead of dropping them', () => {
    // They were previously routed nowhere: 592 files in, every bookmark lost.
    const files = new Map([
      ['bookmarks/abc.bookmark.json', '{}'],
      ['pages/p1/page.json', '{}'],
      ['pages/p1/visuals/v1/visual.json', '{}'],
    ]);
    const structure = identifyProjectStructure(files);
    expect(structure.bookmarkFiles).toHaveLength(1);
    expect(structure.pageFiles).toHaveLength(1);
    expect(structure.visualFiles).toHaveLength(1);
  });

  it('finds bookmarks in a top-level folder, without a leading separator', () => {
    const structure = identifyProjectStructure(new Map([['bookmarks/x.bookmark.json', '{}']]));
    expect(structure.bookmarkFiles).toHaveLength(1);
  });

  it('does not misroute a bookmark into pageFiles', () => {
    const structure = identifyProjectStructure(new Map([['pages/bookmarks/x.bookmark.json', '{}']]));
    expect(structure.pageFiles).toHaveLength(0);
    expect(structure.bookmarkFiles).toHaveLength(1);
  });
});

describe('parseBookmarks', () => {
  it('reads the author-written display name', () => {
    const [bookmark] = parseBookmarks([bookmarkFile('Global Overview - Show information Pane', 'p1')]);
    expect(bookmark.name).toBe('Global Overview - Show information Pane');
  });

  it('separates hidden from shown visuals', () => {
    const [bookmark] = parseBookmarks([bookmarkFile('B', 'p1', {
      visuals: { v1: hiddenContainer, v2: shownContainer },
    })]);
    expect(bookmark.pages[0].hiddenVisuals).toEqual(['v1']);
    expect(bookmark.pages[0].shownVisuals).toEqual(['v2']);
  });

  it('treats isHidden:false as an explicit reveal, not an absent rule', () => {
    // This is how "Show information Pane" works. Collecting only the hidden side made
    // every revealed group look permanently dead.
    const [bookmark] = parseBookmarks([bookmarkFile('Show pane', 'p1', {
      groups: { g1: { isHidden: false }, g2: { isHidden: true } },
    })]);
    expect(bookmark.pages[0].shownGroups).toEqual(['g1']);
    expect(bookmark.pages[0].hiddenGroups).toEqual(['g2']);
  });

  it('walks nested groups to any depth', () => {
    const [bookmark] = parseBookmarks([bookmarkFile('Deep', 'p1', {
      groups: {
        g1: {
          isHidden: false,
          children: {
            g2: { isHidden: true, children: { g3: { isHidden: true } } },
          },
        },
      },
    })]);
    expect(bookmark.pages[0].hiddenGroups.sort()).toEqual(['g2', 'g3']);
    expect(bookmark.pages[0].shownGroups).toEqual(['g1']);
  });

  it('survives a malformed bookmark without losing the rest', () => {
    const bookmarks = parseBookmarks([
      { path: 'bookmarks/bad.bookmark.json', content: '{ not json' },
      bookmarkFile('Good', 'p1', { visuals: { v1: shownContainer } }),
    ]);
    expect(bookmarks).toHaveLength(1);
    expect(bookmarks[0].name).toBe('Good');
  });

  it('falls back to the filename when a bookmark has no display name', () => {
    const [bookmark] = parseBookmarks([{
      path: 'bookmarks/abc123.bookmark.json',
      content: JSON.stringify({ explorationState: { sections: {} } }),
    }]);
    expect(bookmark.name).toBe('abc123');
  });
});

describe('resolveVisibility', () => {
  const visuals = [
    { id: 'v1', pageId: 'p1', isHidden: true, parentGroupName: null },
    { id: 'g1', pageId: 'p1', isHidden: true, parentGroupName: null }, // a group visual
    { id: 'v2', pageId: 'p1', isHidden: true, parentGroupName: 'g1' }, // inside that group
    { id: 'v3', pageId: 'p1', isHidden: false, parentGroupName: null },
  ];

  it('names the bookmark that reveals a visual', () => {
    const state = resolveVisibility(visuals, parseBookmarks([
      bookmarkFile('Show it', 'p1', { visuals: { v1: shownContainer } }),
    ]));
    expect(state.get('v1').revealedBy).toEqual(['Show it']);
    expect(state.get('v1').neverShown).toBe(false);
  });

  it('resolves a group visual by its own id', () => {
    // A group is addressed in visualContainerGroups by the group's id, which is also
    // the visual's id — not by a parent reference.
    const state = resolveVisibility(visuals, parseBookmarks([
      bookmarkFile('Show pane', 'p1', { groups: { g1: { isHidden: false } } }),
    ]));
    expect(state.get('g1').revealedBy).toEqual(['Show pane']);
  });

  it('lets a visual inherit its containing group state', () => {
    const state = resolveVisibility(visuals, parseBookmarks([
      bookmarkFile('Show pane', 'p1', { groups: { g1: { isHidden: false } } }),
    ]));
    expect(state.get('v2').revealedBy).toEqual(['Show pane']);
  });

  it('flags a hidden visual no bookmark ever reveals as dead UI', () => {
    const state = resolveVisibility(visuals, parseBookmarks([
      bookmarkFile('Elsewhere', 'p1', { visuals: { v1: hiddenContainer } }),
    ]));
    expect(state.get('v1').neverShown).toBe(true);
  });

  it('never flags a visible visual as dead', () => {
    const state = resolveVisibility(visuals, []);
    expect(state.get('v3').neverShown).toBe(false);
  });

  it('ignores bookmarks that target another page', () => {
    const state = resolveVisibility(visuals, parseBookmarks([
      bookmarkFile('Other page', 'p2', { visuals: { v1: shownContainer } }),
    ]));
    expect(state.get('v1').revealedBy).toEqual([]);
  });
});
