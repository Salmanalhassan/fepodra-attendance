const mysql = require('mysql2');
require('dotenv').config();

// Duba ko ana amfani da Localhost ne ko Aiven
const isLocal = process.env.DB_HOST === 'localhost' || process.env.DB_HOST === '127.0.0.1';

const dbConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS || process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

// Idan ba Localhost ba ne (wato Aiven ne), sannan a sanya SSL
if (!isLocal) {
    dbConfig.ssl = {
        rejectUnauthorized: false
    };
}

const pool = mysql.createPool(dbConfig);
const promisePool = pool.promise();

async function initializeDatabase() {
    try {
        // 1. Tebur din Users
        await promisePool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                portal_id VARCHAR(50) UNIQUE NOT NULL,
                fullname VARCHAR(100) NOT NULL,
                password VARCHAR(255) NOT NULL,
                role ENUM('admin', 'lecturer', 'student') NOT NULL,
                registered_by VARCHAR(50) DEFAULT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 2. Tebur din Sessions
        await promisePool.query(`
            CREATE TABLE IF NOT EXISTS sessions (
                id INT AUTO_INCREMENT PRIMARY KEY,
                course_code VARCHAR(50) NOT NULL,
                lecturer_id VARCHAR(50) NOT NULL,
                qr_token VARCHAR(255) NOT NULL,
                is_active BOOLEAN DEFAULT TRUE,
                expires_at DATETIME NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 3. Tebur din Attendance Logs
        await promisePool.query(`
            CREATE TABLE IF NOT EXISTS attendance_logs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                session_id INT NOT NULL,
                student_id VARCHAR(50) NOT NULL,
                scanned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            )
        `);

       // Gyara na musamman: Canza tsohon column 'student' zuwa 'student_id' idan akwai shi
        try {
            await promisePool.query(`ALTER TABLE attendance_logs CHANGE COLUMN student student_id VARCHAR(50);`);
            console.log('An nasarar canza column din student zuwa student_id a cikin attendance_logs!');
        } catch (e) {
            console.log('Bayani kan ALTER TABLE:', e.message);
        }

        console.log('Database tables verified/created successfully!');
    } catch (err) {
        console.error('Error creating database tables:', err.message);
    }
}

// Gwada haɗin database & Gini tables
pool.getConnection((err, connection) => {
    if (err) {
        console.error('Database connection failed: ', err.message);
    } else {
        console.log(`Connected to MySQL Database successfully (${isLocal ? 'Localhost' : 'Aiven Remote'})!`);
        connection.release();
        initializeDatabase();
    }
});

module.exports = promisePool;