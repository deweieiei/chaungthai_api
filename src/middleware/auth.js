const { verifyAccessToken } = require('../utils/tokens');
const { errors } = require('../utils/http');

// Verifies JWT in Authorization: Bearer <token> and attaches req.user
function requireAuth(req, _res, next) {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
        return next(errors.unauthorized('missing_token', 'Authorization header missing'));
    }
    try {
        const payload = verifyAccessToken(token);
        req.user = { id: parseInt(payload.sub, 10), role: payload.role };
        next();
    } catch (err) {
        next(err);
    }
}

function requireRole(...roles) {
    return (req, _res, next) => {
        if (!req.user) return next(errors.unauthorized('not_authenticated', 'Login required'));
        if (!roles.includes(req.user.role)) {
            return next(errors.forbidden('forbidden', 'Insufficient role'));
        }
        next();
    };
}

module.exports = { requireAuth, requireRole };
