import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";

export function Header() {
  const depth = useStore((s) => s.depth);
  const setDepth = useStore((s) => s.setDepth);
  const search = useStore((s) => s.search);
  const setSearch = useStore((s) => s.setSearch);
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const summary = useStore((s) => s.summary);
  const pbipPath = useStore((s) => s.pbipPath);
  const showOpenModal = useStore((s) => s.showOpenModal);

  return (
    <header className="header">
      <div className="header-brand">
        <span className="header-logo" aria-hidden>
          <svg viewBox="0 0 24 24" width="20" height="20">
            <circle cx="11" cy="11" r="6" fill="none" stroke="currentColor" strokeWidth="2" />
            <line x1="16" y1="16" x2="20" y2="20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </span>
        <span className="header-title">Model Lenz</span>
        <span className="header-pbip" title={pbipPath ?? ""}>
          {summary?.name ?? shortPath(pbipPath ?? "")}
        </span>
        <button
          className="header-open-btn"
          onClick={showOpenModal}
          title="Open a different PBIP folder"
        >
          Open…
        </button>
      </div>

      <div className="header-search">
        <input
          type="search"
          placeholder="Search measures, tables, columns…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="header-controls">
        <ControlGroup label="Hops">
          <DepthSelect depth={depth} onChange={setDepth} />
          <DepthHelp />
        </ControlGroup>
        <ControlGroup label="Theme">
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </ControlGroup>
      </div>
    </header>
  );
}

function ControlGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="control-group">
      <span className="control-label">{label}</span>
      {children}
    </div>
  );
}

function ThemeToggle({
  theme,
  onToggle,
}: {
  theme: "dark" | "light";
  onToggle: () => void;
}) {
  return (
    <div className="seg-toggle" role="group" aria-label="Theme">
      <button
        aria-pressed={theme === "dark"}
        className={theme === "dark" ? "active" : ""}
        onClick={() => theme !== "dark" && onToggle()}
        title="Dark theme"
      >
        Dark
      </button>
      <button
        aria-pressed={theme === "light"}
        className={theme === "light" ? "active" : ""}
        onClick={() => theme !== "light" && onToggle()}
        title="Light theme"
      >
        Light
      </button>
    </div>
  );
}

function DepthSelect({
  depth,
  onChange,
}: {
  depth: number;
  onChange: (d: number) => void;
}) {
  return (
    <select
      value={depth}
      onChange={(e) => onChange(Number(e.target.value))}
      title="How many relationship hops to traverse when finding indirect dependencies"
      aria-label="Indirect-dependency hops"
    >
      {[1, 2, 3, 4, 5].map((d) => (
        <option key={d} value={d}>
          {d}
        </option>
      ))}
    </select>
  );
}

function DepthHelp() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div className="help-anchor" ref={ref}>
      <button
        className="help-icon"
        aria-label="What does Hops do?"
        onClick={() => setOpen((v) => !v)}
      >
        ⓘ
      </button>
      {open && (
        <div className="help-popover" role="tooltip">
          <h4>What "Hops" controls</h4>
          <p>
            How many relationship steps Model Lenz walks from the tables your
            measure directly references, looking for tables that <em>also</em>{" "}
            affect the result via filter propagation.
          </p>
          <ul>
            <li>
              <strong>1</strong> — only dimensions one hop from a directly-referenced fact.
            </li>
            <li>
              <strong>2</strong> <em>(recommended)</em> — catches typical
              snowflakes (e.g. <code>HFB → Range → fact</code>).
            </li>
            <li>
              <strong>3–5</strong> — deeper chains; usually noise.
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}

function shortPath(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts.slice(-2).join("/");
}
