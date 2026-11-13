import { describe, expect, it } from 'vitest';
import { buildRecipients, detectPhoneColumn, normalizePhone } from '../shared/phone';
import { providersForCountry } from '../shared/routing';
import { analyzeSms, toGsmFriendly } from '../shared/sms';
import { renderTemplate, templateVariables } from '../shared/template';

describe('analyzeSms', () => {
  it('fits 160 GSM-7 characters in one segment and splits at 153 after that', () => {
    expect(analyzeSms('a'.repeat(160))).toMatchObject({ encoding: 'GSM-7', segments: 1, remaining: 0 });
    expect(analyzeSms('a'.repeat(161))).toMatchObject({ encoding: 'GSM-7', segments: 2, perSegment: 153 });
    expect(analyzeSms('a'.repeat(306)).segments).toBe(2);
    expect(analyzeSms('a'.repeat(307)).segments).toBe(3);
  });

  it('counts extension characters as two septets', () => {
    expect(analyzeSms('€'.repeat(80))).toMatchObject({ encoding: 'GSM-7', units: 160, segments: 1 });
    expect(analyzeSms('€'.repeat(81)).segments).toBe(2);
  });

  it('never splits an escape pair across segments', () => {
    // 152 plain characters then a 2-septet character: the € moves to part 2.
    const text = `${'a'.repeat(152)}€${'a'.repeat(10)}`;
    expect(analyzeSms(text).segments).toBe(2);
  });

  it('switches to UCS-2 for non-GSM characters with 70/67 limits', () => {
    expect(analyzeSms('Привет'.padEnd(70, 'я'))).toMatchObject({ encoding: 'UCS-2', segments: 1 });
    expect(analyzeSms('я'.repeat(71))).toMatchObject({ encoding: 'UCS-2', segments: 2, perSegment: 67 });
  });

  it('counts emoji as two UTF-16 units and reports offending characters', () => {
    const info = analyzeSms('Hi 👋 there’s a sale');
    expect(info.encoding).toBe('UCS-2');
    expect(info.units).toBe(20);
    expect(info.characters).toBe(19);
    expect(info.nonGsmCharacters).toEqual(['👋', '’']);
  });

  it('replaces typographic characters with GSM equivalents', () => {
    const text = toGsmFriendly('“Hello” – it’s here…');
    expect(text).toBe('"Hello" - it\'s here...');
    expect(analyzeSms(text).encoding).toBe('GSM-7');
  });

  it('treats empty text as zero segments', () => {
    expect(analyzeSms('').segments).toBe(0);
  });
});

describe('templates', () => {
  it('renders variables case-insensitively with fallbacks', () => {
    expect(renderTemplate('Hi {{ Name }}, code {{code}}', { name: 'Ada', code: '42' })).toBe('Hi Ada, code 42');
    expect(renderTemplate('Hi {{first_name|there}}!', {})).toBe('Hi there!');
    expect(renderTemplate('Hi {{first name|there}}!', { first_name: 'Grace' })).toBe('Hi Grace!');
    expect(renderTemplate('Hi {{missing}}.', {})).toBe('Hi .');
  });

  it('lists referenced variables once', () => {
    expect(templateVariables('{{a}} {{B|x}} {{a}}')).toEqual(['a', 'b']);
  });
});

describe('phone numbers', () => {
  it('normalises international and national formats to E.164', () => {
    expect(normalizePhone('+1 (415) 555-2671')).toEqual({ ok: true, e164: '+14155552671', country: 'US' });
    expect(normalizePhone('0044 7400 123456')).toEqual({ ok: true, e164: '+447400123456', country: 'GB' });
    expect(normalizePhone('07400 123456', 'GB')).toEqual({ ok: true, e164: '+447400123456', country: 'GB' });
    expect(normalizePhone('98765 43210', 'IN')).toEqual({ ok: true, e164: '+919876543210', country: 'IN' });
  });

  it('rejects junk, missing country codes and impossible numbers', () => {
    expect(normalizePhone('hello')).toMatchObject({ ok: false });
    expect(normalizePhone('4155552671')).toMatchObject({ ok: false, reason: 'Missing country code' });
    expect(normalizePhone('+1 555 0000')).toMatchObject({ ok: false });
  });

  it('builds a de-duplicated recipient list with normalised variables', () => {
    const list = buildRecipients(
      [
        { phone: '+14155552671', vars: { Name: 'Ada' } },
        { phone: '(415) 555-2671', vars: { Name: 'Dup' } },
        { phone: 'nope' },
        { phone: '+33612345678', vars: { 'First Name': 'Marie' } },
      ],
      'US',
    );
    expect(list.valid).toEqual([
      { phone: '+14155552671', country: 'US', vars: { name: 'Ada' } },
      { phone: '+33612345678', country: 'FR', vars: { first_name: 'Marie' } },
    ]);
    expect(list.duplicates).toBe(1);
    expect(list.invalid).toEqual([{ input: 'nope', reason: 'Not a phone number', row: 3 }]);
  });

  it('detects the phone column in a CSV header', () => {
    expect(detectPhoneColumn(['Name', 'Mobile Number', 'City'])).toBe(1);
    expect(detectPhoneColumn(['msisdn'])).toBe(0);
    expect(detectPhoneColumn(['name', 'city'])).toBe(-1);
  });
});

describe('routing', () => {
  const gw = (id: string, priority: number, countries: string[] = [], enabled = true) => ({ id, name: id, priority, countries, enabled });

  it('prefers country-specific gateways, then priority, and skips disabled ones', () => {
    const providers = [gw('global-a', 1), gw('global-b', 2), gw('india', 50, ['IN']), gw('off', 0, ['IN'], false)];
    expect(providersForCountry(providers, 'IN').map((p) => p.id)).toEqual(['india', 'global-a', 'global-b']);
    expect(providersForCountry(providers, 'US').map((p) => p.id)).toEqual(['global-a', 'global-b']);
  });

  it('routes unknown countries only to catch-all gateways', () => {
    expect(providersForCountry([gw('eu', 1, ['DE'])], null)).toEqual([]);
  });
});
