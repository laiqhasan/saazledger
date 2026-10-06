export type Role = 'viewer' | 'staff' | 'manager' | 'admin';

/** 'clerk' is a legacy role name (seeded sales clerk); it carries staff privileges. */
const RANK: Record<string, number> = { viewer: 1, clerk: 2, staff: 2, manager: 3, admin: 4 };

export function roleRank(role: unknown): number {
  return typeof role === 'string' ? RANK[role] ?? 0 : 0;
}

export function roleSatisfies(userRole: unknown, minimum: Role): boolean {
  return roleRank(userRole) >= RANK[minimum];
}
