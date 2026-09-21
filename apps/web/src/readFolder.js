/**
 * Getting a folder off disk and into a Map, by whichever route the browser allows.
 *
 * Two routes, deliberately. The File System Access API is the better one — it yields a
 * handle the app can re-read to refresh after a save, and it is what Chrome and Edge
 * users get. But it does not exist in Firefox or Safari, and `<input webkitdirectory>`
 * does, in every browser that matters. Treating those users as unsupported would be a
 * choice, not a limitation: the fallback reads the same folder and produces the same Map.
 *
 * What Firefox and Safari genuinely cannot do is *save* the result anywhere but the
 * downloads folder, which is a much smaller loss than not being able to open a model.
 */

import { shouldRead, normalizePath } from './pbipFolder.js';

/** Is the File System Access API available? */
export function hasFileSystemAccess() {
  return typeof globalThis.showDirectoryPicker === 'function';
}

/**
 * Read a directory handle recursively.
 *
 * @param {FileSystemDirectoryHandle} handle
 * @param {(count: number) => void} [onProgress] - Called as files are read.
 * @returns {Promise<Map<string, string>>}
 */
export async function readDirectoryHandle(handle, onProgress) {
  const files = new Map();

  const walk = async (dir, prefix) => {
    for await (const entry of dir.values()) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.kind === 'directory') {
        // Cheap pre-check: a skipped directory should not be descended into at all.
        if (shouldRead(`${path}/probe.tmdl`)) await walk(entry, path);
        continue;
      }
      if (!shouldRead(path)) continue;
      const file = await entry.getFile();
      files.set(path, await file.text());
      onProgress?.(files.size);
    }
  };

  await walk(handle, '');
  return files;
}

/**
 * Read the FileList produced by `<input type="file" webkitdirectory>`.
 *
 * `webkitRelativePath` starts with the picked folder's own name. Stripping it makes the
 * two routes produce identical maps, so everything downstream can stay ignorant of which
 * one was used.
 *
 * @param {FileList|File[]} fileList
 * @param {(count: number) => void} [onProgress]
 * @returns {Promise<Map<string, string>>}
 */
export async function readFileList(fileList, onProgress) {
  const files = new Map();
  const wanted = [];

  for (const file of fileList) {
    const relative = normalizePath(file.webkitRelativePath || file.name);
    const path = relative.includes('/') ? relative.slice(relative.indexOf('/') + 1) : relative;
    if (shouldRead(path)) wanted.push([path, file]);
  }

  for (const [path, file] of wanted) {
    files.set(path, await file.text());
    onProgress?.(files.size);
  }
  return files;
}

/**
 * Open a directory picker by whichever route exists.
 *
 * @param {(count: number) => void} [onProgress]
 * @param {object} [options]
 * @param {object} [options.startIn] - A directory handle to open the dialog beside.
 * @returns {Promise<{files: Map<string, string>, handle: object|null, name: string}
 *   | {cancelled: string, detail?: string}>}
 *   A `cancelled` result when nothing came back, saying which way.
 */
export async function pickFolder(onProgress, { startIn = null, basic = false } = {}) {
  if (hasFileSystemAccess() && !basic) {
    let handle;
    // How long the call took before it failed says whether a dialog was ever on screen.
    // A person choosing a folder takes seconds; a refusal that never showed them anything
    // comes back in milliseconds, and the two need different remedies.
    const started = Date.now();
    try {
      // `startIn` opens the dialog beside the folder already picked, so reaching the
      // model that sits next to a report is one step up rather than a fresh hunt.
      handle = await globalThis.showDirectoryPicker({
        id: 'pbip', mode: 'read', ...(startIn ? { startIn } : {}),
      });
    } catch (error) {
      // A cancelled picker throws rather than resolving to null. That is not an error —
      // but the reason is worth carrying out, because "nothing came back" and "you
      // pressed cancel" look identical on screen and have different remedies.
      const elapsed = Date.now() - started;
      const detail = `${error?.name ?? 'Error'}: ${error?.message ?? 'no message'} · after ${elapsed}ms`;
      if (error?.name === 'AbortError') {
        // Under a quarter-second, nothing was ever shown to dismiss.
        return { cancelled: elapsed < 250 ? 'refused' : 'aborted', detail, elapsed };
      }
      if (error?.name === 'SecurityError' || error?.name === 'NotAllowedError') {
        return { cancelled: 'blocked', detail, elapsed };
      }
      throw error;
    }
    // No permission dance here on purpose: choosing a folder in the picker *is* the grant
    // for `mode: 'read'`, and `requestPermission()` needs a user activation that the
    // picker has just consumed — so asking again reliably answers "denied" and loses the
    // folder the user already chose.
    return { files: await readDirectoryHandle(handle, onProgress), handle, name: handle.name };
  }

  const fileList = await promptForDirectory();
  if (!fileList || fileList.length === 0) return { cancelled: 'aborted', detail: 'file input returned nothing' };

  const first = normalizePath(fileList[0].webkitRelativePath || '');
  return {
    files: await readFileList(fileList, onProgress),
    handle: null,
    name: first.split('/')[0] || 'folder',
  };
}

/**
 * Show a directory `<input>` and resolve with its selection.
 *
 * There is no cancel event for a file input — a dismissed dialog fires nothing at all.
 * `cancel` covers modern browsers; the window-focus fallback covers the rest, so a user
 * who backs out does not leave the app waiting on a promise forever.
 */
function promptForDirectory() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.webkitdirectory = true;
    input.multiple = true;
    input.style.display = 'none';
    document.body.append(input);

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };

    input.addEventListener('change', () => finish(input.files));
    input.addEventListener('cancel', () => finish(null));

    // The focus fallback is a guess with a deadline, and a folder of thousands of files
    // can still be filling in when it fires — so it only runs where `cancel` does not
    // exist, and waits long enough not to cut a large folder short.
    if (!('oncancel' in input)) {
      addEventListener('focus', () => {
        setTimeout(() => { if (!input.files || input.files.length === 0) finish(null); }, 2000);
      }, { once: true });
    }

    input.click();
  });
}

/**
 * Read a single file the user picks — used for opening an existing handoff file.
 * @param {string} accept
 * @returns {Promise<{name: string, text: string}|null>}
 */
export function pickFile(accept = '.html,text/html') {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    document.body.append(input);

    let settled = false;
    const finish = async (file) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(file ? { name: file.name, text: await file.text() } : null);
    };

    input.addEventListener('change', () => finish(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => finish(null));
    input.click();
  });
}
