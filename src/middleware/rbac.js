// Code form of Table 3.4 (Role-Based Access Matrix) and Algorithm 3.5 (Authorized)
const ROLE_PERMISSIONS = {
  customer:   ['submit_complaint', 'view_own_complaints', 'message_complaint', 'submit_feedback'],
  officer:    ['view_assigned_complaints', 'message_complaint', 'update_complaint'],
  supervisor: ['view_assigned_complaints', 'view_all_complaints', 'message_complaint', 'update_complaint', 'assign_complaint', 'view_reports'],
  admin:      ['manage_users', 'manage_categories', 'view_audit'],
};

function authorized(user, permission, complaint = null) {
  if (!user) return false;
  const perms = ROLE_PERMISSIONS[user.role];
  if (!perms || !perms.includes(permission)) return false;
  if (!complaint) return true; // role-level check only
  if (user.role === 'customer') return complaint.customer_id === user.userId;
  if (user.role === 'officer') return complaint.assigned_officer_id === user.userId;
  return user.role === 'supervisor'; // supervisor: all complaints; admin: none
}

module.exports = { ROLE_PERMISSIONS, authorized };
