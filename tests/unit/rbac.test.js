const { authorized, ROLE_PERMISSIONS } = require('../../src/middleware/rbac');
const { ALLOWED } = require('../../src/services/complaintService');

const U = (role, userId = 1) => ({ role, userId });
const C = (customer_id, assigned_officer_id = null) => ({ customer_id, assigned_officer_id });

describe('Role-based access control (Table 3.4)', () => {
  test('unauthenticated users are never authorized', () => { expect(authorized(null, 'submit_complaint')).toBe(false); });
  test('unknown roles and permissions are denied', () => {
    expect(authorized(U('hacker'), 'submit_complaint')).toBe(false);
    expect(authorized(U('customer'), 'delete_everything')).toBe(false);
  });
  test.each([
    ['customer', 'submit_complaint', true], ['customer', 'assign_complaint', false], ['customer', 'view_reports', false], ['customer', 'view_audit', false],
    ['officer', 'update_complaint', true], ['officer', 'submit_complaint', false], ['officer', 'assign_complaint', false], ['officer', 'view_reports', false],
    ['supervisor', 'assign_complaint', true], ['supervisor', 'view_reports', true], ['supervisor', 'submit_complaint', false], ['supervisor', 'manage_users', false],
    ['admin', 'manage_users', true], ['admin', 'manage_categories', true], ['admin', 'view_audit', true], ['admin', 'update_complaint', false], ['admin', 'view_all_complaints', false],
  ])('%s / %s -> %s', (role, perm, expected) => { expect(authorized(U(role), perm)).toBe(expected); });

  test('a customer can access only their own complaint', () => {
    expect(authorized(U('customer', 5), 'view_own_complaints', C(5))).toBe(true);
    expect(authorized(U('customer', 5), 'view_own_complaints', C(6))).toBe(false);
  });
  test('an officer can update only complaints assigned to them', () => {
    expect(authorized(U('officer', 7), 'update_complaint', C(5, 7))).toBe(true);
    expect(authorized(U('officer', 7), 'update_complaint', C(5, 8))).toBe(false);
    expect(authorized(U('officer', 7), 'update_complaint', C(5, null))).toBe(false);
  });
  test('a supervisor can act on any complaint; an administrator on none', () => {
    expect(authorized(U('supervisor', 2), 'update_complaint', C(5, 7))).toBe(true);
    expect(authorized(U('admin', 1), 'manage_users', C(5, 7))).toBe(false);
  });
  test('the supervisor holds every officer permission (generalization in Figure 3.3)', () => {
    for (const p of ROLE_PERMISSIONS.officer) expect(ROLE_PERMISSIONS.supervisor).toContain(p);
  });
});

describe('Complaint lifecycle (Table 3.2)', () => {
  test('only the permitted forward transitions exist', () => {
    expect(ALLOWED).toEqual({ Assigned: ['In Progress'], 'In Progress': ['Resolved'], Resolved: ['Closed'] });
  });
  test('no stage can be skipped and nothing leaves Closed', () => {
    expect(ALLOWED.Assigned).not.toContain('Resolved'); expect(ALLOWED.Submitted).toBeUndefined(); expect(ALLOWED.Closed).toBeUndefined();
  });
});
