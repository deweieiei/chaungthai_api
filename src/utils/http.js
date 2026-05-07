// Lightweight HTTP error class. Throw this from route handlers
// and let middleware/error.js convert to a JSON response.

class HttpError extends Error {
    constructor(status, code, message, details) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details;
    }
}

const errors = {
    badRequest:   (code, msg, details) => new HttpError(400, code, msg, details),
    unauthorized: (code, msg)          => new HttpError(401, code, msg),
    forbidden:    (code, msg)          => new HttpError(403, code, msg),
    notFound:     (code, msg)          => new HttpError(404, code, msg),
    conflict:     (code, msg)          => new HttpError(409, code, msg),
    tooMany:      (code, msg)          => new HttpError(429, code, msg),
    server:       (code, msg)          => new HttpError(500, code, msg),
};

const asyncHandler = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { HttpError, errors, asyncHandler };
