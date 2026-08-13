/**
 * The one place this app asks for anything.
 *
 * Shown after an export succeeds, because that is the moment the tool has just done
 * something — and it names what it did, in the units of the work it replaced, rather than
 * asserting that it was useful.
 *
 * Rules it follows, in order of how much they matter:
 *
 * 1. It never blocks. No modal, no overlay, nothing to dismiss before continuing.
 * 2. Once per session. A second ask is not more persuasive, only more irritating.
 * 3. It appears only after success. Asking for support next to a failed export is the
 *    kind of thing that loses a user permanently.
 * 4. It is dismissible, and staying dismissed is remembered for the session.
 */

import { h, replace } from '@pbi-lineage-lenz/viewer';

const SESSION_KEY = 'lenz.valueMoment.seen';

/**
 * Roughly how long this would take by hand.
 *
 * Deliberately coarse and stated as a range. Tracing one measure back through Power Query
 * to a source column is a few minutes of clicking if you know where to look; doing it for
 * a whole model, and writing it down so somebody else can read it, is an afternoon. A
 * precise-looking number here would be invented, and inventing numbers is exactly what
 * this tool exists to stop.
 */
export function estimateByHand(model) {
  const columns = model.columns?.length ?? 0;
  const measures = model.measures?.length ?? 0;
  const minutes = Math.round((columns * 0.4 + measures * 0.6) / 5) * 5;

  if (minutes < 30) return null; // Too small to claim anything about.
  if (minutes >= 240) return 'the better part of a day';
  if (minutes >= 60) return `${Math.round(minutes / 60)}–${Math.round(minutes / 60) + 1} hours`;
  return `${minutes}–${minutes + 15} minutes`;
}

/**
 * How long it took, in words that survive being fast.
 *
 * `(0.04).toFixed(1)` is `"0.0"`, and "Done in 0.0s" reads as a broken timer rather than
 * as speed — which is the opposite of what the sentence is for. Re-exporting an already
 * parsed model genuinely is that fast, so the floor is a real case, not a rounding edge.
 */
export function describeElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 500) return 'Done in under a second.';
  return `Done in ${(ms / 1000).toFixed(1)}s.`;
}

function seen() {
  try {
    return sessionStorage.getItem(SESSION_KEY) === '1';
  } catch {
    // Private browsing can throw on sessionStorage. Failing closed shows the prompt
    // once per page rather than never, which is the right way round.
    return false;
  }
}

function remember() {
  try {
    sessionStorage.setItem(SESSION_KEY, '1');
  } catch { /* Nothing to do; the prompt is not important enough to handle. */ }
}

/**
 * Build the prompt, or return null when it should not appear.
 *
 * @param {object} model - Viewer model that was just exported.
 * @param {number} elapsedMs - How long the export took.
 * @returns {HTMLElement|null}
 */
export function valueMoment(model, elapsedMs) {
  if (seen()) return null;

  const estimate = estimateByHand(model);
  if (!estimate) return null;

  remember();

  const host = h('div.value-moment', { role: 'status' });

  const dismiss = h('button.value-dismiss', {
    type: 'button',
    'aria-label': 'Dismiss',
    onClick: () => host.remove(),
  }, '×');

  replace(host,
    h('div.value-body',
      h('b', describeElapsed(elapsedMs)),
      h('span', ` Reading this model by hand and writing it down takes ${estimate}.`)),
    h('div.value-actions',
      h('a.btn.btn-accent', {
        href: 'https://github.com/sponsors/JonathanJihwanKim',
        target: '_blank',
        rel: 'noopener',
        onClick: () => host.remove(),
      }, 'Sponsor'),
      h('a.btn', {
        href: 'https://github.com/JonathanJihwanKim/pbi-lineage-lenz',
        target: '_blank',
        rel: 'noopener',
      }, 'Star on GitHub')),
    dismiss);

  // Goes away on its own. An ask that outlives the moment it belongs to becomes clutter.
  setTimeout(() => host.remove(), 20_000);

  return host;
}
