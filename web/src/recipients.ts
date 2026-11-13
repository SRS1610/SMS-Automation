import Papa from 'papaparse';
import { detectPhoneColumn, type RecipientInput } from '../../shared/phone';
import { normalizeVarName } from '../../shared/template';

export interface ParsedTable {
  /** Column names (empty when the input is a plain list of numbers). */
  headers: string[];
  rows: string[][];
  phoneColumn: number;
}

function clean(rows: unknown[][]): string[][] {
  return rows.map((r) => r.map((c) => String(c ?? '').trim())).filter((r) => r.some((c) => c !== ''));
}

const looksLikeHeader = (row: string[]) => row.some((cell) => /[a-z]/i.test(cell));

/** Turns parsed CSV rows into a table with a header and a chosen phone column. */
export function toTable(rawRows: string[][]): ParsedTable {
  const rows = clean(rawRows);
  if (!rows.length) return { headers: [], rows: [], phoneColumn: 0 };
  const first = rows[0];
  const detected = detectPhoneColumn(first);
  if (looksLikeHeader(first) && (detected >= 0 || first.length > 1)) {
    return { headers: first, rows: rows.slice(1), phoneColumn: Math.max(0, detected) };
  }
  // No header: a plain list of numbers, possibly several per line.
  const numbers = rows.flat().filter(Boolean);
  return { headers: [], rows: numbers.map((n) => [n]), phoneColumn: 0 };
}

export function parsePasted(text: string): ParsedTable {
  if (!text.trim()) return { headers: [], rows: [], phoneColumn: 0 };
  const result = Papa.parse<string[]>(text.trim(), { skipEmptyLines: 'greedy' });
  return toTable(result.data);
}

export function parseCsvFile(file: File): Promise<ParsedTable> {
  return new Promise((resolve, reject) => {
    Papa.parse<string[]>(file, {
      skipEmptyLines: 'greedy',
      complete: (result) => resolve(toTable(result.data)),
      error: (err) => reject(err),
    });
  });
}

export function tableToInputs(table: ParsedTable): RecipientInput[] {
  const keys = table.headers.map(normalizeVarName);
  return table.rows.map((row) => {
    const vars: Record<string, string> = {};
    keys.forEach((key, i) => {
      if (key) vars[key] = row[i] ?? '';
    });
    return { phone: row[table.phoneColumn] ?? '', vars };
  });
}

export function variableNames(table: ParsedTable): string[] {
  return Array.from(new Set(table.headers.map(normalizeVarName).filter(Boolean)));
}
