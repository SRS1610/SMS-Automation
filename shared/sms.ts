/**
 * SMS length maths: works out whether a message can be sent as GSM-7 or must
 * fall back to UCS-2, and how many segments (billable parts) it will take.
 *
 * GSM-7: 160 septets in a single SMS, 153 per part once concatenated.
 * UCS-2: 70 UTF-16 code units in a single SMS, 67 per part once concatenated.
 * Characters in the GSM extension table cost two septets, and neither an
 * escape pair nor a surrogate pair may be split across two parts.
 */

export type SmsEncoding = 'GSM-7' | 'UCS-2';

const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXTENDED = '^{}\\[~]|€\f';

const basicSet = new Set(Array.from(GSM_BASIC));
const extendedSet = new Set(Array.from(GSM_EXTENDED));

/** Common "smart" characters that silently force UCS-2, with GSM-safe replacements. */
const LOOKALIKES: Record<string, string> = {
  '‘': "'", // ‘
  '’': "'", // ’
  '‚': "'", // ‚
  '“': '"', // “
  '”': '"', // ”
  '„': '"', // „
  '–': '-', // –
  '—': '-', // —
  '…': '...', // …
  ' ': ' ', // non-breaking space
  '•': '-', // •
};

export interface SmsInfo {
  encoding: SmsEncoding;
  /** User-visible characters (code points). */
  characters: number;
  /** Septets for GSM-7, UTF-16 code units for UCS-2. */
  units: number;
  segments: number;
  /** Capacity of each segment at the current length (160/153 or 70/67). */
  perSegment: number;
  /** Units left before another segment is needed. */
  remaining: number;
  /** Distinct characters that force UCS-2 encoding. */
  nonGsmCharacters: string[];
}

export function isGsmCharacter(ch: string): boolean {
  return basicSet.has(ch) || extendedSet.has(ch);
}

/** Septet cost of each character, or null if the text can't be GSM-7 encoded. */
function gsmCosts(text: string): number[] | null {
  const costs: number[] = [];
  for (const ch of text) {
    if (basicSet.has(ch)) costs.push(1);
    else if (extendedSet.has(ch)) costs.push(2);
    else return null;
  }
  return costs;
}

/** Packs indivisible character costs into parts of at most `size` units. */
function countParts(costs: number[], size: number): { parts: number; lastFill: number } {
  let parts = 1;
  let fill = 0;
  for (const cost of costs) {
    if (fill + cost > size) {
      parts += 1;
      fill = 0;
    }
    fill += cost;
  }
  return { parts, lastFill: fill };
}

export function analyzeSms(text: string): SmsInfo {
  const chars = Array.from(text);
  const gsm = gsmCosts(text);

  if (gsm) {
    const units = gsm.reduce((a, b) => a + b, 0);
    if (units <= 160) {
      return {
        encoding: 'GSM-7',
        characters: chars.length,
        units,
        segments: units === 0 ? 0 : 1,
        perSegment: 160,
        remaining: 160 - units,
        nonGsmCharacters: [],
      };
    }
    const { parts, lastFill } = countParts(gsm, 153);
    return {
      encoding: 'GSM-7',
      characters: chars.length,
      units,
      segments: parts,
      perSegment: 153,
      remaining: 153 - lastFill,
      nonGsmCharacters: [],
    };
  }

  const costs = chars.map((ch) => ch.length); // surrogate pairs cost 2 code units
  const units = costs.reduce((a, b) => a + b, 0);
  const nonGsmCharacters = Array.from(new Set(chars.filter((ch) => !isGsmCharacter(ch))));
  if (units <= 70) {
    return {
      encoding: 'UCS-2',
      characters: chars.length,
      units,
      segments: 1,
      perSegment: 70,
      remaining: 70 - units,
      nonGsmCharacters,
    };
  }
  const { parts, lastFill } = countParts(costs, 67);
  return {
    encoding: 'UCS-2',
    characters: chars.length,
    units,
    segments: parts,
    perSegment: 67,
    remaining: 67 - lastFill,
    nonGsmCharacters,
  };
}

/**
 * Replaces typographic characters (curly quotes, dashes, ellipsis...) with
 * GSM-7 equivalents. Returns the text unchanged if nothing applies.
 */
export function toGsmFriendly(text: string): string {
  let out = '';
  for (const ch of text) out += LOOKALIKES[ch] ?? ch;
  return out;
}

export function hasGsmReplacements(text: string): boolean {
  for (const ch of text) if (ch in LOOKALIKES) return true;
  return false;
}
