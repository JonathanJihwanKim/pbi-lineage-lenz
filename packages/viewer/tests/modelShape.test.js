/**
 * Model shape — classifying tables by the direction of their relationships.
 *
 * The point is that direction is enough. Power BI relationships run many-to-one from fact
 * to dimension, so a table that only originates them is a fact and one that only receives
 * them is a dimension, and no naming convention has to be trusted. `_agg_fct` and `_dim`
 * line up in the sample model and will not in the next one.
 */

import { describe, it, expect } from 'vitest';
import {
  describeModelShape, neighbourhood, describeRole, TABLE_ROLE, ROLE_ORDER,
} from '../src/modelShape.js';

const rel = (fromTable, fromColumn, toTable, toColumn, extra = {}) => ({
  name: `${fromTable}-${toTable}`, fromTable, fromColumn, toTable, toColumn,
  crossFilter: 'single', isActive: true, ...extra,
});

/** A star: one fact, two dimensions, one table joined to nothing. */
const star = {
  tables: [
    { name: 'Sales' }, { name: 'Date' }, { name: 'Product' }, { name: 'Measures' },
  ],
  relationships: [
    rel('Sales', 'date_fk', 'Date', 'date_sk'),
    rel('Sales', 'product_fk', 'Product', 'product_sk'),
  ],
};

describe('describeModelShape', () => {
  it('reads a fact from the direction of its joins, not its name', () => {
    const shape = describeModelShape(star);
    expect(shape.tables.get('Sales').role).toBe(TABLE_ROLE.FACT);
  });

  it('reads a dimension the same way', () => {
    const shape = describeModelShape(star);
    expect(shape.tables.get('Date').role).toBe(TABLE_ROLE.DIMENSION);
    expect(shape.tables.get('Product').role).toBe(TABLE_ROLE.DIMENSION);
  });

  it('keeps a table that joins to nothing rather than dropping it', () => {
    // 21 of 61 tables in the sample: field parameters, measure holders, inline tables.
    // They are the hardest things for a newcomer to find, so they are never filtered out.
    const shape = describeModelShape(star);
    expect(shape.tables.get('Measures').role).toBe(TABLE_ROLE.STANDALONE);
    expect(shape.tables.size).toBe(4);
  });

  it('calls a table that both filters and is filtered a bridge', () => {
    const shape = describeModelShape({
      tables: [{ name: 'Sales' }, { name: 'Product' }, { name: 'Category' }],
      relationships: [
        rel('Sales', 'product_fk', 'Product', 'product_sk'),
        rel('Product', 'category_fk', 'Category', 'category_sk'),
      ],
    });
    expect(shape.tables.get('Product').role).toBe(TABLE_ROLE.BRIDGE);
  });

  it('counts every table exactly once', () => {
    const shape = describeModelShape(star);
    const total = ROLE_ORDER.reduce((sum, role) => sum + shape.counts[role], 0);
    expect(total).toBe(shape.tables.size);
  });

  it('singles out bidirectional and inactive relationships', () => {
    // The two things that surprise someone reading a model they did not build.
    const shape = describeModelShape({
      tables: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
      relationships: [
        rel('A', 'x', 'B', 'y', { crossFilter: 'bothDirections' }),
        rel('A', 'z', 'C', 'w', { isActive: false }),
      ],
    });
    expect(shape.bidirectional).toHaveLength(1);
    expect(shape.inactive).toHaveLength(1);
  });

  it('reports a relationship naming a table the model does not have', () => {
    const shape = describeModelShape({
      tables: [{ name: 'Sales' }],
      relationships: [rel('Sales', 'x', 'Gone', 'y')],
    });

    expect(shape.dangling).toHaveLength(1);
    // And never invents the missing table to hang the edge on.
    expect(shape.tables.has('Gone')).toBe(false);
    expect(shape.tables.get('Sales').role).toBe(TABLE_ROLE.STANDALONE);
  });

  it('survives a model with no relationships at all', () => {
    const shape = describeModelShape({ tables: [{ name: 'Only' }], relationships: [] });
    expect(shape.counts.standalone).toBe(1);
  });
});

describe('neighbourhood', () => {
  it('gives both sides of a table’s joins', () => {
    const near = neighbourhood(describeModelShape(star), 'Sales');
    expect(near.edges.map((e) => e.other)).toEqual(['Date', 'Product']);
    expect(near.edges.every((e) => e.direction === 'out')).toBe(true);
  });

  it('says which way each join runs', () => {
    const near = neighbourhood(describeModelShape(star), 'Date');
    expect(near.edges).toEqual([{
      other: 'Sales', direction: 'in', fromColumn: 'date_fk', toColumn: 'date_sk',
      crossFilter: 'single', isActive: true,
    }]);
  });

  it('puts outgoing joins before incoming ones', () => {
    // The canvas draws them on opposite sides, so the order has to be stable.
    const shape = describeModelShape({
      tables: [{ name: 'Sales' }, { name: 'Product' }, { name: 'Category' }],
      relationships: [
        rel('Sales', 'product_fk', 'Product', 'product_sk'),
        rel('Product', 'category_fk', 'Category', 'category_sk'),
      ],
    });
    expect(neighbourhood(shape, 'Product').edges.map((e) => e.direction)).toEqual(['out', 'in']);
  });

  it('returns an empty neighbourhood rather than null for a standalone table', () => {
    expect(neighbourhood(describeModelShape(star), 'Measures').edges).toEqual([]);
  });

  it('returns null for a table the model does not have', () => {
    expect(neighbourhood(describeModelShape(star), 'Nope')).toBeNull();
  });
});

describe('describeRole', () => {
  it('explains every role it can return', () => {
    for (const role of ROLE_ORDER) expect(describeRole(role)).toBeTruthy();
  });
});
