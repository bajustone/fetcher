import { describe, expect, it } from 'bun:test';
import { inline, InlineCycleError, InlineUnresolvedRefError } from '../src/inline.ts';

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

describe('inline — $ref sibling keywords (2020-12)', () => {
  it('merges sibling keywords over the resolved target', () => {
    const schema = {
      type: 'object',
      properties: {
        pet: { $ref: '#/$defs/Pet', description: 'sibling desc', minProperties: 1 },
      },
      $defs: {
        Pet: { type: 'object', properties: { name: { type: 'string' } } },
      },
    };
    const result = inline(schema) as any;
    // Target keywords survive…
    expect(result.properties.pet.type).toBe('object');
    expect(result.properties.pet.properties.name.type).toBe('string');
    // …and sibling keywords are merged in, not dropped.
    expect(result.properties.pet.description).toBe('sibling desc');
    expect(result.properties.pet.minProperties).toBe(1);
    expect(result.properties.pet.$ref).toBeUndefined();
  });

  it('sibling keywords win over same-named target keywords', () => {
    const schema = {
      type: 'object',
      properties: {
        pet: { $ref: '#/$defs/Pet', description: 'override' },
      },
      $defs: {
        Pet: { type: 'object', description: 'original' },
      },
    };
    const result = inline(schema) as any;
    expect(result.properties.pet.description).toBe('override');
  });

  it('substitutes refs nested inside sibling keywords', () => {
    const schema = {
      type: 'object',
      properties: {
        pet: {
          $ref: '#/$defs/Pet',
          properties: { extra: { $ref: '#/$defs/Leaf' } },
        },
      },
      $defs: {
        Pet: { type: 'object' },
        Leaf: { type: 'string' },
      },
    };
    const result = inline(schema) as any;
    expect(result.properties.pet.properties.extra.type).toBe('string');
    expect(JSON.stringify(result).includes('$ref')).toBe(false);
  });

  it('a node that is only a $ref still substitutes to the bare target', () => {
    const schema = {
      type: 'object',
      properties: { a: { $ref: '#/$defs/Leaf' } },
      $defs: { Leaf: { type: 'string' } },
    };
    const result = inline(schema) as any;
    expect(result.properties.a).toEqual({ type: 'string' });
  });

  it('preserves a property literally named __proto__ as an own key', () => {
    // Built via JSON.parse — a bare "__proto__" key in a test-source object
    // literal would hit the very ECMA-262 B.3.1 hazard under test.
    const schema = JSON.parse(
      '{"type":"object","properties":{"safe":{"type":"number"},"__proto__":{"$ref":"#/$defs/Leaf"}},"$defs":{"Leaf":{"type":"string"}}}',
    );
    const result = inline(schema) as any;
    // Own data property — not a clobbered prototype (which is what a plain
    // `out[key] = …` copy produces for this key).
    const desc = Object.getOwnPropertyDescriptor(result.properties, '__proto__');
    expect(desc).toBeDefined();
    expect(desc!.value).toEqual({ type: 'string' });
    expect(result.properties.safe).toEqual({ type: 'number' });
  });
});

describe('inline — boolean schema targets (2020-12)', () => {
  it('a `true` target with constraint siblings yields the siblings alone (conjunction)', () => {
    // Regression: siblings were silently dropped, making the output strictly
    // laxer than the source (`true AND { minimum: 3 }` is `{ minimum: 3 }`).
    const schema = {
      type: 'object',
      properties: {
        a: { $ref: '#/$defs/Any', minimum: 3, description: 'doc' },
      },
      $defs: { Any: true },
    } as any;
    const result = inline(schema) as any;
    expect(result.properties.a).toEqual({ minimum: 3, description: 'doc' });
  });

  it('a `true` target with no siblings resolves to `true`', () => {
    const schema = {
      type: 'object',
      properties: { a: { $ref: '#/$defs/Any' } },
      $defs: { Any: true },
    } as any;
    const result = inline(schema) as any;
    expect(result.properties.a).toBe(true);
  });

  it('a `false` target resolves to `false` (not an unresolved-ref error), siblings or not', () => {
    const schema = {
      type: 'object',
      properties: {
        bare: { $ref: '#/$defs/Never' },
        withSiblings: { $ref: '#/$defs/Never', minimum: 3 },
      },
      $defs: { Never: false },
    } as any;
    const result = inline(schema) as any;
    expect(result.properties.bare).toBe(false);
    // Conjunction with `false` is `false` — siblings cannot loosen it.
    expect(result.properties.withSiblings).toBe(false);
  });
});

