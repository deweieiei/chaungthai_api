// PM2 config — only used when running via `pm2 start ecosystem.config.cjs`.
// For dev / portable runs, just use `node server.js` directly.

module.exports = {
    apps: [
        {
            name: 'chaungthai-api',
            script: 'server.js',
            instances: 1,
            exec_mode: 'fork',
            autorestart: true,
            watch: false,
            max_memory_restart: '512M',
            env: {
                NODE_ENV: 'production',
            },
            out_file:  './logs/out.log',
            error_file:'./logs/err.log',
            time: true,
        },
    ],
};
