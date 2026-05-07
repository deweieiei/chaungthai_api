// Run with: npm run db:test
const db = require('../src/db');

(async () => {
    try {
        const v = await db.queryOne('SELECT VERSION() AS version, NOW() AS now, DATABASE() AS db');
        console.log('[ok] connected');
        console.log('     version:', v.version);
        console.log('     time   :', v.now);
        console.log('     db     :', v.db);

        const tables = await db.query("SHOW TABLES");
        console.log(`     tables : ${tables.length}`);
        tables.forEach(t => console.log('       -', Object.values(t)[0]));
    } catch (err) {
        console.error('[fail]', err.code || err.name, '-', err.message);
        process.exitCode = 1;
    } finally {
        await db.pool.end();
    }
})();
