const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');

function signAccessToken(payload) {
    return jwt.sign({ ...payload, jti: crypto.randomBytes(8).toString('hex') }, config.jwt.accessSecret, {
        expiresIn: config.jwt.accessTTL,
    });
}

function signRefreshToken(payload) {
    return jwt.sign({ ...payload, jti: crypto.randomBytes(16).toString('hex') }, config.jwt.refreshSecret, {
        expiresIn: `${config.jwt.refreshTTLDays}d`,
    });
}

function verifyAccessToken(token) {
    return jwt.verify(token, config.jwt.accessSecret);
}

function verifyRefreshToken(token) {
    return jwt.verify(token, config.jwt.refreshSecret);
}

function sha256(input) {
    return crypto.createHash('sha256').update(input).digest('hex');
}

function randomCode(length = 6) {
    const buf = crypto.randomBytes(length);
    let out = '';
    for (let i = 0; i < length; i++) out += buf[i] % 10;
    return out;
}

module.exports = {
    signAccessToken,
    signRefreshToken,
    verifyAccessToken,
    verifyRefreshToken,
    sha256,
    randomCode,
};
