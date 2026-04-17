import { describe, expect, it } from 'bun:test';
import { inline } from '../src/inline.ts';

describe('inline', () => {
  it('removes all $ref when the schema is acyclic', () => {
    const schema = {
      type: 'object',
      properties: {
        address: { $ref: '#/$defs/Address' },
      },
      $defs: {
        Address: {
          type: 'object',
          properties: { city: { type: 'string' } },
        },
      },
    };
    const result = inline(schema);
    expect(JSON.stringify(result).includes('$ref')).toBe(false);
    expect(JSON.stringify(result).includes('$defs')).toBe(false);
  });

  it('substitutes refs with the full definition, not just the name', () => {
    const schema = {
      type: 'object',
      properties: {
        a: { $ref: '#/$defs/Leaf' },
      },
      $defs: {
        Leaf: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
      },
    };
    const result = inline(schema) as any;
    expect(result.properties.a.type).toBe('object');
    expect(result.properties.a.properties.value.type).toBe('string');
    expect(result.properties.a.required).toEqual(['value']);
  });

  it('handles refs inside items, oneOf, anyOf, allOf, additionalProperties', () => {
    const schema = {
      $defs: {
        Leaf: { type: 'string' },
      },
      type: 'object',
      properties: {
        inItems: { type: 'array', items: { $ref: '#/$defs/Leaf' } },
        inOneOf: { oneOf: [{ $ref: '#/$defs/Leaf' }, { type: 'number' }] },
        inAnyOf: { anyOf: [{ $ref: '#/$defs/Leaf' }] },
        inAllOf: { allOf: [{ $ref: '#/$defs/Leaf' }] },
        inAdditional: {
          type: 'object',
          additionalProperties: { $ref: '#/$defs/Leaf' },
        },
      },
    };
    const result = inline(schema) as any;
    expect(result.properties.inItems.items.type).toBe('string');
    expect(result.properties.inOneOf.oneOf[0].type).toBe('string');
    expect(result.properties.inAnyOf.anyOf[0].type).toBe('string');
    expect(result.properties.inAllOf.allOf[0].type).toBe('string');
    expect(result.properties.inAdditional.additionalProperties.type).toBe('string');
  });

  it('resolves chained refs (A → B → leaf)', () => {
    const schema = {
      type: 'object',
      properties: {
        user: { $ref: '#/$defs/User' },
      },
      $defs: {
        User: {
          type: 'object',
          properties: { address: { $ref: '#/$defs/Address' } },
        },
        Address: {
          type: 'object',
          properties: { city: { type: 'string' } },
        },
      },
    };
    const result = inline(schema) as any;
    expect(result.properties.user.properties.address.properties.city.type).toBe('string');
    expect(JSON.stringify(result).includes('$ref')).toBe(false);
  });

  it('returns identical object reference on repeated calls (WeakMap cache)', () => {
    const schema = {
      type: 'object',
      properties: { a: { $ref: '#/$defs/Leaf' } },
      $defs: { Leaf: { type: 'string' } },
    };
    const first = inline(schema);
    const second = inline(schema);
    expect(first).toBe(second);
  });

  it('returns a deeply frozen object', () => {
    const schema = {
      type: 'object',
      properties: { a: { $ref: '#/$defs/Leaf' } },
      $defs: { Leaf: { type: 'string' } },
    };
    const result = inline(schema) as any;
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.properties)).toBe(true);
    expect(Object.isFrozen(result.properties.a)).toBe(true);
  });

  it('throws on a self-referential schema with an actionable message', () => {
    const schema = {
      type: 'object',
      properties: {
        children: {
          type: 'array',
          items: { $ref: '#/$defs/Tree' },
        },
      },
      $defs: {
        Tree: {
          type: 'object',
          properties: {
            children: {
              type: 'array',
              items: { $ref: '#/$defs/Tree' },
            },
          },
        },
      },
    };
    expect(() => inline(schema)).toThrow(/cyclic/i);
    expect(() => inline(schema)).toThrow(/Tree/);
  });

  it('throws on mutual recursion (A ↔ B)', () => {
    const schema = {
      type: 'object',
      properties: { a: { $ref: '#/$defs/A' } },
      $defs: {
        A: { type: 'object', properties: { b: { $ref: '#/$defs/B' } } },
        B: { type: 'object', properties: { a: { $ref: '#/$defs/A' } } },
      },
    };
    expect(() => inline(schema)).toThrow(/cyclic/i);
  });

  it('throws on unresolved ref', () => {
    const schema = {
      type: 'object',
      properties: { a: { $ref: '#/$defs/Missing' } },
      $defs: {},
    };
    expect(() => inline(schema)).toThrow(/not found/);
  });

  it('passes primitive values through unchanged', () => {
    const schema = { type: 'string' };
    const result = inline(schema);
    expect(result.type).toBe('string');
  });

  it('strips top-level $defs from the output', () => {
    const schema = {
      type: 'object',
      $defs: { Leaf: { type: 'string' } },
    };
    const result = inline(schema) as any;
    expect(result.$defs).toBeUndefined();
  });
});
