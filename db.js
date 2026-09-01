const mysql = require('mysql2');
require('dotenv').config();

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    ssl: {
        rejectUnauthorized: false
    }
});

const promisePool = pool.promise();

// Aiki na musamman na ƙirƙirar Tables ta atomatik idan babu su
async function initializeDatabase() {
    try {
        // 1. Tebur din Users (Admin, Lecturers, da Students)
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

        // 2. Tebur din Sessions (Na QR Codes da malamai suke buɗewa)
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

        // 3. Tebur din Attendance Logs (Na adana halartar dalibai)
        await promisePool.query(`
            CREATE TABLE IF NOT EXISTS attendance_logs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                session_id INT NOT NULL,
                student_id VARCHAR(50) NOT NULL,
                scanned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            )
        `);

        console.log('Database tables verified/created successfully!');
    } catch (err) {
        console.error('Error creating database tables:', err.message);
    }
}

// Test the database connection & Initialize tables
pool.getConnection((err, connection) => {
    if (err) {
        console.error('Database connection failed: ', err.message);
    } else {
        console.log('Connected to Aiven MySQL Database successfully!');
        connection.release();
        initializeDatabase(); // Kira aikin gina teburan nan take
    }
});

module.exports = promisePool;