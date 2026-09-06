import React, { useState, useEffect } from 'react';
import {
  X,
  Users,
  UserCheck,
  UserX,
  Shield,
  Clock,
  RefreshCw,
  Search,
  CheckCircle2,
  AlertCircle,
  Lock,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';

interface UserRecord {
  id: string;
  username: string;
  fullName: string;
  email?: string;
  role: 'admin' | 'manager' | 'staff' | 'clerk' | 'viewer';
  status: 'pending' | 'active' | 'rejected' | 'suspended';
  avatarUrl?: string;
  authProvider?: string;
  approvedBy?: string;
  approvedAt?: string;
  createdAt?: string;
}

interface UserManagementModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const UserManagementModal: React.FC<UserManagementModalProps> = ({ isOpen, onClose }) => {
  const { token, user: currentUser } = useAuth();
  const [activeTab, setActiveTab] = useState<'pending' | 'active'>('pending');
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [roleDrafts, setRoleDrafts] = useState<{ [userId: string]: string }>({});
  const [actionMessage, setActionMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const fetchUsers = async () => {
    if (!token) return;
    setIsLoading(true);
    try {
      const res = await fetch('/api/users', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        if (data.users) {
          setUsers(data.users);
          // If there are pending users, default tab to 'pending', else 'active'
          if (data.pendingCount > 0 && activeTab !== 'pending') {
            setActiveTab('pending');
          }
        }
      }
    } catch (err) {
      console.error('Failed to fetch users:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchUsers();
    }
  }, [isOpen, token]);

  if (!isOpen) return null;

  const pendingUsers = users.filter((u) => u.status === 'pending');
  const activeUsers = users.filter((u) => u.status !== 'pending');

  const filteredActiveUsers = activeUsers.filter(
    (u) =>
      u.fullName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (u.email || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
      u.role.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleApprove = async (userId: string) => {
    const assignedRole = roleDrafts[userId] || 'staff';
    try {
      const res = await fetch(`/api/users/${userId}/approve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ role: assignedRole }),
      });

      if (res.ok) {
        setActionMessage({ type: 'success', text: `User approved successfully as ${assignedRole.toUpperCase()}.` });
        fetchUsers();
      } else {
        const err = await res.json();
        setActionMessage({ type: 'error', text: err.error || 'Failed to approve user.' });
      }
    } catch {
      setActionMessage({ type: 'error', text: 'Network error approving user.' });
    }
    setTimeout(() => setActionMessage(null), 4000);
  };

  const handleReject = async (userId: string) => {
    if (!window.confirm('Are you sure you want to decline this access request?')) return;
    try {
      const res = await fetch(`/api/users/${userId}/status`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ status: 'rejected' }),
      });

      if (res.ok) {
        setActionMessage({ type: 'success', text: 'Access request declined.' });
        fetchUsers();
      } else {
        const err = await res.json();
        setActionMessage({ type: 'error', text: err.error || 'Failed to reject user.' });
      }
    } catch {
      setActionMessage({ type: 'error', text: 'Network error rejecting user.' });
    }
    setTimeout(() => setActionMessage(null), 4000);
  };

  const handleRoleChange = async (userId: string, newRole: string) => {
    try {
      const res = await fetch(`/api/users/${userId}/role`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ role: newRole }),
      });

      if (res.ok) {
        setActionMessage({ type: 'success', text: `Role updated to ${newRole.toUpperCase()}.` });
        fetchUsers();
      } else {
        const err = await res.json();
        setActionMessage({ type: 'error', text: err.error || 'Failed to update role.' });
      }
    } catch {
      setActionMessage({ type: 'error', text: 'Network error updating role.' });
    }
    setTimeout(() => setActionMessage(null), 4000);
  };

  const handleToggleStatus = async (userId: string, currentStatus: string) => {
    const newStatus = currentStatus === 'active' ? 'suspended' : 'active';
    const actionLabel = newStatus === 'active' ? 'reactivate' : 'suspend';
    if (!window.confirm(`Are you sure you want to ${actionLabel} access for this user?`)) return;

    try {
      const res = await fetch(`/api/users/${userId}/status`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ status: newStatus }),
      });

      if (res.ok) {
        setActionMessage({ type: 'success', text: `User account is now ${newStatus.toUpperCase()}.` });
        fetchUsers();
      } else {
        const err = await res.json();
        setActionMessage({ type: 'error', text: err.error || 'Failed to change status.' });
      }
    } catch {
      setActionMessage({ type: 'error', text: 'Network error changing user status.' });
    }
    setTimeout(() => setActionMessage(null), 4000);
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(5, 7, 10, 0.85)',
        backdropFilter: 'blur(12px)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
      }}
      onClick={onClose}
    >
      <div
        className="glass-panel"
        style={{
          width: '100%',
          maxWidth: '860px',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: '16px',
          border: '1px solid rgba(212, 175, 55, 0.35)',
          boxShadow: '0 25px 60px rgba(0, 0, 0, 0.8), 0 0 30px rgba(212, 175, 55, 0.12)',
          overflow: 'hidden',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            padding: '20px 24px',
            borderBottom: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'rgba(20, 24, 34, 0.8)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div
              style={{
                width: '38px',
                height: '38px',
                borderRadius: '10px',
                background: 'rgba(212, 175, 55, 0.15)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: '1px solid rgba(212, 175, 55, 0.3)',
              }}
            >
              <Users size={20} color="#fae084" />
            </div>
            <div>
              <h2
                style={{
                  fontFamily: 'var(--font-serif)',
                  fontSize: '1.25rem',
                  fontWeight: 700,
                  margin: 0,
                  color: '#fff',
                }}
              >
                Team Access & Role Authority
              </h2>
              <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                Approve Google registrations and assign Atelier OS role permissions
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              type="button"
              onClick={fetchUsers}
              className="btn-secondary"
              style={{ padding: '6px 12px', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '6px' }}
              title="Refresh users list"
            >
              <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
              <span>Refresh</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--text-muted)',
                cursor: 'pointer',
                padding: '6px',
                borderRadius: '6px',
              }}
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Action Notification Toast */}
        {actionMessage && (
          <div
            style={{
              padding: '10px 20px',
              background: actionMessage.type === 'success' ? 'rgba(16, 185, 129, 0.2)' : 'rgba(244, 63, 94, 0.2)',
              borderBottom: `1px solid ${actionMessage.type === 'success' ? '#10b981' : '#f43f5e'}`,
              color: actionMessage.type === 'success' ? '#34d399' : '#f43f5e',
              fontSize: '0.85rem',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
            }}
          >
            {actionMessage.type === 'success' ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
            <span>{actionMessage.text}</span>
          </div>
        )}

        {/* Tabs Bar */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            padding: '14px 24px',
            borderBottom: '1px solid var(--border-subtle)',
            background: 'rgba(15, 18, 26, 0.6)',
          }}
        >
          <button
            type="button"
            onClick={() => setActiveTab('pending')}
            style={{
              padding: '8px 16px',
              borderRadius: '8px',
              fontSize: '0.85rem',
              fontWeight: 600,
              cursor: 'pointer',
              border: activeTab === 'pending' ? '1px solid #d4af37' : '1px solid transparent',
              background: activeTab === 'pending' ? 'rgba(212, 175, 55, 0.15)' : 'transparent',
              color: activeTab === 'pending' ? '#fae084' : 'var(--text-muted)',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
            }}
          >
            <Clock size={16} />
            <span>Pending Approvals</span>
            {pendingUsers.length > 0 && (
              <span
                style={{
                  padding: '2px 7px',
                  borderRadius: '12px',
                  background: '#f59e0b',
                  color: '#0d1117',
                  fontSize: '0.72rem',
                  fontWeight: 700,
                }}
              >
                {pendingUsers.length}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('active')}
            style={{
              padding: '8px 16px',
              borderRadius: '8px',
              fontSize: '0.85rem',
              fontWeight: 600,
              cursor: 'pointer',
              border: activeTab === 'active' ? '1px solid #d4af37' : '1px solid transparent',
              background: activeTab === 'active' ? 'rgba(212, 175, 55, 0.15)' : 'transparent',
              color: activeTab === 'active' ? '#fae084' : 'var(--text-muted)',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
            }}
          >
            <Shield size={16} />
            <span>Team Directory ({activeUsers.length})</span>
          </button>
        </div>

        {/* Content Body */}
        <div style={{ padding: '20px 24px', overflowY: 'auto', flex: 1 }}>
          {/* TAB 1: PENDING APPROVALS */}
          {activeTab === 'pending' && (
            <div>
              {pendingUsers.length === 0 ? (
                <div
                  style={{
                    padding: '48px 20px',
                    textAlign: 'center',
                    color: 'var(--text-muted)',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: '12px',
                  }}
                >
                  <UserCheck size={48} color="rgba(212, 175, 55, 0.4)" />
                  <div style={{ fontSize: '1.05rem', fontWeight: 600, color: '#f3f4f6' }}>
                    Zero Pending Access Requests
                  </div>
                  <div style={{ fontSize: '0.84rem', color: 'var(--text-dim)', maxWidth: '420px' }}>
                    All Google signups have been processed. When a new user attempts to log in with Google, their request will appear here for your approval.
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  <div style={{ fontSize: '0.82rem', color: '#fbbf24', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <AlertCircle size={15} />
                    <span>The following users have authenticated via Google and are awaiting role assignment:</span>
                  </div>

                  {pendingUsers.map((pendingUser) => (
                    <div
                      key={pendingUser.id}
                      style={{
                        padding: '16px 20px',
                        borderRadius: '12px',
                        background: 'rgba(22, 27, 38, 0.7)',
                        border: '1px solid rgba(212, 175, 55, 0.3)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '16px',
                        flexWrap: 'wrap',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                        {pendingUser.avatarUrl ? (
                          <img
                            src={pendingUser.avatarUrl}
                            alt={pendingUser.fullName}
                            style={{ width: '44px', height: '44px', borderRadius: '50%', objectFit: 'cover', border: '2px solid #fae084' }}
                          />
                        ) : (
                          <div
                            style={{
                              width: '44px',
                              height: '44px',
                              borderRadius: '50%',
                              background: '#fae084',
                              color: '#0d1117',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              fontSize: '1.1rem',
                              fontWeight: 'bold',
                            }}
                          >
                            {pendingUser.fullName[0]?.toUpperCase() || 'U'}
                          </div>
                        )}
                        <div>
                          <div style={{ fontSize: '0.95rem', fontWeight: 600, color: '#f3f4f6' }}>
                            {pendingUser.fullName}
                          </div>
                          <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                            {pendingUser.email || 'No email reported'}
                          </div>
                          <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', marginTop: '2px' }}>
                            Requested access: {pendingUser.createdAt ? new Date(pendingUser.createdAt).toLocaleDateString() : 'Just now'}
                          </div>
                        </div>
                      </div>

                      {/* Approval Controls */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Assign Role:</span>
                          <select
                            className="select-field"
                            style={{ width: 'auto', padding: '6px 10px', fontSize: '0.82rem' }}
                            value={roleDrafts[pendingUser.id] || 'staff'}
                            onChange={(e) =>
                              setRoleDrafts({
                                ...roleDrafts,
                                [pendingUser.id]: e.target.value,
                              })
                            }
                          >
                            <option value="staff">Staff (Sales & POS)</option>
                            <option value="manager">Manager (Inventory & Feeds)</option>
                            <option value="admin">Admin (Full Control)</option>
                            <option value="viewer">Viewer (Read Only)</option>
                          </select>
                        </div>

                        <button
                          type="button"
                          className="btn-primary"
                          onClick={() => handleApprove(pendingUser.id)}
                          style={{
                            padding: '7px 14px',
                            fontSize: '0.82rem',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px',
                            background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                            color: '#fff',
                            border: '1px solid rgba(255, 255, 255, 0.2)',
                          }}
                        >
                          <UserCheck size={16} />
                          <span>Approve Access</span>
                        </button>

                        <button
                          type="button"
                          className="btn-danger"
                          onClick={() => handleReject(pendingUser.id)}
                          style={{ padding: '7px 12px', fontSize: '0.82rem' }}
                          title="Decline access request"
                        >
                          <UserX size={15} />
                          <span>Decline</span>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* TAB 2: ACTIVE TEAM DIRECTORY */}
          {activeTab === 'active' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {/* Search filter */}
              <div style={{ position: 'relative', maxWidth: '360px' }}>
                <Search
                  size={16}
                  color="var(--text-dim)"
                  style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)' }}
                />
                <input
                  type="text"
                  placeholder="Search team members by name, email, role..."
                  className="input-field"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  style={{ paddingLeft: '36px', fontSize: '0.85rem' }}
                />
              </div>

              {/* Members Table */}
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.86rem' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-dim)', fontSize: '0.74rem', textTransform: 'uppercase' }}>
                      <th style={{ padding: '10px 12px' }}>Team Member</th>
                      <th style={{ padding: '10px 12px' }}>Provider</th>
                      <th style={{ padding: '10px 12px' }}>Role</th>
                      <th style={{ padding: '10px 12px' }}>Status</th>
                      <th style={{ padding: '10px 12px', textAlign: 'right' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredActiveUsers.map((member) => {
                      const isMasterAdmin = member.email?.toLowerCase() === 'hasan.laiq@gmail.com';
                      const isSelf = member.id === currentUser?.id;

                      return (
                        <tr
                          key={member.id}
                          style={{
                            borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
                            background: isMasterAdmin ? 'rgba(212, 175, 55, 0.04)' : 'transparent',
                          }}
                        >
                          <td style={{ padding: '12px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                              {member.avatarUrl ? (
                                <img
                                  src={member.avatarUrl}
                                  alt={member.fullName}
                                  style={{ width: '32px', height: '32px', borderRadius: '50%', objectFit: 'cover', border: isMasterAdmin ? '1px solid #d4af37' : '1px solid rgba(255,255,255,0.2)' }}
                                />
                              ) : (
                                <div
                                  style={{
                                    width: '32px',
                                    height: '32px',
                                    borderRadius: '50%',
                                    background: isMasterAdmin ? '#d4af37' : '#334155',
                                    color: isMasterAdmin ? '#0d1117' : '#f8fafc',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    fontSize: '0.85rem',
                                    fontWeight: 'bold',
                                  }}
                                >
                                  {member.fullName[0]?.toUpperCase() || 'U'}
                                </div>
                              )}
                              <div>
                                <div style={{ fontWeight: 600, color: '#f3f4f6', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                  <span>{member.fullName}</span>
                                  {isMasterAdmin && (
                                    <span
                                      style={{
                                        fontSize: '0.65rem',
                                        background: 'rgba(212, 175, 55, 0.2)',
                                        color: '#fae084',
                                        padding: '1px 5px',
                                        borderRadius: '3px',
                                        border: '1px solid rgba(212, 175, 55, 0.4)',
                                      }}
                                    >
                                      Master Admin
                                    </span>
                                  )}
                                  {isSelf && !isMasterAdmin && (
                                    <span style={{ fontSize: '0.65rem', color: 'var(--text-dim)' }}>(You)</span>
                                  )}
                                </div>
                                <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                                  {member.email || member.username}
                                </div>
                              </div>
                            </div>
                          </td>

                          <td style={{ padding: '12px' }}>
                            <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', textTransform: 'capitalize' }}>
                              {member.authProvider === 'google' ? 'Google Identity' : 'Local'}
                            </span>
                          </td>

                          <td style={{ padding: '12px' }}>
                            {isMasterAdmin ? (
                              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#fae084', fontSize: '0.82rem', fontWeight: 600 }}>
                                <Lock size={13} />
                                <span>ADMIN</span>
                              </div>
                            ) : (
                              <select
                                className="select-field"
                                style={{ width: 'auto', padding: '4px 8px', fontSize: '0.8rem' }}
                                value={member.role}
                                onChange={(e) => handleRoleChange(member.id, e.target.value)}
                              >
                                <option value="admin">Admin</option>
                                <option value="manager">Manager</option>
                                <option value="staff">Staff</option>
                                <option value="viewer">Viewer</option>
                              </select>
                            )}
                          </td>

                          <td style={{ padding: '12px' }}>
                            <span
                              style={{
                                fontSize: '0.72rem',
                                textTransform: 'uppercase',
                                padding: '2px 8px',
                                borderRadius: '4px',
                                fontWeight: 600,
                                background:
                                  member.status === 'active'
                                    ? 'rgba(16, 185, 129, 0.15)'
                                    : 'rgba(244, 63, 94, 0.15)',
                                color: member.status === 'active' ? '#34d399' : '#f43f5e',
                                border:
                                  member.status === 'active'
                                    ? '1px solid rgba(16, 185, 129, 0.3)'
                                    : '1px solid rgba(244, 63, 94, 0.3)',
                              }}
                            >
                              {member.status}
                            </span>
                          </td>

                          <td style={{ padding: '12px', textAlign: 'right' }}>
                            {!isMasterAdmin && (
                              <button
                                type="button"
                                onClick={() => handleToggleStatus(member.id, member.status)}
                                style={{
                                  background: 'none',
                                  border: 'none',
                                  color: member.status === 'active' ? '#f43f5e' : '#34d399',
                                  fontSize: '0.78rem',
                                  cursor: 'pointer',
                                  textDecoration: 'underline',
                                  padding: '2px 6px',
                                }}
                              >
                                {member.status === 'active' ? 'Suspend' : 'Activate'}
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* Roles Reference Footer */}
        <div
          style={{
            padding: '12px 24px',
            borderTop: '1px solid var(--border-subtle)',
            background: 'rgba(10, 12, 16, 0.95)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: '0.76rem',
            color: 'var(--text-dim)',
            flexWrap: 'wrap',
            gap: '8px',
          }}
        >
          <span>Roles: <strong>Admin</strong> (All permissions) • <strong>Manager</strong> (Catalog & feeds) • <strong>Staff</strong> (Sales & tags) • <strong>Viewer</strong> (Read-only)</span>
          <span style={{ color: '#d4af37' }}>Protected by Master Admin hasan.laiq@gmail.com</span>
        </div>
      </div>
    </div>
  );
};
