/** Shared helpers for tests that call the real, now-authenticated API. */
export function seedTestUser(
  db: any,
  id: string,
  role: 'admin' | 'manager' | 'staff' | 'clerk' | 'viewer' = 'admin',
  status: 'active' | 'pending' | 'rejected' | 'suspended' = 'active'
): void {
  db.prepare(
    `INSERT OR REPLACE INTO users (id, username, password_hash, full_name, role, status, auth_provider)
     VALUES (?, ?, 'TEST_NO_PASSWORD', ?, ?, ?, 'local')`
  ).run(id, `${id}_name`, `Test ${role}`, role, status);
}
