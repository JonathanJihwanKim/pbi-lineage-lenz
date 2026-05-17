import { useEffect, useState } from "react";
import { useStore } from "../store";

interface Toast {
  id: number;
  kind: "warn" | "error" | "info";
  text: string;
}

let nextId = 1;

export function Toaster() {
  const error = useStore((s) => s.error);
  const summary = useStore((s) => s.summary);
  const measureGraph = useStore((s) => s.measureGraph);
  const infoToasts = useStore((s) => s.infoToasts);
  const dismissInfoToast = useStore((s) => s.dismissInfoToast);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [seenInfo, setSeenInfo] = useState<Set<number>>(new Set());
  const [seenWarnings, setSeenWarnings] = useState<Set<string>>(new Set());

  // Surface any model-level warnings once after bootstrap.
  useEffect(() => {
    if (!summary?.warnings.length) return;
    const fresh = summary.warnings.filter((w) => !seenWarnings.has(w));
    if (!fresh.length) return;
    const next = new Set(seenWarnings);
    fresh.forEach((w) => next.add(w));
    setSeenWarnings(next);
    pushToasts(fresh.slice(0, 3).map((text) => ({ id: nextId++, kind: "warn", text })));
    if (fresh.length > 3) {
      pushToasts([{ id: nextId++, kind: "warn", text: `…and ${fresh.length - 3} more parser warnings` }]);
    }
  }, [summary]);

  // Per-measure warnings.
  useEffect(() => {
    if (!measureGraph?.warnings.length) return;
    pushToasts(
      measureGraph.warnings.map((text) => ({
        id: nextId++,
        kind: "warn",
        text: `${measureGraph.measure.name}: ${text}`,
      })),
    );
  }, [measureGraph]);

  // Network / load errors.
  useEffect(() => {
    if (!error) return;
    pushToasts([{ id: nextId++, kind: "error", text: error }]);
  }, [error]);

  // Info toasts pushed via store.pushInfoToast (e.g. "Link copied"). We mirror
  // them into local state so the auto-dismiss timer logic stays unified, and
  // we drop the store entry as soon as it's mirrored (so refreshes don't
  // re-show them).
  useEffect(() => {
    if (!infoToasts.length) return;
    const fresh = infoToasts.filter((t) => !seenInfo.has(t.id));
    if (!fresh.length) return;
    const nextSeen = new Set(seenInfo);
    fresh.forEach((t) => nextSeen.add(t.id));
    setSeenInfo(nextSeen);
    pushToasts(fresh.map((t) => ({ id: nextId++, kind: "info", text: t.text })));
    fresh.forEach((t) => dismissInfoToast(t.id));
  }, [infoToasts]);

  function pushToasts(items: Toast[]) {
    setToasts((cur) => [...cur, ...items]);
    items.forEach((t) =>
      setTimeout(() => {
        setToasts((cur) => cur.filter((x) => x.id !== t.id));
      }, t.kind === "error" ? 8000 : t.kind === "info" ? 2500 : 5000),
    );
  }

  if (toasts.length === 0) return null;

  return (
    <div className="toaster">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast toast-${t.kind}`}
          role="alert"
          onClick={() => setToasts((cur) => cur.filter((x) => x.id !== t.id))}
        >
          <span className="toast-icon">
            {t.kind === "error" ? "✕" : t.kind === "info" ? "✓" : "!"}
          </span>
          <span className="toast-text">{t.text}</span>
        </div>
      ))}
    </div>
  );
}
