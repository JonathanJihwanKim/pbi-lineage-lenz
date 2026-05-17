import type {
  DiffContext,
  DiffPayload,
  MeasureGraph,
  MeasureListItem,
  ModelSummary,
  OpenPbipResponse,
  RelationshipItem,
  SearchHit,
  TableDetail,
  TableListItem,
} from "./types";

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) {
    const text = await r.text().catch(() => r.statusText);
    throw new Error(`${r.status} ${r.statusText}: ${text}`);
  }
  return (await r.json()) as T;
}

async function fetchText(url: string, accept: string): Promise<string> {
  const r = await fetch(url, { headers: { Accept: accept } });
  if (!r.ok) {
    const text = await r.text().catch(() => r.statusText);
    throw new Error(`${r.status} ${r.statusText}: ${text}`);
  }
  return await r.text();
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    // Surface FastAPI's `{detail: "..."}` shape verbatim when present so the UI
    // can show the server's validation message instead of "400 Bad Request".
    let message = `${r.status} ${r.statusText}`;
    try {
      const data = await r.json();
      if (data && typeof data.detail === "string") message = data.detail;
    } catch {
      const text = await r.text().catch(() => "");
      if (text) message = text;
    }
    throw new Error(message);
  }
  return (await r.json()) as T;
}

export const api = {
  modelSummary: () => fetchJson<ModelSummary>("/api/model"),
  measures: () => fetchJson<MeasureListItem[]>("/api/measures"),
  measureGraph: (table: string, name: string, depth: number) =>
    fetchJson<MeasureGraph>(
      `/api/measures/${encodeURIComponent(table)}/${encodeURIComponent(name)}/graph?depth=${depth}`,
    ),
  tables: () => fetchJson<TableListItem[]>("/api/tables"),
  tableDetail: (name: string) =>
    fetchJson<TableDetail>(`/api/tables/${encodeURIComponent(name)}`),
  relationships: () => fetchJson<RelationshipItem[]>("/api/relationships"),
  search: (q: string) =>
    fetchJson<SearchHit[]>(`/api/search?q=${encodeURIComponent(q)}`),
  diffContext: () => fetchJson<DiffContext>("/api/diff/context"),
  diff: () => fetchJson<DiffPayload>("/api/diff"),
  openPbip: (path: string) =>
    postJson<OpenPbipResponse>("/api/model/open", { path }),
  measureMarkdown: (table: string, name: string, depth: number) =>
    fetchText(
      `/api/measures/${encodeURIComponent(table)}/${encodeURIComponent(name)}/markdown?depth=${depth}`,
      "text/markdown",
    ),
  tableMarkdown: (name: string) =>
    fetchText(`/api/tables/${encodeURIComponent(name)}/markdown`, "text/markdown"),
};
