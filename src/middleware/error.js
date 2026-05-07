const config = require('../config');
const { HttpError } = require('../utils/http');

// 404 — must be registered after all routes
function notFound(req, res, next) {
    next(new HttpError(404, 'not_found', `Route ${req.method} ${req.path} not found`));
}

// Central error handler
function handler(err, req, res, _next) {
    if (err instanceof HttpError) {
        return res.status(err.status).json({
            ok: false,
            error: { code: err.code, message: err.message, details: err.details },
        });
    }

    if (err && err.name === 'ZodError') {
        return res.status(400).json({
            ok: false,
            error: {
                code: 'validation_error',
                message: 'Invalid request body',
                details: err.errors,
            },
        });
    }

    if (err && err.name === 'JsonWebTokenError') {
        return res.status(401).json({
            ok: false,
            error: { code: 'invalid_token', message: 'Invalid token' },
        });
    }
    if (err && err.name === 'TokenExpiredError') {
        return res.status(401).json({
            ok: false,
            error: { code: 'token_expired', message: 'Token expired' },
        });
    }

    console.error('[error]', err);
    res.status(500).json({
        ok: false,
        error: {
            code: 'internal_error',
            message: config.env === 'production' ? 'Internal server error' : err.message,
        },
    });
}

module.exports = { notFound, handler };
