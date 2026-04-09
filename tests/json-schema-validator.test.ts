import { describe, expect, it } from 'bun:test';
import { JSONSchemaValidator, ValidationError } from '../src/json-schema-validator.ts';

describe('JSONSchemaValidator', () => {
  describe('primitive types', () => {
    it('validates strings', () => {
      const v = new JSONSchemaValidator({ type: 'string' });
      expect(v.parse('hello')).toBe('hello');
      expect(() => v.parse(42)).toThrow(ValidationError);
    });

    it('validates numbers', () => {
      const v = new JSONSchemaValidator({ type: 'number' });
      expect(v.parse(42)).toBe(42);
      expect(v.parse(3.14)).toBe(3.14);
      expect(() => v.parse('not a number')).toThrow(ValidationError);
    });

    it('validates integers', () => {
      const v = new JSONSchemaValidator({ type: 'integer' });
      expect(v.parse(42)).toBe(42);
      expect(() => v.parse(3.14)).toThrow(ValidationError);
    });

    it('validates booleans', () => {
      const v = new JSONSchemaValidator({ type: 'boolean' });
      expect(v.parse(true)).toBe(true);
      expect(() => v.parse('true')).toThrow(ValidationError);
    });
  });

  describe('string constraints', () => {
    it('validates minLength', () => {
      const v = new JSONSchemaValidator({ type: 'string', minLength: 3 });
      expect(v.parse('abc')).toBe('abc');
      expect(() => v.parse('ab')).toThrow(ValidationError);
    });

    it('validates maxLength', () => {
      const v = new JSONSchemaValidator({ type: 'string', maxLength: 5 });
      expect(v.parse('hello')).toBe('hello');
      expect(() => v.parse('toolong')).toThrow(ValidationError);
    });

    it('validates pattern', () => {
      const v = new JSONSchemaValidator({ type: 'string', pattern: '^[a-z]+$' });
      expect(v.parse('hello')).toBe('hello');
      expect(() => v.parse('Hello123')).toThrow(ValidationError);
    });
  });

  describe('number constraints', () => {
    it('validates minimum', () => {
      const v = new JSONSchemaValidator({ type: 'number', minimum: 0 });
      expect(v.parse(5)).toBe(5);
      expect(() => v.parse(-1)).toThrow(ValidationError);
    });

    it('validates maximum', () => {
      const v = new JSONSchemaValidator({ type: 'number', maximum: 100 });
      expect(v.parse(50)).toBe(50);
      expect(() => v.parse(101)).toThrow(ValidationError);
    });
  });

  describe('enum', () => {
    it('validates enum values', () => {
      const v = new JSONSchemaValidator({ enum: ['a', 'b', 'c'] });
      expect(v.parse('a')).toBe('a');
      expect(() => v.parse('d')).toThrow(ValidationError);
    });
  });

  describe('nullable', () => {
    it('allows null when nullable is true', () => {
      const v = new JSONSchemaValidator({ type: 'string', nullable: true });
      expect(v.parse(null)).toBe(null);
    });

    it('rejects null when not nullable', () => {
      const v = new JSONSchemaValidator({ type: 'string' });
      expect(() => v.parse(null)).toThrow(ValidationError);
    });
  });

  describe('objects', () => {
    it('validates object properties', () => {
      const v = new JSONSchemaValidator({
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'integer' },
        },
        required: ['name'],
      });

      expect(v.parse({ name: 'Alice', age: 30 })).toEqual({ name: 'Alice', age: 30 });
      expect(v.parse({ name: 'Bob' })).toEqual({ name: 'Bob' });
    });

    it('rejects missing required properties', () => {
      const v = new JSONSchemaValidator({
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      });

      expect(() => v.parse({})).toThrow(ValidationError);
    });

    it('validates nested objects', () => {
      const v = new JSONSchemaValidator({
        type: 'object',
        properties: {
          address: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      });

      expect(v.parse({ address: { city: 'NYC' } })).toEqual({
        address: { city: 'NYC' },
      });
      expect(() => v.parse({ address: { city: 123 } })).toThrow(ValidationError);
    });
  });

  describe('arrays', () => {
    it('validates array items', () => {
      const v = new JSONSchemaValidator({
        type: 'array',
        items: { type: 'string' },
      });

      expect(v.parse(['a', 'b'])).toEqual(['a', 'b']);
      expect(() => v.parse([1, 2])).toThrow(ValidationError);
    });

    it('validates minItems', () => {
      const v = new JSONSchemaValidator({
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
      });

      expect(() => v.parse([])).toThrow(ValidationError);
    });

    it('validates maxItems', () => {
      const v = new JSONSchemaValidator({
        type: 'array',
        items: { type: 'string' },
        maxItems: 2,
      });

      expect(() => v.parse(['a', 'b', 'c'])).toThrow(ValidationError);
    });
  });

  describe('oneOf', () => {
    it('matches exactly one schema', () => {
      const v = new JSONSchemaValidator({
        oneOf: [{ type: 'string' }, { type: 'integer' }],
      });

      expect(v.parse('hello')).toBe('hello');
      expect(v.parse(42)).toBe(42);
    });
  });

  describe('anyOf', () => {
    it('matches at least one schema', () => {
      const v = new JSONSchemaValidator({
        anyOf: [{ type: 'string' }, { type: 'integer' }],
      });

      expect(v.parse('hello')).toBe('hello');
      expect(v.parse(42)).toBe(42);
      expect(() => v.parse(true)).toThrow(ValidationError);
    });
  });

  describe('allOf', () => {
    it('matches all schemas', () => {
      const v = new JSONSchemaValidator({
        allOf: [
          { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
          { type: 'object', properties: { age: { type: 'integer' } }, required: ['age'] },
        ],
      });

      expect(v.parse({ name: 'Alice', age: 30 })).toEqual({ name: 'Alice', age: 30 });
      expect(() => v.parse({ name: 'Alice' })).toThrow(ValidationError);
    });
  });

  describe('$ref resolution', () => {
    it('resolves references', () => {
      const v = new JSONSchemaValidator(
        {
          type: 'object',
          properties: {
            user: { $ref: '#/definitions/User' },
          },
        },
        {
          definitions: {
            User: {
              type: 'object',
              properties: { name: { type: 'string' } },
              required: ['name'],
            },
          },
        } as Record<string, any>,
      );

      expect(v.parse({ user: { name: 'Alice' } })).toEqual({
        user: { name: 'Alice' },
      });
      expect(() => v.parse({ user: {} })).toThrow(ValidationError);
    });
  });
});
