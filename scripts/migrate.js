// Run all *.sql files under sql/ in order.
// Usage: npm run db:migrate
const fs = require('fs');
const path = require('path');
const db = require('../src/db');

(async () => {
    const sqlDir = path.join(__dirname, '..', 'sql');
    const files = fs.readdirSync(sqlDir)
        .filter(f => f.endsWith('.sql'))
        .sort();

    if (files.length === 0) {
        console.log('No .sql files in', sqlDir);
        return;
    }

    for (const file of files) {
        console.log('==>', file);
        let content = fs.readFileSync(path.join(sqlDir, file), 'utf8');

        // Strip line comments ("-- foo") and block comments ("/* foo */"),
        // then split on ";" terminators.
        content = content
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*--.*$/gm, '');

        const statements = content
            .split(';')
            .map(s => s.trim())
            .filter(Boolean);

        for (const stmt of statements) {
            try {
                await db.query(stmt);
                process.stdout.write('.');
            } catch (err) {
                console.error('\n[error]', err.code, err.sqlMessage || err.message);
                console.error('Statement:\n', stmt.slice(0, 200));
                process.exitCode = 1;
                await db.pool.end();
                return;
            }
        }
        console.log(' ok');
    }
    console.log('done');
    await db.pool.end();
})();
