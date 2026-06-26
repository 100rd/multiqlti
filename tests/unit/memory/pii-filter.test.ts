import { describe, it, expect } from 'vitest';
import { PiiFilter } from '../../../server/memory/pii-filter.js';

describe('PiiFilter', () => {
  describe('Plain Text Redaction', () => {
    const filter = new PiiFilter();

    it('should redact personal email addresses', () => {
      const input = 'My email is john.doe123@example.co.uk and work email is admin@company.com.';
      const expected = 'My email is *** and work email is ***.';
      expect(filter.filter(input)).toBe(expected);
    });

    it('should redact SSNs', () => {
      const input = 'The customer SSN is 000-12-3456, please check.';
      const expected = 'The customer SSN is ***, please check.';
      expect(filter.filter(input)).toBe(expected);
    });

    it('should not redact malformed SSNs', () => {
      const inputs = [
        '12-345-6789',
        '123-45-678',
        '1234-56-7890',
        '123-456-7890',
      ];
      for (const input of inputs) {
        expect(filter.filter(input)).toBe(input);
      }
    });

    it('should redact Credit Cards of various lengths (13-16 digits)', () => {
      const cc13 = '1234567890123';
      const cc14 = '1234-5678-9012-34';
      const cc15 = '1234 5678 9012 345';
      const cc16 = '1234-5678-9012-3456';

      expect(filter.filter(`Card: ${cc13}`)).toBe('Card: ***');
      expect(filter.filter(`Card: ${cc14}`)).toBe('Card: ***');
      expect(filter.filter(`Card: ${cc15}`)).toBe('Card: ***');
      expect(filter.filter(`Card: ${cc16}`)).toBe('Card: ***');
    });

    it('should not redact digit sequences outside 13-16 length bounds', () => {
      const cc12 = '123456789012';
      const cc17 = '12345678901234567';

      expect(filter.filter(`Card: ${cc12}`)).toBe(`Card: ${cc12}`);
      expect(filter.filter(`Card: ${cc17}`)).toBe(`Card: ${cc17}`);
    });
  });

  describe('JSON Log Structure Redaction', () => {
    const filter = new PiiFilter();

    it('should parse and redact string values in a flat JSON object', () => {
      const original = {
        name: 'John Doe',
        email: 'john@example.com',
        card: '1111-2222-3333-4444',
        ssn: '123-45-6789',
        age: 30,
        active: true,
      };
      const jsonStr = JSON.stringify(original);
      const result = filter.filter(jsonStr);

      const parsed = JSON.parse(result);
      expect(parsed.name).toBe('John Doe');
      expect(parsed.email).toBe('***');
      expect(parsed.card).toBe('***');
      expect(parsed.ssn).toBe('***');
      expect(parsed.age).toBe(30);
      expect(parsed.active).toBe(true);
    });

    it('should recursively redact nested objects and arrays in JSON', () => {
      const original = {
        user: {
          contacts: [
            { type: 'email', value: 'contact@example.com' },
            { type: 'phone', value: '123-456-7890' },
          ],
          payment: {
            cc: '5555 5555 5555 5555',
          },
        },
        metadata: ['ssn is 999-99-9999', 'all clear'],
      };
      const jsonStr = JSON.stringify(original);
      const result = filter.filter(jsonStr);
      const parsed = JSON.parse(result);

      expect(parsed.user.contacts[0].value).toBe('***');
      expect(parsed.user.contacts[1].value).toBe('123-456-7890');
      expect(parsed.user.payment.cc).toBe('***');
      expect(parsed.metadata[0]).toBe('ssn is ***');
      expect(parsed.metadata[1]).toBe('all clear');
    });

    it('should preserve JSON indentation formatting', () => {
      const original = {
        email: 'foo@bar.com',
        status: 'ok',
      };
      const formattedJson = JSON.stringify(original, null, 4);
      const result = filter.filter(formattedJson);

      expect(result).toContain('\n    "email": "***",');
      expect(result).toContain('\n    "status": "ok"');
    });

    it('should fall back to plain-text regex redaction if JSON is malformed', () => {
      const malformedJson = '{"email": "foo@bar.com", "status": "ok"';
      const result = filter.filter(malformedJson);
      expect(result).toBe('{"email": "***", "status": "ok"');
    });
  });

  describe('Custom Configurations', () => {
    it('should support custom patterns and placeholders', () => {
      const customFilter = new PiiFilter({
        patterns: [
          {
            name: 'ipAddress',
            regex: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
            placeholder: '[REDACTED_IP]',
          },
        ],
      });

      const input = 'Connected from 192.168.1.50 with email test@example.com';
      // Email should NOT be redacted because we overrode patterns, only IP should be redacted.
      const expected = 'Connected from [REDACTED_IP] with email test@example.com';
      expect(customFilter.filter(input)).toBe(expected);
    });
  });
});
