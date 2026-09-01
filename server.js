const express = require('express');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const session = require('express-session');
require('dotenv').config();

const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// Sanya Session Middleware
app.use(session({
    secret: 'fepodra_secret_key_attendance_portal',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
}));

// Set View Engine to EJS
app.set('view engine', 'ejs');

// Test Route
//app.get('/', (req, res) => {
 //   res.redirect('/login');
//});
// Landing Page Route (Wannan ita ce shafin farko da mutum zai gani)
app.get('/', (req, res) => {
    res.render('landing');
});


// Render Login Page
app.get('/login', (req, res) => {
    res.render('login');
});

app.post('/login', async (req, res) => {
    const { portal_id, password } = req.body;

    try {
        const [rows] = await db.query('SELECT * FROM users WHERE portal_id = ? AND password = ?', [portal_id, password]);

        if (rows.length === 0) {
            return res.render('login', { error: 'Invalid Portal ID or Password' });
        }

        const user = rows[0];

        // Ajiye bayanan user a cikin session
        req.session.user = user;

        if (user.role === 'student') {
            const [attendanceSummary] = await db.query(`
                SELECT sessions.course_code, COUNT(attendance_logs.id) as total_present 
                FROM attendance_logs 
                JOIN sessions ON attendance_logs.session_id = sessions.id 
                WHERE attendance_logs.student_id = ? 
                GROUP BY sessions.course_code
            `, [user.portal_id]);

            res.render('student-dashboard', { user, attendanceSummary });

        } else if (user.role === 'lecturer') {
            res.redirect('/lecturer/dashboard');
        } else if (user.role === 'admin') {
            res.redirect('/admin/dashboard');
        }

    } catch (err) {
        console.error(err);
        res.render('login', { error: 'Server error. Please try again.' });
    }
});

// Helper function to fetch dashboard stats and students list (Wadanda lecturer da kansa ya yi musu register)
async function getLecturerDashboardData(lecturerId) {
    // 1. Dauko daliban da wannan lecturer din ya yi musu register kaɗai
    const [studentRows] = await db.query(
        'SELECT portal_id, fullname, created_at FROM users WHERE role = "student" AND registered_by = ? ORDER BY id DESC',
        [lecturerId]
    );
    const totalStudents = studentRows.length;

    // 2. Today's Present (Lissafa yawan daliban da suka yi attendance a ajin WANNAN LECTURER din a yau)
    const [presentRows] = await db.query(`
        SELECT COUNT(DISTINCT attendance_logs.student_id) as count 
        FROM attendance_logs 
        JOIN sessions ON attendance_logs.session_id = sessions.id 
        WHERE sessions.lecturer_id = ? AND DATE(attendance_logs.scanned_at) = CURDATE()
    `, [lecturerId]);
    const todaysPresent = presentRows[0].count || 0;

    // 3. Active Sessions Count (Wadanda suka shafi WANNAN LECTURER din kuma ba su wuce minti 5 ba)
    const [sessionRows] = await db.query(
        'SELECT COUNT(*) as count FROM sessions WHERE lecturer_id = ? AND is_active = TRUE AND expires_at > NOW()', 
        [lecturerId]
    );
    const activeSessionsCount = sessionRows[0].count || 0;

    return {
        students: studentRows,
        totalStudents,
        todaysPresent,
        activeSessionsCount
    };
}
app.get('/lecturer/dashboard', async (req, res) => {
    try {
        // Tabbatar cewa akwai lecturer da ya yi login
        if (!req.session.user || req.session.user.role !== 'lecturer') {
            return res.redirect('/login');
        }

        const lecturerId = req.session.user.portal_id;
        const lecturerName = req.session.user.fullname;

        const stats = await getLecturerDashboardData(lecturerId);
        const currentUser = { fullname: lecturerName, portal_id: lecturerId };
        
        res.render('lecturer-dashboard', { 
            user: currentUser,
            students: stats.students,
            totalStudents: stats.totalStudents,
            todaysPresent: stats.todaysPresent,
            activeSessionsCount: stats.activeSessionsCount
        });
    } catch (err) {
    console.error(err);
    res.status(500).send('Error loading lecturer dashboard: ' + err.message);
}
});

