const v = require('../../src/middleware/validate');

describe('Input validation module', () => {
  test('accepts a valid registration and normalises the e-mail', () => {
    const r = v.validateRegistration({ full_name: ' Ada Obi ', email: 'ADA@Example.ORG ', password: 'longenough1' });
    expect(r.email).toBe('ada@example.org'); expect(r.full_name).toBe('Ada Obi');
  });
  test.each([
    [{ full_name: 'A', email: 'a@b.co', password: 'longenough1' }, 'short name'],
    [{ full_name: 'Ada', email: 'not-an-email', password: 'longenough1' }, 'bad e-mail'],
    [{ full_name: 'Ada', email: 'a@b.co', password: 'short' }, 'short password'],
    [{ full_name: 'Ada', email: 'a@b.co', password: 12345678 }, 'non-string password'],
    [{ full_name: 'Ada', email: 'a@b.co', phone: 'abc', password: 'longenough1' }, 'bad phone'],
    [undefined, 'missing body'],
  ])('rejects invalid registration: %#', (body) => { expect(() => v.validateRegistration(body)).toThrow('Validation failed'); });

  test('accepts a valid complaint and converts category_id from a string', () => {
    const r = v.validateComplaint({ category_id: '3', subject: 'A valid subject', description: 'x'.repeat(30) });
    expect(r.category_id).toBe(3);
  });
  test.each([
    [{ category_id: 1, subject: 'abc', description: 'x'.repeat(30) }, 'subject too short'],
    [{ category_id: 1, subject: 'a'.repeat(151), description: 'x'.repeat(30) }, 'subject too long'],
    [{ category_id: 1, subject: 'A valid subject', description: 'too short' }, 'description too short'],
    [{ category_id: 1, subject: 'A valid subject', description: 'x'.repeat(4001) }, 'description too long'],
    [{ subject: 'A valid subject', description: 'x'.repeat(30) }, 'missing category'],
    [{ category_id: '1; DROP TABLE users', subject: 'A valid subject', description: 'x'.repeat(30) }, 'non-numeric category'],
    [{ category_id: 0, subject: 'A valid subject', description: 'x'.repeat(30) }, 'zero category'],
  ])('rejects invalid complaint: %#', (body) => { expect(() => v.validateComplaint(body)).toThrow('Validation failed'); });

  test('status change accepts known statuses only', () => {
    expect(v.validateStatusChange({ status: 'Resolved', note: 'done' }).status).toBe('Resolved');
    expect(() => v.validateStatusChange({ status: 'Deleted' })).toThrow();
  });
  test('feedback rating must be a whole number from 1 to 5', () => {
    expect(v.validateFeedback({ rating: 5 }).rating).toBe(5);
    expect(v.validateFeedback({ rating: '3', comment: ' ok ' }).comment).toBe('ok');
    for (const bad of [0, 6, 2.5, 'x', null]) expect(() => v.validateFeedback({ rating: bad })).toThrow();
    expect(() => v.validateFeedback({ rating: 4, comment: 'x'.repeat(501) })).toThrow();
  });
  test('message must be 2 to 4000 characters', () => {
    expect(v.validateMessage({ message: 'Hello' }).internal).toBe(false);
    expect(v.validateMessage({ message: 'Hello', internal: true }).internal).toBe(true);
    expect(() => v.validateMessage({ message: ' ' })).toThrow();
    expect(() => v.validateMessage({ message: 'x'.repeat(4001) })).toThrow();
  });
  test('category validation', () => {
    expect(v.validateCategory({ category_name: 'Billing', default_priority: 'High', resolution_hours: '48' }).resolution_hours).toBe(48);
    expect(() => v.validateCategory({ category_name: 'B', default_priority: 'High', resolution_hours: 48 })).toThrow();
    expect(() => v.validateCategory({ category_name: 'Billing', default_priority: 'Urgent', resolution_hours: 48 })).toThrow();
    expect(() => v.validateCategory({ category_name: 'Billing', default_priority: 'High', resolution_hours: 0 })).toThrow();
    expect(v.validateCategory({ resolution_hours: 10 }, true)).toEqual({ resolution_hours: 10 });
  });
  test('user patch validation', () => {
    expect(v.validateUserPatch({ is_active: false })).toEqual({ is_active: 0 });
    expect(() => v.validateUserPatch({})).toThrow();
    expect(() => v.validateUserPatch({ role: 'root' })).toThrow();
    expect(() => v.validateUserPatch({ is_active: 'no' })).toThrow();
  });
  test('id and date parsing', () => {
    expect(v.parseId('42')).toBe(42);
    for (const bad of ['0', '-1', '1.5', 'abc', '1 OR 1=1', '99999999999']) expect(() => v.parseId(bad)).toThrow('Invalid id');
    expect(v.parseDateRange({ from: '2026-01-01', to: '2026-01-31' }).to).toBe('2026-01-31 23:59:59');
    expect(() => v.parseDateRange({ from: '01/01/2026' })).toThrow();
    expect(() => v.parseDateRange({ from: "2026-01-01'; DROP TABLE x;--" })).toThrow();
  });
});
