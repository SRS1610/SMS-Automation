/**
 * Tiny personalisation language for message bodies.
 *
 *   "Hi {{name}}, your code is {{code}}"
 *   "Hi {{first_name|there}}"   -> falls back to "there" when the value is empty
 *
 * Variable names are matched case-insensitively against the recipient's
 * columns, with spaces and dashes treated as underscores.
 */

const TOKEN = /\{\{\s*([^{}|]+?)\s*(?:\|([^{}]*))?\}\}/g;

export function normalizeVarName(name: string): string {
  return name.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

export function normalizeVars(vars: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!vars) return out;
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined || value === null) continue;
    out[normalizeVarName(key)] = String(value).trim();
  }
  return out;
}

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(TOKEN, (_match, rawName: string, fallback: string | undefined) => {
    const value = vars[normalizeVarName(rawName)];
    if (value !== undefined && value !== '') return value;
    return fallback ?? '';
  });
}

/** Names of variables referenced in the template (normalised, unique, in order). */
export function templateVariables(template: string): string[] {
  const names: string[] = [];
  for (const match of template.matchAll(TOKEN)) {
    const name = normalizeVarName(match[1]);
    if (!names.includes(name)) names.push(name);
  }
  return names;
}