app.post('/lecturer/generate-qr', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'lecturer') {
        return res.redirect('/login');
    }

    // Karɓar course_code da kuma duration da malami ya zaɓo
    const { course_code, duration } = req.body;
    const lecturer_id = req.session.user.portal_id; 

    // Tabbatar an sanya lokaci, idan babu a sanya minti 5 a matsayin tsohon tsari
    const validDuration = parseInt(duration) || 5;

    const token = crypto.randomBytes(32).toString('hex');

    try {
        // Amfani da validDuration wajen ƙara lokacin karewa (expires_at)
        const [result] = await db.query(
            `INSERT INTO sessions (course_code, lecturer_id, qr_token, is_active, expires_at) 
             VALUES (?, ?, ?, TRUE, DATE_ADD(NOW(), INTERVAL ? MINUTE))`,
            [course_code, lecturer_id, token, validDuration]
        );

        const sessionId = result.insertId;
        const checkInUrl = `http://localhost:3000/student/check-in?session=${sessionId}&token=${token}`;

        QRCode.toDataURL(checkInUrl, async (err, qrCodeImage) => {
            if (err) {
                console.error(err);
                return res.status(500).send('Error generating QR code');
            }

            const stats = await getLecturerDashboardData(lecturer_id);

            res.render('lecturer-dashboard', { 
                user: req.session.user, 
                qrCodeImage, 
                course_code, 
                token,
                sessionId,
                students: stats.students,
                totalStudents: stats.totalStudents,
                todaysPresent: stats.todaysPresent,
                activeSessionsCount: stats.activeSessionsCount
            });
        });

    } catch (err) {
        console.error(err);
        res.status(500).send('Database error during session creation.');
    }
});

// Handle Lecturer Registering a New Student with Error Handling
app.post('/lecturer/register-student', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'lecturer') {
        return res.redirect('/login');
    }

    const { portal_id, fullname, password } = req.body;
    const lecturer_id = req.session.user.portal_id;

    try {
        await db.query(
            'INSERT INTO users (portal_id, fullname, password, role, registered_by) VALUES (?, ?, ?, "student", ?)',
            [portal_id, fullname, password, lecturer_id]
        );
        // Idan komai ya tafi daidai, ka dawo da shi dashboard tare da sakon nasara (optional)
        res.redirect('/lecturer/dashboard?success=Student registered successfully');
    } catch (err) {
        console.error(err);
        // Maimakon crash ko fita page daban, ka sake dawo da shi dashboard tare da error message
        // Lura: Zaka iya amfani da EJS template ko wani variable idan kana render dashboard din daga nan.
        res.render('lecturer-dashboard', { 
            error: 'This Portal ID already exists! Please check and try another one.',
            user: req.session.user 
        });
    }
});



