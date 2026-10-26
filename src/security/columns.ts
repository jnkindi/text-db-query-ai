import type { SecurityConfig } from '../types';

/** One restrictedColumns entry, parsed once. */
interface RestrictedEntry {
  /** Lowercased column name or fragment. */
  column: string;
  /** Lowercased table name for `table.column` entries. */
  table?: string;
  /** Lowercased schema for `schema.table.column` entries. */
  schema?: string;
  /** The entry as configured, for messages. */
  entry: string;
}

/**
 * Decides which columns `restrictedColumns` covers. Shared by the validator,
 * the row-level security rewrite and the prompt, so the model is never shown
 * or offered a column the validator would reject.
 */
export class RestrictedColumns {
  private readonly entries: RestrictedEntry[] = [];
  private readonly contains: boolean;

  constructor(config: Pick<SecurityConfig, 'restrictedColumns' | 'restrictedColumnsMatch'> = {}) {
    this.contains = config.restrictedColumnsMatch !== 'exact';
    for (const raw of config.restrictedColumns ?? []) {
      if (typeof raw !== 'string') continue;
      const entry = raw.trim();
      if (!entry) continue;
      const parts = entry.toLowerCase().split('.');
      const column = parts[parts.length - 1];
      if (!column) continue;
      this.entries.push({
        column,
        table: parts.length > 1 ? parts[parts.length - 2] : undefined,
        schema: parts.length > 2 ? parts[parts.length - 3] : undefined,
        entry: raw,
      });
    }
  }

  /** Whether any entry is configured. */
  get isEmpty(): boolean {
    return this.entries.length === 0;
  }

  /**
   * The entry that restricts `column`, or undefined. `table` (and `schema`)
   * name the table the column belongs to when it is known; a `table.column`
   * entry only matches then, and only that exact column.
   */
  match(column: string, table?: string, schema?: string): string | undefined {
    const name = column.toLowerCase();
    for (const e of this.entries) {
      if (e.table === undefined) {
        if (this.contains ? name.includes(e.column) : name === e.column) return e.entry;
        continue;
      }
      if (name !== e.column || table === undefined || table.toLowerCase() !== e.table) continue;
      if (e.schema !== undefined && schema !== undefined && schema.toLowerCase() !== e.schema) continue;
      return e.entry;
    }
    return undefined;
  }
}
