// Mirrors the JSON contract emitted by the Python backend
// (model_lenz/api/routes.py and model_lenz/models/).

export type Classification =
  | "fact"
  | "dim"
  | "parameter"
  | "time"
  | "calculation_group"
  | "other";

export type Cardinality =
  | "many_to_one"
  | "one_to_many"
  | "one_to_one"
  | "many_to_many";

export type Crossfilter = "single" | "both";
export type Confidence = "high" | "medium" | "low" | "none";

export interface ModelSummary {
  name: string | null;
  counts: {
    tables: number;
    measures: number;
    relationships: number;
    expressions: number;
    functions: number;
  };
  classifications: Partial<Record<Classification, number>>;
  lineage_confidence: Partial<Record<Confidence, number>>;
  warnings: string[];
}

export interface MeasureListItem {
  name: string;
  table: string;
  display_folder: string | null;
  description: string | null;
  is_hidden: boolean;
}

export interface TableListItem {
  name: string;
  classification: Classification;
  is_hidden: boolean;
  column_count: number;
  measure_count: number;
  source_table: string | null;
  source_connector: string | null;
  source_confidence: Confidence | null;
}

export interface RelationshipItem {
  id: string;
  from_table: string;
  from_column: string;
  to_table: string;
  to_column: string;
  cardinality: Cardinality;
  crossfilter: Crossfilter;
  is_active: boolean;
}

export interface Hop {
  from_table: string;
  to_table: string;
  from_column: string;
  to_column: string;
  cardinality: Cardinality;
  crossfilter: Crossfilter;
  is_active: boolean;
  relationship_id: string;
}

export interface IndirectPath {
  hops: Hop[];
}

export interface IndirectTable {
  table: string;
  via: string;
  depth: number;
  ambiguous: boolean;
  crosses_fact: boolean;
  paths: IndirectPath[];
  source_label: string | null;
  source_connector: string | null;
  source_confidence: Confidence | null;
}

export interface GraphNode {
  id: string;
  kind: "measure" | "table" | "function";
  label: string;
  classification: Classification | null;
  source_label: string | null;
  source_connector: string | null;
  source_confidence: Confidence | null;
}

export interface ColumnRef {
  table: string;
  column: string;
}

export interface MeasureRef {
  name: string;
  table: string;
  expression: string | null;
  direct_table_count: number;
  indirect_table_count: number;
  direct_tables: string[];
  indirect_tables: string[];
}

export interface UserelHint {
  from: string;
  to: string;
}

export interface MeasureGraph {
  measure: {
    name: string;
    table: string;
    expression: string;
    displayFolder: string | null;
    formatString: string | null;
    description: string | null;
    lineageTag: string | null;
  };
  direct_tables: string[];
  direct_table_meta: GraphNode[];
  direct_columns: ColumnRef[];
  referenced_measures: MeasureRef[];
  userel_hints: UserelHint[];
  indirect_tables: IndirectTable[];
  warnings: string[];
}

export interface SourceLineage {
  connector: string | null;
  schema: string | null;
  table: string | null;
  fully_qualified: string | null;
  sql: string | null;
  transformed_steps: string[];
  upstream_expressions: string[];
  confidence: Confidence;
}

export interface Column {
  name: string;
  data_type: string | null;
  is_hidden: boolean;
  is_key: boolean;
  is_fk: boolean;
  source_column: string | null;
  description: string | null;
  lineage_tag: string | null;
  expression: string | null;
}

export interface Partition {
  name: string;
  mode: string;
  query_group: string | null;
  source_expression: string;
  source_lineage: SourceLineage | null;
}

export interface Measure {
  name: string;
  table: string;
  expression: string;
  display_folder: string | null;
  format_string: string | null;
  description: string | null;
  is_hidden: boolean;
  lineage_tag: string | null;
}

export interface Table {
  name: string;
  classification: Classification;
  is_hidden: boolean;
  data_category: string | null;
  description: string | null;
  lineage_tag: string | null;
  columns: Column[];
  measures: Measure[];
  partitions: Partition[];
  calculation_group: unknown | null;
}

export interface TableDetail {
  table: Table;
  relationships: RelationshipItem[];
}

export interface SearchHit {
  kind: "measure" | "table" | "column";
  name: string;
  table: string | null;
  score: number;
}

// --------------------------------------------------------------------------
// Diff (v0.3)
// --------------------------------------------------------------------------

export type DiffStatus = "added" | "removed" | "modified";

export interface MeasureDiff {
  status: DiffStatus;
  table: string;
  name: string;
  before: Measure | null;
  head: Measure | null;
  dax_changed: boolean;
  refs_changed: boolean;
  userel_changed: boolean;
  description_changed: boolean;
  display_folder_changed: boolean;
  format_string_changed: boolean;
  is_hidden_changed: boolean;
}

export interface ColumnDiff {
  name: string;
  before: Column | null;
  head: Column | null;
  description_changed: boolean;
  data_type_changed: boolean;
  is_hidden_changed: boolean;
  is_key_changed: boolean;
  source_column_changed: boolean;
  expression_changed: boolean;
}

export interface TableDiff {
  status: DiffStatus;
  name: string;
  before: Table | null;
  head: Table | null;
  source_lineage_changed: boolean;
  columns_added: string[];
  columns_removed: string[];
  columns_modified: ColumnDiff[];
  classification_before: string | null;
  classification_head: string | null;
  description_changed: boolean;
  is_hidden_changed: boolean;
}

export interface RelationshipDiff {
  status: DiffStatus;
  key: string;
  before: RelationshipItem | null;
  head: RelationshipItem | null;
  is_active_changed: boolean;
  cardinality_changed: boolean;
  crossfilter_changed: boolean;
}

export interface DiffCounts {
  measures_added: number;
  measures_removed: number;
  measures_modified: number;
  tables_added: number;
  tables_removed: number;
  tables_modified: number;
  relationships_added: number;
  relationships_removed: number;
  relationships_modified: number;
}

export interface DiffPayload {
  base_label: string;
  head_label: string;
  base_path: string;
  head_path: string;
  base_is_default_branch: boolean;
  counts: DiffCounts;
  measures: MeasureDiff[];
  tables: TableDiff[];
  relationships: RelationshipDiff[];
}

export interface DiffContext {
  base_label: string;
  head_label: string;
  base_path: string;
  head_path: string;
  base_is_default_branch: boolean;
}