// Render Edit Student Page
app.get('/lecturer/edit-student', async (req, res) => {
    const portal_id = req.query.portal_id;
    try {
        const [rows] = await db.query('SELECT * FROM users WHERE portal_id = ? AND role = "student"', [portal_id]);
        if (rows.length === 0) {
            return res.send('Student not found');
        }
        res.render('edit-student', { student: rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error loading edit page');
    }
});

// Handle Update Student Form Submission
app.post('/lecturer/update-student', async (req, res) => {
    const { portal_id, fullname, password } = req.body;

    try {
        await db.query(
            'UPDATE users SET fullname = ?, password = ? WHERE portal_id = ? AND role = "student"',
            [fullname, password, portal_id]
        );
        res.redirect('/lecturer/dashboard');
    } catch (err) {
        console.error(err);
        res.status(500).send('Error updating student');
    }
});

// Handle Delete Student
app.post('/lecturer/delete-student', async (req, res) => {
    const { portal_id } = req.body;

    try {
        await db.query('DELETE FROM attendance_logs WHERE student_id = ?', [portal_id]);
        await db.query('DELETE FROM users WHERE portal_id = ? AND role = "student"', [portal_id]);
        
        res.redirect('/lecturer/dashboard');
    } catch (err) {
        console.error(err);
        res.status(500).send('Error deleting student');
    }
});

// Student Check-In Link (Binciken ko lokacin minti 5 ya wuce)
app.get('/student/check-in', async (req, res) => {
    const { session, token } = req.query;

    try {
        const [rows] = await db.query(
            'SELECT * FROM sessions WHERE id = ? AND qr_token = ? AND is_active = TRUE AND expires_at > NOW()', 
            [session, token]
        );

        if (rows.length === 0) {
            // Maimakon res.send() mai ban haushi, zamu iya bashi shafin check-in din amma tare da sako cewa lokaci ya wuce
            return res.render('student-checkin', { 
                session: { id: session, course_code: 'EXPIRED' },
                error: 'Invalid or Expired Attendance Session! ( QR Code has reached its time minutes)' 
            });
        }

        const activeSession = rows[0];
        res.render('student-checkin', { session: activeSession });

    } catch (err) {
        console.error(err);
        res.status(500).send('Server error loading check-in page');
    }
});




// Handle Student Attendance Confirmation Form (AJAX / JSON Response)
app.post('/student/confirm-check-in', async (req, res) => {
    const { session_id, token, student_id } = req.body;

    try {
        const [sessionRows] = await db.query(
            'SELECT * FROM sessions WHERE id = ? AND qr_token = ? AND is_active = TRUE AND expires_at > NOW()', 
            [session_id, token]
        );

        if (sessionRows.length === 0) {
            return res.status(400).json({ 
                success: false, 
                message: 'Invalid or Expired Attendance Session! (sorry! time is gone)' 
            });
        }

        const [studentRows] = await db.query('SELECT * FROM users WHERE portal_id = ? AND role = "student"', [student_id]);

        if (studentRows.length === 0) {
            return res.status(400).json({ 
                success: false, 
                message: 'Invalid Student Portal ID. Please check and try again.' 
            });
        }

        // Bincike ko dalibi ya riga ya yi marking a wannan session din (Hana sau biyu)
        const [existingLog] = await db.query('SELECT * FROM attendance_logs WHERE session_id = ? AND student_id = ?', [session_id, student_id]);

        if (existingLog.length > 0) {
            return res.status(400).json({ 
                success: false, 
                message: 'Attendance already recorded for this student in this session!' 
            });
        }

        // Idan bai yi ba tukuna, rubuta shi a database
        await db.query('INSERT INTO attendance_logs (session_id, student_id) VALUES (?, ?)', [session_id, student_id]);

        return res.status(200).json({ 
            success: true, 
            message: 'Attendance successfully marked! Thank you.' 
        });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ 
            success: false, 
            message: 'Server error recording attendance.' 
        });
    }
});


// View Attendance Logs for a Specific Session
app.get('/lecturer/session-reports/:sessionId', async (req, res) => {
    const { sessionId } = req.params;

    try {
        const [sessionRows] = await db.query('SELECT * FROM sessions WHERE id = ?', [sessionId]);
        if (sessionRows.length === 0) {
            return res.send('Session not found');
        }
        const activeSession = sessionRows[0];

        const [logs] = await db.query(`
            SELECT users.portal_id, users.fullname, attendance_logs.scanned_at 
            FROM attendance_logs 
            JOIN users ON attendance_logs.student_id = users.portal_id 
            WHERE attendance_logs.session_id = ?
        `, [sessionId]);

        res.render('session-report', { session: activeSession, logs });

    } catch (err) {
        console.error(err);
        res.status(500).send('Error loading session reports');
    }
});

