import { describe, it, expect } from 'vitest';
import { groupCategories, type CategoryNode } from '../../lib/categoryGroups';

/** A compact picture of the tree: "name" or "Label[member, member]". */
const shape = (nodes: CategoryNode[]) =>
  nodes.map((n) =>
    n.kind === 'category' ? n.entry.name : `${n.label}[${n.members.map((m) => m.label).join(', ')}]`
  );

describe('groupCategories', () => {
  it('groups a country prefix, in any of its spellings, and drops it from the rows', () => {
    const nodes = groupCategories([
      'UK Entertainment',
      'UK: Sports',
      'US | News',
      'UK - Kids',
      'US Sports',
      'Kids & Family',
    ]);
    expect(shape(nodes)).toEqual([
      'United Kingdom[Entertainment, Sports, Kids]',
      'United States[News, Sports]',
      'Kids & Family',
    ]);
    const uk = nodes[0];
    expect(uk.kind === 'group' && uk.badge).toBe('UK');
    expect(uk.kind === 'group' && uk.members[1]).toEqual({ name: 'UK: Sports', label: 'Sports' });
  });

  it('folds year families and shared last words (three or more), keeping singletons', () => {
    expect(
      shape(
        groupCategories([
          'Drama 2025',
          'ABC Regionals',
          'Drama 2024',
          'CBS Regionals',
          'Fox Regionals',
          'Horror 2025',
          'Netflix Movies',
          'Prime Movies',
        ])
      )
    ).toEqual([
      'Drama[2025, 2024]',
      'Regionals[ABC, CBS, Fox]',
      'Horror 2025',
      'Netflix Movies',
      'Prime Movies',
    ]);
  });

  it('groups a shared note in brackets, whatever its case', () => {
    expect(
      shape(
        groupCategories([
          'EPL (Match time only)',
          'NBA (Live events)',
          'SPFL (Match time only)',
          'NHL (Live Events)',
          'StarHub Network (EPL)',
          'MLB (Live events)',
          'UEFA/FA Cup (Match time only)',
        ])
      )
    ).toEqual([
      'Match time only[EPL, SPFL, UEFA/FA Cup]',
      'Live events[NBA, NHL, MLB]',
      'StarHub Network (EPL)',
    ]);
  });

  it('does not take ordinary capitalised words or a lone country for a group', () => {
    expect(shape(groupCategories(['TV Shows', 'UK Sports', 'NEW Releases', '4K Movies']))).toEqual([
      'TV Shows',
      'UK Sports',
      'NEW Releases',
      '4K Movies',
    ]);
  });
});