describe('inline — deep $defs pointers (RFC 6901)', () => {
  it('resolves a deep pointer into a definition', () => {
    const schema = {
      type: 'object',
      properties: { name: { $ref: '#/$defs/Pet/properties/name' } },
      $defs: {
        Pet: { type: 'object', properties: { name: { type: 'string', minLength: 1 } } },
      },
    } as any;
    const result = inline(schema) as any;
    expect(result.properties.name).toEqual({ type: 'string', minLength: 1 });
    expect(JSON.stringify(result).includes('$ref')).toBe(false);
    expect(result.$defs).toBeUndefined();
  });

  it('keep mode no longer corrupts a resolvable deep pointer by stripping $defs', () => {
    // Regression: keep mode used to preserve this ref while stripping the
    // `$defs` it points into — turning a fully-resolvable input into a
    // permanently dangling output no downstream consumer could resolve.
    const schema = {
      type: 'object',
      properties: { name: { $ref: '#/$defs/Pet/properties/name' } },
      $defs: {
        Pet: { type: 'object', properties: { name: { type: 'string' } } },
      },
    } as any;
    const result = inline(schema, { onUnresolved: 'keep' }) as any;
    expect(result.properties.name).toEqual({ type: 'string' });
    expect(JSON.stringify(result).includes('$ref')).toBe(false);
  });

  it('walks array segments (prefixItems/0)', () => {
    const schema = {
      type: 'object',
      properties: { first: { $ref: '#/$defs/Tuple/prefixItems/0' } },
      $defs: { Tuple: { type: 'array', prefixItems: [{ type: 'integer' }] } },
    } as any;
    const result = inline(schema) as any;
    expect(result.properties.first).toEqual({ type: 'integer' });
  });

  it('unescapes ~1 and ~0 in deep-pointer segments', () => {
    const schema = {
      type: 'object',
      properties: { v: { $ref: '#/$defs/Obj/properties/a~1b~0c' } },
      $defs: { Obj: { type: 'object', properties: { 'a/b~c': { type: 'number' } } } },
    } as any;
    const result = inline(schema) as any;
    expect(result.properties.v).toEqual({ type: 'number' });
  });

  it('a deep pointer whose path does not exist stays unresolvable (throw / keep)', () => {
    const schema = {
      type: 'object',
      properties: { x: { $ref: '#/$defs/Pet/properties/nope' } },
      $defs: { Pet: { type: 'object', properties: { name: { type: 'string' } } } },
    } as any;
    expect(() => inline(schema)).toThrow(InlineUnresolvedRefError);
    const kept = inline(schema, { onUnresolved: 'keep' }) as any;
    expect(kept.properties.x.$ref).toBe('#/$defs/Pet/properties/nope');
  });

  it('detects a cycle through a deep pointer', () => {
    const schema = {
      type: 'object',
      properties: { self: { $ref: '#/$defs/Pet/properties/self' } },
      $defs: {
        Pet: { type: 'object', properties: { self: { $ref: '#/$defs/Pet/properties/self' } } },
      },
    } as any;
    expect(() => inline(schema)).toThrow(InlineCycleError);
  });
});

