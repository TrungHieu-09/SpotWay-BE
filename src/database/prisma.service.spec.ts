import { withPoolLimit } from './prisma.service';

describe('withPoolLimit', () => {
  it('adds a connection_limit when the URL has none', () => {
    const url = withPoolLimit('postgresql://u:p@host:5432/postgres', 5)!;
    expect(new URL(url).searchParams.get('connection_limit')).toBe('5');
  });

  it('keeps existing query params and an explicit connection_limit', () => {
    const added = new URL(withPoolLimit('postgresql://u:p@localhost:5432/db?schema=public', 4)!);
    expect(added.searchParams.get('schema')).toBe('public');
    expect(added.searchParams.get('connection_limit')).toBe('4');
    expect(new URL(withPoolLimit('postgresql://u:p@h/db?connection_limit=9', 4)!).searchParams.get('connection_limit')).toBe('9');
  });

  it('passes through a missing or unparsable URL', () => {
    expect(withPoolLimit(undefined)).toBeUndefined();
    expect(withPoolLimit('not a url')).toBe('not a url');
  });
});
