const { HttpError } = require('../errors');
const { authorized } = require('./rbac');
const audit = require('../services/auditService');

function requireAuth(req, _res, next) {
  if (!req.session || !req.session.user) return next(new HttpError(401, 'Authentication required'));
  next();
}

function requirePermission(permission) {
  return async (req, _res, next) => {
    if (!req.session || !req.session.user) return next(new HttpError(401, 'Authentication required'));
    if (!authorized(req.session.user, permission)) {
      await audit.log(null, { userId: req.session.user.userId, action: 'ACCESS_DENIED', entityType: 'route', details: { permission, path: req.originalUrl }, ip: req.ip });
      return next(new HttpError(403, 'Forbidden'));
    }
    next();
  };
}

// Reject cross-site state-changing requests (defence in depth together with SameSite cookies)
function originCheck(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin) {
    try { if (new URL(origin).host !== req.get('host')) return next(new HttpError(403, 'Cross-origin request rejected')); }
    catch { return next(new HttpError(403, 'Cross-origin request rejected')); }
  }
  next();
}

module.exports = { requireAuth, requirePermission, originCheck };