// Render Admin Dashboard & Fetch Users (Admin yana ganin duka dalibai)
app.get('/admin/dashboard', async (req, res) => {
    try {
        const [users] = await db.query('SELECT portal_id, fullname, role, created_at FROM users ORDER BY id DESC');
        res.render('admin-dashboard', { users });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error loading admin dashboard');
    }
});

// Handle Registering New User by Admin
app.post('/admin/register-user', async (req, res) => {
    const { portal_id, fullname, password, role } = req.body;

    try {
        await db.query(
            'INSERT INTO users (portal_id, fullname, password, role) VALUES (?, ?, ?, ?)',
            [portal_id, fullname, password, role]
        );

        const [users] = await db.query('SELECT portal_id, fullname, role, created_at FROM users ORDER BY id DESC');
        res.render('admin-dashboard', { users, success: 'User registered successfully!' });

    } catch (err) {
        console.error(err);
        res.status(500).send('Error registering user (Portal ID might already exist)');
    }
});

app.get('/lecturer/semester-summary', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'lecturer') {
        return res.redirect('/login');
    }

    const lecturer_id = req.session.user.portal_id;

    try {
        // Dauko jimillar kwanaki (Unique Dates) da WANNAN LECTURER din ya buɗe sessions
        const [totalDaysResult] = await db.query(
            'SELECT COUNT(DISTINCT DATE(created_at)) as total_days FROM sessions WHERE lecturer_id = ?',
            [lecturer_id]
        );
        const totalSessions = totalDaysResult[0].total_days || 0;

        // Dauko DUKKAN daliban da suka taɓa yin attendance a aji ko ɗaya na WANNAN LECTURER din
        const [students] = await db.query(`
            SELECT DISTINCT users.portal_id, users.fullname 
            FROM attendance_logs 
            JOIN sessions ON attendance_logs.session_id = sessions.id 
            JOIN users ON attendance_logs.student_id = users.portal_id 
            WHERE sessions.lecturer_id = ?
        `, [lecturer_id]);

        const studentSummary = [];
        for (const student of students) {
            const [presentResult] = await db.query(`
                SELECT COUNT(DISTINCT DATE(attendance_logs.scanned_at)) as present_days 
                FROM attendance_logs 
                JOIN sessions ON attendance_logs.session_id = sessions.id 
                WHERE sessions.lecturer_id = ? AND attendance_logs.student_id = ?
            `, [lecturer_id, student.portal_id]);

            const present = presentResult[0].present_days || 0;
            const absent = totalSessions - present;

            studentSummary.push({
                portal_id: student.portal_id,
                fullname: student.fullname,
                present: present,
                absent: absent < 0 ? 0 : absent
            });
        }

        res.render('semester-summary', { 
            studentSummary, 
            totalSessions 
        });

    } catch (err) {
        console.error(err);
        res.status(500).send('Error loading semester summary report');
    }
});





// 1. Route na share (Delete) mai amfani ta Query Parameter
app.post('/admin/delete-user', async (req, res) => {
    try {
        const portalId = req.body.portal_id;
        await db.query('DELETE FROM users WHERE portal_id = ?', [portalId]);
        res.redirect('/admin/dashboard');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error during deletion');
    }
});

// 2. Route na buɗe shafin Edit (GET) ta Query Parameter
app.get('/admin/edit-user', async (req, res) => {
    try {
        const portalId = req.query.id;
        const [users] = await db.query('SELECT * FROM users WHERE portal_id = ?', [portalId]);
        
        if (users.length === 0) {
            return res.status(404).send('User not found');
        }
        
        res.render('edit-user', { user: users[0], success: null });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

// 3. Route na adana sauye-sauye (POST) bayan an yi Edit
app.post('/admin/edit-user', async (req, res) => {
    try {
        const { portal_id, fullname, role } = req.body;

        await db.query('UPDATE users SET fullname = ?, role = ? WHERE portal_id = ?', [fullname, role, portal_id]);
        
        res.redirect('/admin/dashboard');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error during update');
    }
});




// Start Server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});