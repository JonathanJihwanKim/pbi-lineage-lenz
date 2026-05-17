import { useEffect } from "react";
import { Header } from "./components/Header";
import { Sidebar } from "./components/Sidebar";
import { DetailPanel } from "./components/DetailPanel";
import { Legend } from "./components/Legend";
import { OpenPbipModal } from "./components/OpenPbipModal";
import { PinnedBar } from "./components/PinnedBar";
import { Toaster } from "./components/Toaster";
import { ForceGraph } from "./graph/ForceGraph";
import { DiffView } from "./routes/Diff";
import { useStore } from "./store";

export function App() {
  const theme = useStore((s) => s.theme);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // Tiny client-side router: only two routes today — "/" (model view) and
  // "/diff" (v0.3 diff view). No history navigation; the CLI determines which
  // view is launched. Avoids pulling react-router-dom in for two paths.
  const path = typeof window !== "undefined" ? window.location.pathname : "/";
  if (path.startsWith("/diff")) {
    return <DiffView />;
  }
  return <ModelView />;
}

function ModelView() {
  const bootstrap = useStore((s) => s.bootstrap);
  const setPbipPath = useStore((s) => s.setPbipPath);
  const loading = useStore((s) => s.loading);
  const error = useStore((s) => s.error);

  useEffect(() => {
    const saved = localStorage.getItem("model-lenz-right-panel-width");
    if (saved) {
      document.documentElement.style.setProperty("--right-panel-width", `${saved}px`);
    }
  }, []);

  useEffect(() => {
    fetch("/healthz")
      .then((r) => r.json())
      .then((h: { pbip: string }) => setPbipPath(h.pbip ?? "(unknown)"))
      .catch(() => setPbipPath("(unknown)"));
    bootstrap();
  }, [bootstrap, setPbipPath]);

  return (
    <div className="app">
      <Header />
      <div className="app-body">
        <Sidebar />
        <main className="canvas">
          {loading && <div className="overlay">Loading model…</div>}
          {error && (
            <div className="overlay error">
              <strong>Failed to load model:</strong> {error}
            </div>
          )}
          <PinnedBar />
          <ForceGraph />
          <Legend />
        </main>
        <DetailPanel />
      </div>
      <OpenPbipModal />
      <Toaster />
    </div>
  );
}
