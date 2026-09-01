const mysql = require('mysql2/promise');
require('dotenv').config();

async function checkCols() {
    try {
        const connection = await mysql.createConnection({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASS,
            database: process.env.DB_NAME,
            port: process.env.DB_PORT || 3306
        });

        const [rows] = await connection.execute('DESCRIBE attendance_logs;');
        console.log('Ga jerin columns din da suke cikin attendance_logs:');
        console.table(rows);

        await connection.end();
    } catch (err) {
        console.error('Kuskure:', err.message);
    }
}

checkCols();