describe('inline — unresolvable refs', () => {
  it('throws InlineUnresolvedRefError for non-#/$defs/ refs by default', () => {
    const schema = {
      type: 'object',
      properties: { a: { $ref: '#/definitions/A' } },
      definitions: { A: { type: 'string' } },
    } as any;
    expect(() => inline(schema)).toThrow(InlineUnresolvedRefError);
    expect(() => inline(schema)).toThrow(/#\/definitions\/A/);
    // Names the offending location, not just the ref.
    expect(() => inline(schema)).toThrow(/#\/properties\/a/);
  });

  it('carries the ref and pointer on the error object', () => {
    const schema = {
      type: 'object',
      properties: { a: { $ref: 'https://example.com/schema.json' } },
    } as any;
    try {
      inline(schema);
      throw new Error('expected inline() to throw');
    }
    catch (err) {
      expect(err).toBeInstanceOf(InlineUnresolvedRefError);
      expect((err as InlineUnresolvedRefError).ref).toBe('https://example.com/schema.json');
      expect((err as InlineUnresolvedRefError).pointer).toBe('#/properties/a');
    }
  });

  it('missing #/$defs/ target throws with ref and pointer too', () => {
    const schema = {
      type: 'object',
      properties: { a: { $ref: '#/$defs/Missing' } },
      $defs: {},
    };
    try {
      inline(schema);
      throw new Error('expected inline() to throw');
    }
    catch (err) {
      expect(err).toBeInstanceOf(InlineUnresolvedRefError);
      expect((err as InlineUnresolvedRefError).ref).toBe('#/$defs/Missing');
      expect((err as InlineUnresolvedRefError).pointer).toBe('#/properties/a');
    }
  });

  it('onUnresolved: "keep" leaves the unresolvable ref node in place', () => {
    const schema = {
      type: 'object',
      properties: {
        a: { $ref: '#/definitions/A', description: 'kept' },
        b: { $ref: '#/$defs/Leaf' },
      },
      $defs: { Leaf: { type: 'string' } },
    } as any;
    const result = inline(schema, { onUnresolved: 'keep' }) as any;
    // Unresolvable ref survives, siblings intact.
    expect(result.properties.a.$ref).toBe('#/definitions/A');
    expect(result.properties.a.description).toBe('kept');
    // Resolvable refs are still substituted.
    expect(result.properties.b).toEqual({ type: 'string' });
  });

  it('memoizes per onUnresolved mode (modes do not share cache entries)', () => {
    const schema = {
      type: 'object',
      properties: { a: { $ref: '#/external/X' } },
    } as any;
    const kept1 = inline(schema, { onUnresolved: 'keep' });
    const kept2 = inline(schema, { onUnresolved: 'keep' });
    expect(kept1).toBe(kept2);
    // Default mode still throws for the same input — the 'keep' result must
    // not leak into the 'throw' cache.
    expect(() => inline(schema)).toThrow(InlineUnresolvedRefError);
  });

  it('cyclic refs throw InlineCycleError (distinct from unresolved)', () => {
    const schema = {
      type: 'object',
      properties: { a: { $ref: '#/$defs/A' } },
      $defs: {
        A: { type: 'object', properties: { a: { $ref: '#/$defs/A' } } },
      },
    };
    expect(() => inline(schema)).toThrow(InlineCycleError);
  });

  it('rebases the error pointer when the unresolvable ref is nested inside a def', () => {
    const schema = {
      type: 'object',
      properties: { a: { $ref: '#/$defs/A' } },
      $defs: {
        A: { type: 'object', properties: { x: { $ref: '#/definitions/Bad' } } },
      },
    } as any;
    try {
      inline(schema);
      throw new Error('expected inline() to throw');
    }
    catch (err) {
      expect(err).toBeInstanceOf(InlineUnresolvedRefError);
      // The pointer must exist in the INPUT document — the def's own
      // location, not the synthetic ref-site path
      // '#/properties/a/properties/x' (which resolves to nothing).
      expect((err as InlineUnresolvedRefError).pointer).toBe('#/$defs/A/properties/x');
    }
  });

  it('escapes pointer tokens containing / and ~ in error pointers', () => {
    const schema = {
      type: 'object',
      properties: { 'a/b~c': { $ref: '#/nope' } },
    } as any;
    try {
      inline(schema);
      throw new Error('expected inline() to throw');
    }
    catch (err) {
      expect((err as InlineUnresolvedRefError).pointer).toBe('#/properties/a~1b~0c');
    }
  });
});
