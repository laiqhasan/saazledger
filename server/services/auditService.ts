import { db } from '../db/database';

export function logAudit(params: {
  userId?: string;
  action: string;
  entityType: string;
  entityId: string;
  prevState?: any;
  newState?: any;
  ipAddress?: string;
}): void {
  const id = `audit_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
  db.prepare(`
    INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, prev_state, new_state, ip_address)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    params.userId || 'system',
    params.action,
    params.entityType,
    params.entityId,
    params.prevState ? JSON.stringify(params.prevState) : null,
    params.newState ? JSON.stringify(params.newState) : null,
    params.ipAddress || null
  );
}

export function getAuditLogs(limit = 100): Array<{
  id: string;
  user_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  prev_state: string;
  new_state: string;
  ip_address: string;
  timestamp: string;
}> {
  return db.prepare('SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT ?').all(limit) as any[];
}
