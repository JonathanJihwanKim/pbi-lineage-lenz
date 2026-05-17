import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";

export function OpenPbipModal() {
  const visible = useStore((s) => s.openModalVisible);
  const hide = useStore((s) => s.hideOpenModal);
  const openPbip = useStore((s) => s.openPbip);
  const currentPath = useStore((s) => s.pbipPath);

  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (visible) {
      setPath(currentPath ?? "");
      setError(null);
      setSubmitting(false);
      // Defer focus until after the modal has actually painted.
      queueMicrotask(() => inputRef.current?.focus());
      inputRef.current?.select();
    }
  }, [visible, currentPath]);

  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [visible, hide]);

  if (!visible) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Strip surrounding quotes so Explorer's "Copy as path" (which wraps the
    // string in double quotes) pastes cleanly.
    const trimmed = path.trim().replace(/^["']|["']$/g, "").trim();
    if (!trimmed) {
      setError("Enter an absolute path to a PBIP folder.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await openPbip(trimmed);
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
      inputRef.current?.focus();
    }
  };

  return (
    <div className="modal-backdrop" onClick={hide} role="presentation">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="open-pbip-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="open-pbip-title" className="modal-title">Open a PBIP folder</h3>
        <p className="modal-subtext">
          Paste an absolute path to a PBIP project root, a <code>.SemanticModel</code>{" "}
          folder, or a <code>definition</code> subfolder.
        </p>
        <form onSubmit={submit}>
          <input
            ref={inputRef}
            type="text"
            className="modal-input"
            placeholder="D:\path\to\your_pbip"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            disabled={submitting}
            spellCheck={false}
            autoComplete="off"
          />
          {error && <div className="modal-error">{error}</div>}
          <div className="modal-actions">
            <button
              type="button"
              className="modal-btn"
              onClick={hide}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="modal-btn modal-btn-primary"
              disabled={submitting}
            >
              {submitting ? "Opening…" : "Open"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
