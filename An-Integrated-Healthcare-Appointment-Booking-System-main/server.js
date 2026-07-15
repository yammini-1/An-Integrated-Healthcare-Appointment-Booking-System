// server.js
require('dotenv').config();
const express = require('express');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const multer = require('multer');
const db = require('./db');
const crypto = require('crypto');
const { sendMail } = require('./mailer');

const app = express();
const PORT = process.env.PORT || 3000;

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Body parser
app.use(express.urlencoded({ extended: true }));

// Session
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev_secret',
    resave: false,
    saveUninitialized: false
  })
);

// ========== File Upload (Doctor Photos) ==========
const uploadDir = path.join(__dirname, 'public', 'uploads', 'doctors');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const safeName = file.fieldname + '-' + Date.now() + ext;
    cb(null, safeName);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed'));
    }
    cb(null, true);
  }
});

// Expose user & flash messages to views
app.use(async (req, res, next) => {
  res.locals.currentUser = null;    // patient / admin
  res.locals.isAdmin = false;
  res.locals.currentDoctor = null;  // doctor portal
  res.locals.error = null;
  res.locals.success = null;

  try {
    // Patient / admin user
    if (req.session.userId) {
      const [rows] = await db.query(
        'SELECT id, name, email, role FROM users WHERE id = ?',
        [req.session.userId]
      );
      if (rows.length) {
        req.user = rows[0];
        res.locals.currentUser = rows[0];
        res.locals.isAdmin = rows[0].role === 'admin';
      } else {
        delete req.session.userId;
      }
    }

    // Doctor portal user
    if (req.session.doctorId) {
      const [drows] = await db.query(
        'SELECT id, name, email, is_active FROM doctors WHERE id = ?',
        [req.session.doctorId]
      );
      if (drows.length && drows[0].is_active) {
        req.doctor = drows[0];
        res.locals.currentDoctor = drows[0];
      } else {
        delete req.session.doctorId;
      }
    }
  } catch (err) {
    console.error('User/Doctor lookup error:', err);
  }

  if (req.session.error) {
    res.locals.error = req.session.error;
    delete req.session.error;
  }
  if (req.session.success) {
    res.locals.success = req.session.success;
    delete req.session.success;
  }

  // NEW: time-based greeting
  res.locals.timeGreeting = getTimeGreeting();

  next();
});

// Auth middleware
function requireLogin(req, res, next) {
  if (!req.session.userId) {
    req.session.error = 'Please log in to continue.';
    return res.redirect('/login');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.userId || !req.user || req.user.role !== 'admin') {
    return res.status(403).send('Forbidden');
  }
  next();
}

function requireDoctor(req, res, next) {
  if (!req.session.doctorId) {
    return res.redirect('/login');
  }
  next();
}

function getHHMM(t) {
  if (!t) return null;
  if (typeof t === 'string') return t.slice(0, 5);
  if (t instanceof Date) return t.toTimeString().slice(0, 5);
  return String(t).slice(0, 5);
}

function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function minutesToHHMM(mins) {
  const h = String(Math.floor(mins / 60)).padStart(2, '0');
  const m = String(mins % 60).padStart(2, '0');
  return `${h}:${m}`;
}

// ==== Date / Time format helpers for EJS ====
function formatDate(d) {
  if (!d) return '';
  if (typeof d === 'string') return d; // 'YYYY-MM-DD'
  // JS Date object -> local date
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatTime(t) {
  if (!t) return '';
  if (typeof t === 'string') return t.slice(0, 5);
  return t.toString().slice(0, 5);
}

// EJS se direct use ke liye
app.locals.formatDate = formatDate;
app.locals.formatTime = formatTime;

function toCsvValue(v) {
  if (v === null || v === undefined) return '""';
  const s = String(v).replace(/"/g, '""');
  return `"${s}"`;
}

function getTimeGreeting() {
  const hour = new Date().getHours(); // 0–23

  if (hour < 5) {
    return 'Good night';
  } else if (hour < 12) {
    return 'Good morning';
  } else if (hour < 17) {
    return 'Good afternoon';
  } else if (hour < 21) {
    return 'Good evening';
  } else {
    return 'Good night';
  }
}

/* ============ ROUTES ============ */

// Home
app.get('/', async (req, res) => {
  try {
    const [specialties] = await db.query(
      'SELECT * FROM specialties ORDER BY name'
    );
    const [doctors] = await db.query(
      `SELECT d.*, s.name AS specialty_name
       FROM doctors d
       JOIN specialties s ON d.specialty_id = s.id
       ORDER BY d.id
       LIMIT 6`
    );

    let favoriteDoctorIds = [];
    if (req.session.userId) {
      const [favRows] = await db.query(
        'SELECT doctor_id FROM favorites WHERE user_id = ?',
        [req.session.userId]
      );
      favoriteDoctorIds = favRows.map(r => r.doctor_id);
    }

    res.render('home', { specialties, doctors, favoriteDoctorIds });
  } catch (err) {
    console.error('Home error:', err);
    res.status(500).send('Server error');
  }
});

// Registration
app.get('/register', (req, res) => {
  res.render('register');
});

app.post('/register', async (req, res) => {
  let { name, email, password, confirmPassword } = req.body;

  // Trim
  name = (name || '').trim();
  email = (email || '').trim().toLowerCase();

  if (!name || !email || !password || !confirmPassword) {
    req.session.error = 'All fields are required.';
    return res.redirect('/register');
  }

  if (name.length < 3) {
    req.session.error = 'Name must be at least 3 characters long.';
    return res.redirect('/register');
  }

  // Basic email regex
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    req.session.error = 'Please enter a valid email address.';
    return res.redirect('/register');
  }

  if (password !== confirmPassword) {
    req.session.error = 'Passwords do not match.';
    return res.redirect('/register');
  }

  if (password.length < 8) {
    req.session.error = 'Password must be at least 8 characters long.';
    return res.redirect('/register');
  }

  try {
    const [existing] = await db.query('SELECT * FROM users WHERE email = ?', [email]);

    if (existing.length && existing[0].is_verified) {
      req.session.error = 'Email already registered.';
      return res.redirect('/register');
    }

    const hash = await bcrypt.hash(password, 10);
    const code = String(Math.floor(100000 + Math.random() * 900000)); // OTP

    if (existing.length && !existing[0].is_verified) {
      await db.query(
        `UPDATE users
         SET name = ?, password_hash = ?, verification_code = ?, verification_expires = DATE_ADD(NOW(), INTERVAL 15 MINUTE)
         WHERE id = ?`,
        [name, hash, code, existing[0].id]
      );
    } else {
      await db.query(
        `INSERT INTO users (name, email, password_hash, role, is_verified, verification_code, verification_expires)
         VALUES (?, ?, ?, 'user', 0, ?, DATE_ADD(NOW(), INTERVAL 15 MINUTE))`,
        [name, email, hash, code]
      );
    }

    const subject = 'Your MediBook verification code';
    const html = `
      <p>Hi ${name},</p>
      <p>Your MediBook verification code is:</p>
      <h2>${code}</h2>
      <p>This code will expire in 15 minutes.</p>
      <p>If you did not create this account, you can ignore this email.</p>
      <p>– MediBook</p>
    `;

    await sendMail({ to: email, subject, html });

    req.session.pendingEmail = email;
    req.session.success = 'Verification code sent to your email. Please enter the code to complete registration.';
    res.redirect('/verify-email-code');
  } catch (err) {
    console.error('Register error:', err);
    req.session.error = 'Registration failed.';
    res.redirect('/register');
  }
});

// Show OTP verification page
app.get('/verify-email-code', (req, res) => {
  const email = req.session.pendingEmail;
  if (!email) {
    req.session.error = 'No verification in progress.';
    return res.redirect('/login');
  }
  res.render('verify_email_code', { email });
});

// Handle OTP verification
app.post('/verify-email-code', async (req, res) => {
  const email = req.session.pendingEmail;
  const { code } = req.body;

  if (!email) {
    req.session.error = 'No verification in progress.';
    return res.redirect('/login');
  }
  if (!code) {
    req.session.error = 'Please enter the verification code.';
    return res.redirect('/verify-email-code');
  }

  try {
    const [rows] = await db.query(
      `SELECT id, is_verified, verification_code, verification_expires
       FROM users
       WHERE email = ? AND role = 'user'`,
      [email]
    );

    if (!rows.length) {
      req.session.error = 'Account not found. Please register again.';
      delete req.session.pendingEmail;
      return res.redirect('/register');
    }

    const user = rows[0];

    if (user.is_verified) {
      // Already verified
      delete req.session.pendingEmail;
      req.session.success = 'Email already verified. You can login now.';
      return res.redirect('/login');
    }

    const now = new Date();
    if (!user.verification_expires || user.verification_expires < now) {
      req.session.error = 'Verification code expired. Please register again.';
      delete req.session.pendingEmail;
      return res.redirect('/register');
    }

    if (user.verification_code !== code.trim()) {
      req.session.error = 'Incorrect verification code.';
      return res.redirect('/verify-email-code');
    }

    // Code sahi hai
    await db.query(
      `UPDATE users
       SET is_verified = 1, verification_code = NULL, verification_expires = NULL
       WHERE id = ?`,
      [user.id]
    );

    delete req.session.pendingEmail;
    req.session.success = 'Email verified successfully. You can now log in.';
    res.redirect('/login');
  } catch (err) {
    console.error('Verify email code error:', err);
    req.session.error = 'Failed to verify code.';
    res.redirect('/verify-email-code');
  }
});

// Login
app.get('/login', (req, res) => {
  res.render('login');
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    req.session.error = 'Email and password are required.';
    return res.redirect('/login');
  }

  try {
    // 1) Try as normal user / admin
    const [userRows] = await db.query('SELECT * FROM users WHERE email = ?', [email]);

    if (userRows.length) {
      const user = userRows[0];
      const match = await bcrypt.compare(password, user.password_hash);
      if (match) {
        // Agar normal user hai aur verify nahi hua
        if (user.role === 'user' && !user.is_verified) {
          req.session.pendingEmail = user.email;
          req.session.error = 'Please verify your email with the code sent to you.';
          return res.redirect('/verify-email-code');
        }

        // User/admin login success
        delete req.session.doctorId;
        req.session.userId = user.id;

        if (user.role === 'admin') {
          req.session.success = 'Admin login successful.';
          return res.redirect('/admin');
        } else {
          req.session.success = 'Logged in successfully.';
          return res.redirect('/');
        }
      }
    }

    // 2) Try as doctor
    const [docRows] = await db.query(
      'SELECT * FROM doctors WHERE email = ? AND is_active = 1',
      [email]
    );

    if (docRows.length) {
      const doctor = docRows[0];
      if (!doctor.password_hash) {
        req.session.error = 'Doctor password not set. Contact admin.';
        return res.redirect('/login');
      }

      const matchDoc = await bcrypt.compare(password, doctor.password_hash);
      if (matchDoc) {
        // Doctor login success
        delete req.session.userId;        // ensure patient/admin session clear
        req.session.doctorId = doctor.id;
        req.session.success = 'Doctor login successful.';
        return res.redirect('/doctor/dashboard');
      }
    }

    // Dono tables me nahi mila / password match nahi hua
    req.session.error = 'Invalid email or password.';
    res.redirect('/login');
  } catch (err) {
    console.error('Login error:', err);
    req.session.error = 'Login failed.';
    res.redirect('/login');
  }
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

// Show forgot password page
app.get('/forgot-password', (req, res) => {
  res.render('forgot_password');
});

// Handle forgot password: send 6-digit code
app.post('/forgot-password', async (req, res) => {
  const { email } = req.body;

  if (!email || !email.trim()) {
    req.session.error = 'Please enter your email.';
    return res.redirect('/forgot-password');
  }

  const cleanEmail = email.trim().toLowerCase();

  try {
    const [rows] = await db.query(
      'SELECT id, name, role FROM users WHERE email = ?',
      [cleanEmail]
    );

    // Hamesha generic message – security ke liye (email exist ho ya na ho)
    const genericMsg = 'If an account exists for this email, a reset code has been sent.';

    if (!rows.length) {
      req.session.success = genericMsg;
      return res.redirect('/forgot-password');
    }

    const user = rows[0];

    // 6-digit code
    const code = String(Math.floor(100000 + Math.random() * 900000));

    await db.query(
      `UPDATE users
       SET reset_code = ?, reset_expires = DATE_ADD(NOW(), INTERVAL 15 MINUTE)
       WHERE id = ?`,
      [code, user.id]
    );

    const subject = 'Your MediBook password reset code';
    const html = `
      <p>Hi ${user.name},</p>
      <p>Your password reset code is:</p>
      <h2>${code}</h2>
      <p>This code will expire in 15 minutes.</p>
      <p>If you did not request a password reset, you can ignore this email.</p>
      <p>– MediBook</p>
    `;

    await sendMail({ to: cleanEmail, subject, html });

    req.session.resetEmail = cleanEmail;
    req.session.success = genericMsg;
    res.redirect('/reset-password');
  } catch (err) {
    console.error('Forgot password error:', err);
    req.session.error = 'Failed to start password reset.';
    res.redirect('/forgot-password');
  }
});

// Show reset password page (code + new password)
app.get('/reset-password', (req, res) => {
  const email = req.session.resetEmail;
  if (!email) {
    req.session.error = 'No reset request found. Please use "Forgot password" again.';
    return res.redirect('/forgot-password');
  }
  res.render('reset_password', { email });
});

// Handle reset password submit
app.post('/reset-password', async (req, res) => {
  const email = req.session.resetEmail;
  const { code, password, confirmPassword } = req.body;

  if (!email) {
    req.session.error = 'No reset request found. Please use "Forgot password" again.';
    return res.redirect('/forgot-password');
  }

  if (!code || !password || !confirmPassword) {
    req.session.error = 'All fields are required.';
    return res.redirect('/reset-password');
  }

  if (password !== confirmPassword) {
    req.session.error = 'Passwords do not match.';
    return res.redirect('/reset-password');
  }

  // Basic password strength (>=8 chars)
  if (password.length < 8) {
    req.session.error = 'Password must be at least 8 characters long.';
    return res.redirect('/reset-password');
  }

  try {
    const [rows] = await db.query(
      `SELECT id, name, reset_code, reset_expires
       FROM users
       WHERE email = ?`,
      [email]
    );

    if (!rows.length) {
      req.session.error = 'Account not found. Please register.';
      delete req.session.resetEmail;
      return res.redirect('/register');
    }

    const user = rows[0];

    if (!user.reset_code || !user.reset_expires || user.reset_code !== code.trim()) {
      req.session.error = 'Invalid verification code.';
      return res.redirect('/reset-password');
    }

    const now = new Date();
    if (user.reset_expires < now) {
      req.session.error = 'Reset code expired. Please request a new one.';
      delete req.session.resetEmail;
      return res.redirect('/forgot-password');
    }

    const hash = await bcrypt.hash(password, 10);

    await db.query(
      `UPDATE users
       SET password_hash = ?, reset_code = NULL, reset_expires = NULL
       WHERE id = ?`,
      [hash, user.id]
    );

    delete req.session.resetEmail;
    req.session.success = 'Password reset successful. Please log in with your new password.';
    res.redirect('/login');
  } catch (err) {
    console.error('Reset password error:', err);
    req.session.error = 'Failed to reset password.';
    res.redirect('/reset-password');
  }
});

// Admin: activity logs
app.get('/admin/logs', requireAdmin, async (req, res) => {
  const { actor_type, entity_type, q } = req.query;

  try {
    let sql = `
      SELECT *
      FROM activity_logs
      WHERE 1=1
    `;
    const params = [];

    if (actor_type) {
      sql += ' AND actor_type = ?';
      params.push(actor_type);
    }
    if (entity_type) {
      sql += ' AND (entity_type = ?)';
      params.push(entity_type);
    }
    if (q) {
      sql += ' AND (actor_name LIKE ? OR action LIKE ? OR description LIKE ?)';
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }

    sql += ' ORDER BY created_at DESC LIMIT 200';

    const [logs] = await db.query(sql, params);
    res.render('admin_logs', {
      logs,
      filters: {
        actor_type: actor_type || '',
        entity_type: entity_type || '',
        q: q || ''
      }
    });
  } catch (err) {
    console.error('Admin logs error:', err);
    res.status(500).send('Server error');
  }
});

// Admin: manage clinic holidays
app.get('/admin/holidays', requireAdmin, async (req, res) => {
  try {
    const [holidays] = await db.query(
      'SELECT * FROM holidays ORDER BY holiday_date DESC'
    );
    res.render('admin_holidays', { holidays });
  } catch (err) {
    console.error('Admin holidays error:', err);
    res.status(500).send('Server error');
  }
});

app.post('/admin/holidays/new', requireAdmin, async (req, res) => {
  const { holiday_date, reason } = req.body;
  if (!holiday_date) {
    req.session.error = 'Please select a date.';
    return res.redirect('/admin/holidays');
  }

  try {
    await db.query(
      'INSERT IGNORE INTO holidays (holiday_date, reason) VALUES (?, ?)',
      [holiday_date, reason || null]
    );
    await logActivity(
      'admin',
      req.user.id,
      req.user.name,
      'Add holiday',
      'holiday',
      null,
      `Date: ${holiday_date}, Reason: ${reason || ''}`
    );
    req.session.success = 'Holiday added.';
  } catch (err) {
    console.error('Add holiday error:', err);
    req.session.error = 'Failed to add holiday.';
  }
  res.redirect('/admin/holidays');
});

app.post('/admin/holidays/:id/delete', requireAdmin, async (req, res) => {
  const id = req.params.id;
  try {
    await db.query('DELETE FROM holidays WHERE id = ?', [id]);
    await logActivity(
      'admin',
      req.user.id,
      req.user.name,
      'Delete holiday',
      'holiday',
      id,
      null
    );
    req.session.success = 'Holiday removed.';
  } catch (err) {
    console.error('Delete holiday error:', err);
    req.session.error = 'Failed to delete holiday.';
  }
  res.redirect('/admin/holidays');
});

// ======== ADMIN: SPECIALTIES MANAGEMENT ========

// List + manage specialties
app.get('/admin/specialties', requireAdmin, async (req, res) => {
  try {
    const [specialties] = await db.query(
      `SELECT s.*,
              COUNT(d.id) AS doctor_count
       FROM specialties s
       LEFT JOIN doctors d ON d.specialty_id = s.id
       GROUP BY s.id
       ORDER BY s.name`
    );
    res.render('admin_specialties', { specialties });
  } catch (err) {
    console.error('Admin specialties error:', err);
    res.status(500).send('Server error');
  }
});

// Add new specialty
app.post('/admin/specialties/new', requireAdmin, async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    req.session.error = 'Please enter a specialty name.';
    return res.redirect('/admin/specialties');
  }

  try {
    const cleanName = name.trim();
    await db.query(
      'INSERT INTO specialties (name) VALUES (?)',
      [cleanName]
    );

    // Activity log
    await logActivity(
      'admin',
      req.user.id,
      req.user.name,
      'Create specialty',
      'other',
      null,
      `Name: ${cleanName}`
    );

    req.session.success = 'Specialty added.';
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      req.session.error = 'This specialty already exists.';
    } else {
      console.error('Add specialty error:', err);
      req.session.error = 'Failed to add specialty.';
    }
  }
  res.redirect('/admin/specialties');
});

// Edit specialty name
app.post('/admin/specialties/:id/edit', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name } = req.body;

  if (!name || !name.trim() || Number.isNaN(id)) {
    req.session.error = 'Invalid name or id.';
    return res.redirect('/admin/specialties');
  }

  try {
    const cleanName = name.trim();
    await db.query(
      'UPDATE specialties SET name = ? WHERE id = ?',
      [cleanName, id]
    );

    await logActivity(
      'admin',
      req.user.id,
      req.user.name,
      'Update specialty',
      'other',
      id,
      `New name: ${cleanName}`
    );

    req.session.success = 'Specialty updated.';
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      req.session.error = 'Another specialty with this name already exists.';
    } else {
      console.error('Edit specialty error:', err);
      req.session.error = 'Failed to update specialty.';
    }
  }
  res.redirect('/admin/specialties');
});

// Delete specialty (only if no doctors use it)
app.post('/admin/specialties/:id/delete', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    req.session.error = 'Invalid id.';
    return res.redirect('/admin/specialties');
  }

  try {
    // Check if any doctor uses this specialty
    const [[{ cnt }]] = await db.query(
      'SELECT COUNT(*) AS cnt FROM doctors WHERE specialty_id = ?',
      [id]
    );
    if (cnt > 0) {
      req.session.error = 'Cannot delete: some doctors are using this specialty.';
      return res.redirect('/admin/specialties');
    }

    await db.query('DELETE FROM specialties WHERE id = ?', [id]);

    await logActivity(
      'admin',
      req.user.id,
      req.user.name,
      'Delete specialty',
      'other',
      id,
      null
    );

    req.session.success = 'Specialty deleted.';
  } catch (err) {
    console.error('Delete specialty error:', err);
    req.session.error = 'Failed to delete specialty.';
  }
  res.redirect('/admin/specialties');
});

// List doctors (with optional specialty filter)
app.get('/doctors', async (req, res) => {
  const specialtyId = req.query.specialty || null;

  try {
    const [specialties] = await db.query(
      'SELECT * FROM specialties ORDER BY name'
    );

    let doctorsQuery = `
      SELECT d.*, s.name AS specialty_name
      FROM doctors d
      JOIN specialties s ON d.specialty_id = s.id
    `;
    const params = [];

    if (specialtyId) {
      doctorsQuery += ' WHERE d.specialty_id = ?';
      params.push(specialtyId);
    }

    doctorsQuery += ' ORDER BY d.name';

    const [doctors] = await db.query(doctorsQuery, params);

    let favoriteDoctorIds = [];
    if (req.session.userId) {
      const [favRows] = await db.query(
        'SELECT doctor_id FROM favorites WHERE user_id = ?',
        [req.session.userId]
      );
      favoriteDoctorIds = favRows.map(r => r.doctor_id);
    }

    res.render('doctors', {
      doctors,
      specialties,
      selectedSpecialtyId: specialtyId,
      favoriteDoctorIds
    });
  } catch (err) {
    console.error('Doctors list error:', err);
    res.status(500).send('Server error');
  }
});

// Doctor details
app.get('/doctors/:id', async (req, res) => {
  const doctorId = req.params.id;
  try {
    const [rows] = await db.query(
      `SELECT d.*, s.name AS specialty_name
       FROM doctors d
       JOIN specialties s ON d.specialty_id = s.id
       WHERE d.id = ?`,
      [doctorId]
    );
    if (!rows.length) {
      return res.status(404).send('Doctor not found');
    }
    const doctor = rows[0];

    let isFavorite = false;
    if (req.session.userId) {
      const [fav] = await db.query(
        'SELECT 1 FROM favorites WHERE user_id = ? AND doctor_id = ? LIMIT 1',
        [req.session.userId, doctorId]
      );
      isFavorite = fav.length > 0;
    }

    res.render('doctor_detail', { doctor, isFavorite });
  } catch (err) {
    console.error('Doctor detail error:', err);
    res.status(500).send('Server error');
  }
});

// Book appointment (form)
app.get('/doctors/:id/book', requireLogin, async (req, res) => {
  const doctorId = req.params.id;
  const selectedDate = req.query.date || new Date().toISOString().slice(0, 10);

  try {
    const [rows] = await db.query(
      `SELECT d.*, s.name AS specialty_name
       FROM doctors d
       JOIN specialties s ON d.specialty_id = s.id
       WHERE d.id = ?`,
      [doctorId]
    );
    if (!rows.length) {
      return res.status(404).send('Doctor not found');
    }
    const doctor = rows[0];

    // Check holiday
    let holiday = null;
    if (selectedDate) {
      const [hrows] = await db.query(
        'SELECT * FROM holidays WHERE holiday_date = ?',
        [selectedDate]
      );
      if (hrows.length) {
        holiday = hrows[0];
      }
    }

    const slots = [];
    const slotMinutes = 20;
    const fromHHMM = getHHMM(doctor.available_from);
    const toHHMM = getHHMM(doctor.available_to);

    if (!holiday && fromHHMM && toHHMM && selectedDate) {
      const start = timeToMinutes(fromHHMM);
      const end = timeToMinutes(toHHMM);

      const [appointments] = await db.query(
        `SELECT appointment_time, status
         FROM appointments
         WHERE doctor_id = ? AND appointment_date = ?
           AND status IN ('pending','confirmed','completed')`,
        [doctorId, selectedDate]
      );
      const bookedSet = new Set(
        appointments.map(a => getHHMM(a.appointment_time))
      );

      for (let mins = start; mins < end; mins += slotMinutes) {
        const hhmm = minutesToHHMM(mins);
        slots.push({
          label: hhmm,
          value: hhmm + ':00',
          isBooked: bookedSet.has(hhmm)
        });
      }
    }

    res.render('book_appointment', {
      doctor,
      slots,
      selectedDate,
      holiday
    });
  } catch (err) {
    console.error('Book form error:', err);
    res.status(500).send('Server error');
  }
});

// Book appointment (submit)
app.post('/doctors/:id/book', requireLogin, async (req, res) => {
  const doctorId = parseInt(req.params.id, 10);
  const { appointment_date, appointment_time } = req.body;

  if (!appointment_date || !appointment_time) {
    req.session.error = 'Please select date and time.';
    return res.redirect(`/doctors/${doctorId}/book?date=${appointment_date || ''}`);
  }

  try {
    // 1) Date/time must not be in the past
    const now = new Date();
    const todayStr = formatDate(now);                 // 'YYYY-MM-DD'
    const timeHHMM = getHHMM(appointment_time);       // 'HH:MM'

    // Date pure past
    if (appointment_date < todayStr) {
      req.session.error = 'You cannot book an appointment in the past.';
      return res.redirect(`/doctors/${doctorId}/book?date=${todayStr}`);
    }

    // Same-day booking: time should be in future
    if (appointment_date === todayStr) {
      const nowMinutes = now.getHours() * 60 + now.getMinutes();
      const selectedMinutes = timeToMinutes(timeHHMM);

      if (selectedMinutes <= nowMinutes) {
        req.session.error = 'Selected time has already passed. Please choose a future time.';
        return res.redirect(`/doctors/${doctorId}/book?date=${todayStr}`);
      }
    }

    // 2) Holiday check
    const [hrows] = await db.query(
      'SELECT id FROM holidays WHERE holiday_date = ?',
      [appointment_date]
    );
    if (hrows.length) {
      req.session.error = 'Clinic is closed on this date. Please choose another date.';
      return res.redirect(`/doctors/${doctorId}/book?date=${appointment_date}`);
    }

    // 3) Doctor info (validation + email ke liye)
    const [[doctor]] = await db.query(
      `SELECT d.*, s.name AS specialty_name
       FROM doctors d
       JOIN specialties s ON d.specialty_id = s.id
       WHERE d.id = ?`,
      [doctorId]
    );

    if (!doctor) {
      req.session.error = 'Doctor not found.';
      return res.redirect('/doctors');
    }

    const fromHHMM = getHHMM(doctor.available_from);
    const toHHMM   = getHHMM(doctor.available_to);

    // 4) Time availability check against doctor's working hours
    if (!fromHHMM || !toHHMM || !timeHHMM) {
      req.session.error = 'Invalid time selected.';
      return res.redirect(`/doctors/${doctorId}/book?date=${appointment_date}`);
    }

    const t = timeToMinutes(timeHHMM);
    if (t < timeToMinutes(fromHHMM) || t >= timeToMinutes(toHHMM)) {
      req.session.error = 'Selected time is outside doctor availability.';
      return res.redirect(`/doctors/${doctorId}/book?date=${appointment_date}`);
    }

    // 5) Conflict (double booking) check
    const [conflicts] = await db.query(
      `SELECT id FROM appointments
       WHERE doctor_id = ? AND appointment_date = ? AND appointment_time = ?
         AND status IN ('pending','confirmed','completed')
       LIMIT 1`,
      [doctorId, appointment_date, appointment_time]
    );
    if (conflicts.length) {
      req.session.error = 'This time slot is already booked. Please choose another slot.';
      return res.redirect(`/doctors/${doctorId}/book?date=${appointment_date}`);
    }

    // 6) Insert appointment
    await db.query(
      `INSERT INTO appointments (user_id, doctor_id, appointment_date, appointment_time)
       VALUES (?, ?, ?, ?)`,
      [req.session.userId, doctorId, appointment_date, appointment_time]
    );

    // 7) Email confirmation to patient
    if (req.user && req.user.email) {
      const slotDisplay = `${appointment_date} at ${timeHHMM}`;
      const subject = `Appointment booked with ${doctor.name}`;
      const html = `
        <p>Hi ${req.user.name},</p>
        <p>Your appointment has been booked (pending confirmation):</p>
        <ul>
          <li>Doctor: <strong>${doctor.name}</strong> (${doctor.specialty_name})</li>
          <li>Date &amp; Time: <strong>${slotDisplay}</strong></li>
          <li>Consultation Fee: <strong>₹${doctor.fee}</strong></li>
        </ul>
        <p>You will receive another update when the appointment is confirmed or its status changes.</p>
        <p>– MediBook</p>
      `;
      sendMail({ to: req.user.email, subject, html });
    }

    req.session.success = 'Appointment booked (pending confirmation).';
    res.redirect('/my-appointments');
  } catch (err) {
    console.error('Book submit error:', err);
    req.session.error = 'Failed to book appointment.';
    res.redirect(`/doctors/${doctorId}/book?date=${appointment_date}`);
  }
});

// User appointments (with filters)
app.get('/my-appointments', requireLogin, async (req, res) => {
  const { q, status, date_from, date_to } = req.query;

  try {
    let sql = `
      SELECT a.*, d.name AS doctor_name, s.name AS specialty_name
      FROM appointments a
      JOIN doctors d ON a.doctor_id = d.id
      JOIN specialties s ON d.specialty_id = s.id
      WHERE a.user_id = ?
    `;
    const params = [req.session.userId];

    if (q) {
      sql += ' AND (d.name LIKE ? OR s.name LIKE ?)';
      params.push(`%${q}%`, `%${q}%`);
    }
    if (status) {
      sql += ' AND a.status = ?';
      params.push(status);
    }
    if (date_from) {
      sql += ' AND a.appointment_date >= ?';
      params.push(date_from);
    }
    if (date_to) {
      sql += ' AND a.appointment_date <= ?';
      params.push(date_to);
    }

    sql += ' ORDER BY a.appointment_date DESC, a.appointment_time DESC';

    const [appointments] = await db.query(sql, params);

    res.render('my_appointments', {
      appointments,
      filters: {
        q: q || '',
        status: status || '',
        date_from: date_from || '',
        date_to: date_to || ''
      }
    });
  } catch (err) {
    console.error('My appointments error:', err);
    res.status(500).send('Server error');
  }
});

// Cancel appointment (user)
app.post('/appointments/:id/cancel', requireLogin, async (req, res) => {
  const appointmentId = req.params.id;
  try {
    await db.query(
      `UPDATE appointments
       SET status = 'cancelled'
       WHERE id = ? AND user_id = ? AND status IN ('pending', 'confirmed')`,
      [appointmentId, req.session.userId]
    );
    req.session.success = 'Appointment cancelled.';
    res.redirect('/my-appointments');
  } catch (err) {
    console.error('Cancel appointment error:', err);
    req.session.error = 'Failed to cancel appointment.';
    res.redirect('/my-appointments');
  }
});

// Appointment invoice / print view
app.get('/appointments/:id/invoice', requireLogin, async (req, res) => {
  const appointmentId = parseInt(req.params.id, 10);
  if (Number.isNaN(appointmentId)) {
    return res.status(400).send('Invalid appointment id');
  }
  try {
    const [rows] = await db.query(
      `SELECT a.*,
              d.name AS doctor_name, d.fee, s.name AS specialty_name,
              u.name AS user_name, u.email AS user_email
       FROM appointments a
       JOIN doctors d ON a.doctor_id = d.id
       JOIN specialties s ON d.specialty_id = s.id
       JOIN users u ON a.user_id = u.id
       WHERE a.id = ?`,
      [appointmentId]
    );
    if (!rows.length) {
      return res.status(404).send('Appointment not found');
    }
    const appt = rows[0];

    // Sirf apna appointment ya admin ko dikhne de
    if (appt.user_id !== req.session.userId && (!req.user || req.user.role !== 'admin')) {
      return res.status(403).send('Forbidden');
    }

    res.render('invoice', {
      appt,
      isAdmin: req.user && req.user.role === 'admin'
    });
  } catch (err) {
    console.error('Invoice error:', err);
    res.status(500).send('Server error');
  }
});

/* ============ ADMIN ROUTES ============ */

// Admin dashboard
app.get('/admin', requireAdmin, async (req, res) => {
  try {
    const [[{ userCount }]] = await db.query(
      "SELECT COUNT(*) AS userCount FROM users WHERE role = 'user'"
    );
    const [[{ doctorCount }]] = await db.query(
      'SELECT COUNT(*) AS doctorCount FROM doctors'
    );
    const [[{ appointmentCount }]] = await db.query(
      'SELECT COUNT(*) AS appointmentCount FROM appointments'
    );
    const [[{ pendingCount }]] = await db.query(
      "SELECT COUNT(*) AS pendingCount FROM appointments WHERE status = 'pending'"
    );
    const [[{ todayCount }]] = await db.query(
      "SELECT COUNT(*) AS todayCount FROM appointments WHERE appointment_date = CURDATE()"
    );
    const [[{ upcomingCount }]] = await db.query(
      "SELECT COUNT(*) AS upcomingCount FROM appointments WHERE appointment_date > CURDATE()"
    );
    const [[{ completedCount }]] = await db.query(
      "SELECT COUNT(*) AS completedCount FROM appointments WHERE status = 'completed'"
    );
    const [[{ paidRevenue }]] = await db.query(
      "SELECT IFNULL(SUM(payment_amount),0) AS paidRevenue FROM appointments WHERE payment_status = 'paid'"
    );

    const [appointmentsBySpecialty] = await db.query(
      `SELECT s.name AS specialty_name, COUNT(*) AS count
       FROM appointments a
       JOIN doctors d ON a.doctor_id = d.id
       JOIN specialties s ON d.specialty_id = s.id
       GROUP BY s.id
       ORDER BY count DESC
       LIMIT 5`
    );

    const [recentAppointments] = await db.query(
      `SELECT a.*, u.name AS user_name, d.name AS doctor_name, s.name AS specialty_name
       FROM appointments a
       JOIN users u ON a.user_id = u.id
       JOIN doctors d ON a.doctor_id = d.id
       JOIN specialties s ON d.specialty_id = s.id
       ORDER BY a.created_at DESC
       LIMIT 5`
    );

    res.render('admin_dashboard', {
      stats: {
        userCount,
        doctorCount,
        appointmentCount,
        pendingCount,
        todayCount,
        upcomingCount,
        completedCount,
        paidRevenue
      },
      appointmentsBySpecialty,
      recentAppointments
    });
  } catch (err) {
    console.error('Admin dashboard error:', err);
    res.status(500).send('Server error');
  }
});

// Doctor dashboard
app.get('/doctor/dashboard', requireDoctor, async (req, res) => {
  try {
    const doctorId = req.session.doctorId;

    const [[{ totalAppointments }]] = await db.query(
      'SELECT COUNT(*) AS totalAppointments FROM appointments WHERE doctor_id = ?',
      [doctorId]
    );
    const [[{ upcomingCount }]] = await db.query(
      `SELECT COUNT(*) AS upcomingCount
       FROM appointments
       WHERE doctor_id = ? AND appointment_date >= CURDATE()`,
      [doctorId]
    );
    const [[{ pendingCount }]] = await db.query(
      `SELECT COUNT(*) AS pendingCount
       FROM appointments
       WHERE doctor_id = ? AND status = 'pending'`,
      [doctorId]
    );

    const [upcomingAppointments] = await db.query(
      `SELECT a.*, u.name AS user_name
       FROM appointments a
       JOIN users u ON a.user_id = u.id
       WHERE a.doctor_id = ?
         AND a.appointment_date >= CURDATE()
       ORDER BY a.appointment_date ASC, a.appointment_time ASC
       LIMIT 5`,
      [doctorId]
    );

    res.render('doctor_dashboard', {
      stats: { totalAppointments, upcomingCount, pendingCount },
      upcomingAppointments
    });
  } catch (err) {
    console.error('Doctor dashboard error:', err);
    res.status(500).send('Server error');
  }
});

// Doctor appointments list
app.get('/doctor/appointments', requireDoctor, async (req, res) => {
  const { status, date_from, date_to, q } = req.query;

  try {
    const doctorId = req.session.doctorId;

    let sql = `
      SELECT a.*, u.name AS user_name, u.email AS user_email
      FROM appointments a
      JOIN users u ON a.user_id = u.id
      WHERE a.doctor_id = ?
    `;
    const params = [doctorId];

    if (status) {
      sql += ' AND a.status = ?';
      params.push(status);
    }
    if (date_from) {
      sql += ' AND a.appointment_date >= ?';
      params.push(date_from);
    }
    if (date_to) {
      sql += ' AND a.appointment_date <= ?';
      params.push(date_to);
    }
    if (q) {
      sql += ' AND (u.name LIKE ? OR u.email LIKE ?)';
      params.push(`%${q}%`, `%${q}%`);
    }

    sql += ' ORDER BY a.appointment_date DESC, a.appointment_time DESC';

    const [appointments] = await db.query(sql, params);

    res.render('doctor_appointments', {
      appointments,
      filters: {
        status: status || '',
        date_from: date_from || '',
        date_to: date_to || '',
        q: q || ''
      }
    });
  } catch (err) {
    console.error('Doctor appointments error:', err);
    res.status(500).send('Server error');
  }
});

// Doctor update appointment status
app.post('/doctor/appointments/:id/status', requireDoctor, async (req, res) => {
  const appointmentId = parseInt(req.params.id, 10);
  const { status } = req.body;
  const allowed = ['pending', 'confirmed', 'cancelled', 'completed'];

  if (!allowed.includes(status) || Number.isNaN(appointmentId)) {
    req.session.error = 'Invalid status.';
    return res.redirect('/doctor/appointments');
  }

  try {
    // Status update
    await db.query(
      'UPDATE appointments SET status = ? WHERE id = ? AND doctor_id = ?',
      [status, appointmentId, req.session.doctorId]
    );

    // Activity log (agar tumne logActivity helper add kiya hai)
    try {
      await logActivity(
        'doctor',
        req.session.doctorId,
        req.doctor ? req.doctor.name : null,
        `Update own appointment status to ${status}`,
        'appointment',
        appointmentId,
        null
      );
    } catch (e) {
      // ignore log failure
    }

    // Sirf confirmed/cancelled par mail bhejo
    if (status === 'confirmed' || status === 'cancelled') {
      const [rows] = await db.query(
        `SELECT a.*,
                u.name AS user_name, u.email AS user_email,
                d.name AS doctor_name, s.name AS specialty_name
         FROM appointments a
         JOIN users u ON a.user_id = u.id
         JOIN doctors d ON a.doctor_id = d.id
         JOIN specialties s ON d.specialty_id = s.id
         WHERE a.id = ? AND a.doctor_id = ?`,
        [appointmentId, req.session.doctorId]
      );

      if (rows.length && rows[0].user_email) {
        const appt = rows[0];
        const apptDate = formatDate(appt.appointment_date);
        const apptTime = formatTime(appt.appointment_time);

        let subject;
        let html;

        if (status === 'confirmed') {
          subject = `Your appointment with ${appt.doctor_name} is confirmed`;
          html = `
            <p>Hi ${appt.user_name},</p>
            <p>Your appointment has been <strong>confirmed</strong>:</p>
            <ul>
              <li>Doctor: <strong>${appt.doctor_name}</strong> (${appt.specialty_name})</li>
              <li>Date &amp; Time: <strong>${apptDate} at ${apptTime}</strong></li>
            </ul>
            <p>Please reach the clinic a few minutes before your appointment time.</p>
            <p>– MediBook</p>
          `;
        } else {
          subject = `Your appointment with ${appt.doctor_name} was cancelled`;
          html = `
            <p>Hi ${appt.user_name},</p>
            <p>Your appointment has been <strong>cancelled</strong>:</p>
            <ul>
              <li>Doctor: <strong>${appt.doctor_name}</strong> (${appt.specialty_name})</li>
              <li>Original Date &amp; Time: <strong>${apptDate} at ${apptTime}</strong></li>
            </ul>
            <p>You can book a new appointment from your MediBook account if needed.</p>
            <p>– MediBook</p>
          `;
        }

        sendMail({ to: appt.user_email, subject, html });
      }
    }

    req.session.success = 'Appointment status updated.';
    res.redirect('/doctor/appointments');
  } catch (err) {
    console.error('Doctor update status error:', err);
    req.session.error = 'Failed to update status.';
    res.redirect('/doctor/appointments');
  }
});


// Manage doctors
app.get('/admin/doctors', requireAdmin, async (req, res) => {
  try {
    const [doctors] = await db.query(
      `SELECT d.*,
              s.name AS specialty_name,
              COALESCE(stats.total_appointments, 0)     AS total_appointments,
              COALESCE(stats.completed_appointments, 0) AS completed_appointments,
              COALESCE(stats.cancelled_appointments, 0) AS cancelled_appointments,
              COALESCE(stats.upcoming_appointments, 0)  AS upcoming_appointments
       FROM doctors d
       JOIN specialties s ON d.specialty_id = s.id
       LEFT JOIN (
         SELECT doctor_id,
                COUNT(*) AS total_appointments,
                SUM(status = 'completed') AS completed_appointments,
                SUM(status = 'cancelled') AS cancelled_appointments,
                SUM(CASE WHEN appointment_date >= CURDATE() THEN 1 ELSE 0 END) AS upcoming_appointments
         FROM appointments
         GROUP BY doctor_id
       ) AS stats ON stats.doctor_id = d.id
       ORDER BY d.name`
    );
    res.render('admin_doctors', { doctors });
  } catch (err) {
    console.error('Admin doctors list error:', err);
    res.status(500).send('Server error');
  }
});

// New doctor form
app.get('/admin/doctors/new', requireAdmin, async (req, res) => {
  try {
    const [specialties] = await db.query(
      'SELECT * FROM specialties ORDER BY name'
    );
    res.render('admin_doctor_form', {
      doctor: null,
      specialties,
      formAction: '/admin/doctors/new'
    });
  } catch (err) {
    console.error('New doctor form error:', err);
    res.status(500).send('Server error');
  }
});

// Create doctor (with photo)
app.post('/admin/doctors/new', requireAdmin, upload.single('photo'), async (req, res) => {
  const {
    name,
    specialty_id,
    bio,
    experience_years,
    fee,
    available_from,
    available_to,
    doctor_email,
    doctor_password,
    is_active
  } = req.body;

  const expYears = Number(experience_years) || 0;
  const feeNum   = Number(fee) || 0;

  if (expYears < 0 || feeNum < 0) {
    req.session.error = 'Experience and fee must be non-negative.';
    return res.redirect('/admin/doctors/new');
  }

  const photo = req.file ? req.file.filename : null;
  let passwordHash = null;

  try {
    if (doctor_password) {
      passwordHash = await bcrypt.hash(doctor_password, 10);
    }

    const [result] = await db.query(
      `INSERT INTO doctors
       (name, email, password_hash, photo, specialty_id, bio, experience_years, fee, available_from, available_to, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name,
        doctor_email || null,
        passwordHash,
        photo,
        specialty_id,
        bio,
        experience_years || 0,
        fee || 0,
        available_from,
        available_to,
        is_active ? 1 : 0
      ]
    );
    
    await logActivity(
      'admin',
      req.user.id,
      req.user.name,
      'Create doctor',
      'doctor',
      result.insertId,
      `Doctor name: ${name}`
    );
    
    req.session.success = 'Doctor added.';
    res.redirect('/admin/doctors');
  } catch (err) {
    console.error('Create doctor error:', err);
    req.session.error = 'Failed to add doctor.';
    res.redirect('/admin/doctors/new');
  }
});

// Edit doctor form
app.get('/admin/doctors/:id/edit', requireAdmin, async (req, res) => {
  const doctorId = req.params.id;
  try {
    const [docs] = await db.query('SELECT * FROM doctors WHERE id = ?', [
      doctorId
    ]);
    if (!docs.length) return res.status(404).send('Doctor not found');

    const doctor = docs[0];
    const [specialties] = await db.query(
      'SELECT * FROM specialties ORDER BY name'
    );

    res.render('admin_doctor_form', {
      doctor,
      specialties,
      formAction: `/admin/doctors/${doctorId}/edit`
    });
  } catch (err) {
    console.error('Edit doctor form error:', err);
    res.status(500).send('Server error');
  }
});

// Update doctor (with photo)
app.post('/admin/doctors/:id/edit', requireAdmin, upload.single('photo'), async (req, res) => {
  const doctorId = req.params.id;
  const {
    name,
    specialty_id,
    bio,
    experience_years,
    fee,
    available_from,
    available_to,
    existing_photo,
    doctor_email,
    doctor_password,
    is_active
  } = req.body;

  try {
    const [docs] = await db.query(
      'SELECT photo, password_hash FROM doctors WHERE id = ?',
      [doctorId]
    );
    if (!docs.length) {
      req.session.error = 'Doctor not found.';
      return res.redirect('/admin/doctors');
    }

    const current = docs[0];
    const photoToSave = req.file ? req.file.filename : (existing_photo || current.photo);
    let passwordHash = current.password_hash;

    if (doctor_password) {
      passwordHash = await bcrypt.hash(doctor_password, 10);
    }

    await db.query(
      `UPDATE doctors
       SET name = ?, email = ?, password_hash = ?, photo = ?, specialty_id = ?, bio = ?, experience_years = ?, fee = ?, available_from = ?, available_to = ?, is_active = ?
       WHERE id = ?`,
      [
        name,
        doctor_email || null,
        passwordHash,
        photoToSave,
        specialty_id,
        bio,
        experience_years || 0,
        fee || 0,
        available_from,
        available_to,
        is_active ? 1 : 0,
        doctorId
      ]
    );
    
    await logActivity(
      'admin',
      req.user.id,
      req.user.name,
      'Update doctor profile',
      'doctor',
      doctorId,
      `Doctor name: ${name}`
    );

    req.session.success = 'Doctor updated.';
    res.redirect('/admin/doctors');
  } catch (err) {
    console.error('Update doctor error:', err);
    req.session.error = 'Failed to update doctor.';
    res.redirect(`/admin/doctors/${doctorId}/edit`);
  }
});

// Admin view appointments (with filters)
app.get('/admin/appointments', requireAdmin, async (req, res) => {
  const { q, status, date_from, date_to } = req.query;

  try {
    let sql = `
      SELECT a.*, u.name AS user_name, u.email AS user_email,
             d.name AS doctor_name, s.name AS specialty_name
      FROM appointments a
      JOIN users u ON a.user_id = u.id
      JOIN doctors d ON a.doctor_id = d.id
      JOIN specialties s ON d.specialty_id = s.id
      WHERE 1=1
    `;
    const params = [];

    if (q) {
      sql += ` AND (u.name LIKE ? OR u.email LIKE ? OR d.name LIKE ? OR s.name LIKE ?)`;
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (status) {
      sql += ' AND a.status = ?';
      params.push(status);
    }
    if (date_from) {
      sql += ' AND a.appointment_date >= ?';
      params.push(date_from);
    }
    if (date_to) {
      sql += ' AND a.appointment_date <= ?';
      params.push(date_to);
    }

    sql += ' ORDER BY a.appointment_date DESC, a.appointment_time DESC';

    const [appointments] = await db.query(sql, params);

    res.render('admin_appointments', {
      appointments,
      filters: {
        q: q || '',
        status: status || '',
        date_from: date_from || '',
        date_to: date_to || ''
      }
    });
  } catch (err) {
    console.error('Admin appointments error:', err);
    res.status(500).send('Server error');
  }
});

app.get('/admin/appointments/export', requireAdmin, async (req, res) => {
  const { status, date_from, date_to, q } = req.query;

  try {
    let sql = `
      SELECT a.*, u.name AS user_name, u.email AS user_email,
             d.name AS doctor_name, s.name AS specialty_name
      FROM appointments a
      JOIN users u ON a.user_id = u.id
      JOIN doctors d ON a.doctor_id = d.id
      JOIN specialties s ON d.specialty_id = s.id
      WHERE 1=1
    `;
    const params = [];

    if (q) {
      sql += ` AND (u.name LIKE ? OR u.email LIKE ? OR d.name LIKE ? OR s.name LIKE ?)`;
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (status) {
      sql += ' AND a.status = ?';
      params.push(status);
    }
    if (date_from) {
      sql += ' AND a.appointment_date >= ?';
      params.push(date_from);
    }
    if (date_to) {
      sql += ' AND a.appointment_date <= ?';
      params.push(date_to);
    }

    sql += ' ORDER BY a.appointment_date DESC, a.appointment_time DESC';

    const [rows] = await db.query(sql, params);

    const fileName = `appointments-${new Date().toISOString().slice(0,10)}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    let lines = [];
    lines.push([
      'AppointmentID',
      'PatientName',
      'PatientEmail',
      'DoctorName',
      'Specialty',
      'Date',
      'Time',
      'Status',
      'PaymentStatus',
      'Fee'
    ].map(toCsvValue).join(','));

    rows.forEach(r => {
      lines.push([
        r.id,
        r.user_name,
        r.user_email,
        r.doctor_name,
        r.specialty_name,
        formatDate(r.appointment_date),
        formatTime(r.appointment_time),
        r.status,
        r.payment_status || '',
        r.fee
      ].map(toCsvValue).join(','));
    });

    res.send(lines.join('\n'));
  } catch (err) {
    console.error('Export appointments error:', err);
    res.status(500).send('Failed to export CSV.');
  }
});

// Admin: manage patients (users)
app.get('/admin/patients', requireAdmin, async (req, res) => {
  try {
    const [patients] = await db.query(
      `SELECT id, name, email, created_at
       FROM users
       WHERE role = 'user'
       ORDER BY created_at DESC`
    );
    res.render('admin_patients', { patients });
  } catch (err) {
    console.error('Admin patients error:', err);
    res.status(500).send('Server error');
  }
});

app.post('/admin/patients/:id/delete', requireAdmin, async (req, res) => {
  const id = req.params.id;
  try {
    await db.query(
      "DELETE FROM users WHERE id = ? AND role = 'user'",
      [id]
    );
    req.session.success = 'Patient deleted (and related appointments removed).';
    await logActivity(
      'admin',
      req.user.id,
      req.user.name,
      'Delete patient',
      'patient',
      id,
      null
    );
  } catch (err) {
    console.error('Delete patient error:', err);
    req.session.error = 'Failed to delete patient.';
  }
  res.redirect('/admin/patients');
});

// Update appointment status
app.post('/admin/appointments/:id/status', requireAdmin, async (req, res) => {
  const appointmentId = parseInt(req.params.id, 10);
  const { status } = req.body;
  const allowed = ['pending', 'confirmed', 'cancelled', 'completed'];

  if (!allowed.includes(status) || Number.isNaN(appointmentId)) {
    req.session.error = 'Invalid status.';
    return res.redirect('/admin/appointments');
  }

  try {
    // Status update
    await db.query('UPDATE appointments SET status = ? WHERE id = ?', [
      status,
      appointmentId
    ]);

    // Activity log
    try {
      await logActivity(
        'admin',
        req.user.id,
        req.user.name,
        `Update appointment status to ${status} (admin)`,
        'appointment',
        appointmentId,
        null
      );
    } catch (e) {}

    // Sirf confirmed/cancelled par mail
    if (status === 'confirmed' || status === 'cancelled') {
      const [rows] = await db.query(
        `SELECT a.*,
                u.name AS user_name, u.email AS user_email,
                d.name AS doctor_name, s.name AS specialty_name
         FROM appointments a
         JOIN users u ON a.user_id = u.id
         JOIN doctors d ON a.doctor_id = d.id
         JOIN specialties s ON d.specialty_id = s.id
         WHERE a.id = ?`,
        [appointmentId]
      );

      if (rows.length && rows[0].user_email) {
        const appt = rows[0];
        const apptDate = formatDate(appt.appointment_date);
        const apptTime = formatTime(appt.appointment_time);

        let subject;
        let html;

        if (status === 'confirmed') {
          subject = `Your appointment with ${appt.doctor_name} is confirmed`;
          html = `
            <p>Hi ${appt.user_name},</p>
            <p>Your appointment has been <strong>confirmed</strong> by the clinic:</p>
            <ul>
              <li>Doctor: <strong>${appt.doctor_name}</strong> (${appt.specialty_name})</li>
              <li>Date &amp; Time: <strong>${apptDate} at ${apptTime}</strong></li>
            </ul>
            <p>Please reach the clinic a few minutes before your appointment time.</p>
            <p>– MediBook</p>
          `;
        } else {
          subject = `Your appointment with ${appt.doctor_name} was cancelled`;
          html = `
            <p>Hi ${appt.user_name},</p>
            <p>Your appointment has been <strong>cancelled</strong> by the clinic:</p>
            <ul>
              <li>Doctor: <strong>${appt.doctor_name}</strong> (${appt.specialty_name})</li>
              <li>Original Date &amp; Time: <strong>${apptDate} at ${apptTime}</strong></li>
            </ul>
            <p>You can book a new appointment from your MediBook account if needed.</p>
            <p>– MediBook</p>
          `;
        }

        sendMail({ to: appt.user_email, subject, html });
      }
    }

    req.session.success = 'Appointment status updated.';
    res.redirect('/admin/appointments');
  } catch (err) {
    console.error('Update status error:', err);
    req.session.error = 'Failed to update status.';
    res.redirect('/admin/appointments');
  }
});

// Admin: appointment detail + notes/prescription
app.get('/admin/appointments/:id/detail', requireAdmin, async (req, res) => {
  const appointmentId = parseInt(req.params.id, 10);
  if (Number.isNaN(appointmentId)) {
    return res.status(400).send('Invalid appointment id');
  }

  try {
    const [rows] = await db.query(
      `SELECT a.*,
              u.name AS user_name, u.email AS user_email,
              d.name AS doctor_name, s.name AS specialty_name
       FROM appointments a
       JOIN users u ON a.user_id = u.id
       JOIN doctors d ON a.doctor_id = d.id
       JOIN specialties s ON d.specialty_id = s.id
       WHERE a.id = ?`,
      [appointmentId]
    );
    if (!rows.length) {
      return res.status(404).send('Appointment not found');
    }

    const appt = rows[0];
    res.render('admin_appointment_detail', { appt });
  } catch (err) {
    console.error('Admin appointment detail error:', err);
    res.status(500).send('Server error');
  }
});

// Admin: save notes & prescription
app.post('/admin/appointments/:id/notes', requireAdmin, async (req, res) => {
  const appointmentId = parseInt(req.params.id, 10);
  if (Number.isNaN(appointmentId)) {
    return res.status(400).send('Invalid appointment id');
  }
  const { doctor_notes, prescription } = req.body;

  try {
    await db.query(
      `UPDATE appointments
       SET doctor_notes = ?, prescription = ?
       WHERE id = ?`,
      [doctor_notes || null, prescription || null, appointmentId]
    );
    await logActivity(
      'admin',
      req.user.id,
      req.user.name,
      'Update appointment notes/prescription',
      'appointment',
      appointmentId,
      null
    );
    req.session.success = 'Notes updated.';
    res.redirect(`/admin/appointments/${appointmentId}/detail`);
  } catch (err) {
    console.error('Admin notes save error:', err);
    req.session.error = 'Failed to save notes.';
    res.redirect(`/admin/appointments/${appointmentId}/detail`);
  }
});

// Doctor: view/edit notes & prescription for one appointment
app.get('/doctor/appointments/:id/notes', requireDoctor, async (req, res) => {
  const appointmentId = parseInt(req.params.id, 10);
  if (Number.isNaN(appointmentId)) {
    return res.status(400).send('Invalid appointment id');
  }

  try {
    const doctorId = req.session.doctorId;
    const [rows] = await db.query(
      `SELECT a.*, u.name AS user_name, u.email AS user_email
       FROM appointments a
       JOIN users u ON a.user_id = u.id
       WHERE a.id = ? AND a.doctor_id = ?`,
      [appointmentId, doctorId]
    );
    if (!rows.length) {
      return res.status(404).send('Appointment not found');
    }

    const appt = rows[0];
    res.render('doctor_appointment_notes', { appt });
  } catch (err) {
    console.error('Doctor notes page error:', err);
    res.status(500).send('Server error');
  }
});

app.get('/admin/patients/export', requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, name, email, created_at
       FROM users
       WHERE role = 'user'
       ORDER BY created_at DESC`
    );

    const fileName = `patients-${new Date().toISOString().slice(0,10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    let lines = [];
    lines.push(['ID', 'Name', 'Email', 'RegisteredOn'].map(toCsvValue).join(','));

    rows.forEach(r => {
      lines.push([
        r.id,
        r.name,
        r.email,
        formatDate(r.created_at)
      ].map(toCsvValue).join(','));
    });

    res.send(lines.join('\n'));
  } catch (err) {
    console.error('Export patients error:', err);
    res.status(500).send('Failed to export CSV.');
  }
});

app.get('/admin/doctors/export', requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT d.id, d.name, d.email, d.experience_years, d.fee,
              s.name AS specialty_name
       FROM doctors d
       JOIN specialties s ON d.specialty_id = s.id
       ORDER BY d.name`
    );

    const fileName = `doctors-${new Date().toISOString().slice(0,10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    let lines = [];
    lines.push(['ID', 'Name', 'Email', 'Specialty', 'ExperienceYears', 'Fee'].map(toCsvValue).join(','));

    rows.forEach(r => {
      lines.push([
        r.id,
        r.name,
        r.email || '',
        r.specialty_name,
        r.experience_years,
        r.fee
      ].map(toCsvValue).join(','));
    });

    res.send(lines.join('\n'));
  } catch (err) {
    console.error('Export doctors error:', err);
    res.status(500).send('Failed to export CSV.');
  }
});

// ======== Activity Log Helper =========
async function logActivity(actorType, actorId, actorName, action, entityType, entityId, description) {
  try {
    await db.query(
      `INSERT INTO activity_logs
       (actor_type, actor_id, actor_name, action, entity_type, entity_id, description)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [actorType, actorId || null, actorName || null, action, entityType || null, entityId || null, description || null]
    );
  } catch (err) {
    console.error('Activity log error:', err.message);
    // Intentionally: logging failure should not break main flow
  }
}

// Doctor: patient medical history (only this doctor's appointments)
app.get('/doctor/patients/:patientId/history', requireDoctor, async (req, res) => {
  const patientId = parseInt(req.params.patientId, 10);
  if (Number.isNaN(patientId)) {
    return res.status(400).send('Invalid patient id');
  }

  try {
    const doctorId = req.session.doctorId;

    // Patient info
    const [[patient]] = await db.query(
      `SELECT id, name, email
       FROM users
       WHERE id = ? AND role = 'user'`,
      [patientId]
    );
    if (!patient) {
      return res.status(404).send('Patient not found');
    }

    // All appointments of this patient with current doctor
    const [appointments] = await db.query(
      `SELECT a.*,
              d.name AS doctor_name,
              s.name AS specialty_name
       FROM appointments a
       JOIN doctors d ON a.doctor_id = d.id
       JOIN specialties s ON d.specialty_id = s.id
       WHERE a.user_id = ? AND a.doctor_id = ?
       ORDER BY a.appointment_date DESC, a.appointment_time DESC`,
      [patientId, doctorId]
    );

    res.render('doctor_patient_history', { patient, appointments });
  } catch (err) {
    console.error('Doctor patient history error:', err);
    res.status(500).send('Server error');
  }
});

// Doctor: save notes & prescription
app.post('/doctor/appointments/:id/notes', requireDoctor, async (req, res) => {
  const appointmentId = parseInt(req.params.id, 10);
  if (Number.isNaN(appointmentId)) {
    return res.status(400).send('Invalid appointment id');
  }

  const {
    doctor_notes,
    prescription,
    followup_date,
    followup_time,
    followup_reason
  } = req.body;

  try {
    const doctorId = req.session.doctorId;

    // 1) Original appointment + patient + doctor info
    const [rows] = await db.query(
      `SELECT a.*,
              u.name  AS user_name,
              u.email AS user_email,
              d.name  AS doctor_name,
              s.name  AS specialty_name
       FROM appointments a
       JOIN users u   ON a.user_id = u.id
       JOIN doctors d ON a.doctor_id = d.id
       JOIN specialties s ON d.specialty_id = s.id
       WHERE a.id = ? AND a.doctor_id = ?`,
      [appointmentId, doctorId]
    );

    if (!rows.length) {
      req.session.error = 'Appointment not found.';
      return res.redirect('/doctor/appointments');
    }

    const appt = rows[0];

    // 2) Update notes/prescription for this appointment
    await db.query(
      `UPDATE appointments
       SET doctor_notes = ?, prescription = ?
       WHERE id = ? AND doctor_id = ?`,
      [doctor_notes || null, prescription || null, appointmentId, doctorId]
    );

    try {
      await logActivity(
        'doctor',
        doctorId,
        req.doctor ? req.doctor.name : null,
        'Update notes/prescription',
        'appointment',
        appointmentId,
        null
      );
    } catch (e) {}

    let followupCreated = false;

    // 3) Follow-up schedule (optional) – dono date+time hone chahiye
    if (followup_date || followup_time) {
      if (!followup_date || !followup_time) {
        req.session.error = 'Please provide both date and time for follow-up.';
        return res.redirect(`/doctor/appointments/${appointmentId}/notes`);
      }

      // 3a) Future time validation
      const now = new Date();
      const todayStr = formatDate(now);
      const fuHHMM = getHHMM(followup_time);

      if (followup_date < todayStr) {
        req.session.error = 'Follow-up date cannot be in the past.';
        return res.redirect(`/doctor/appointments/${appointmentId}/notes`);
      }

      if (followup_date === todayStr) {
        const nowMinutes = now.getHours() * 60 + now.getMinutes();
        const fuMinutes = timeToMinutes(fuHHMM);
        if (fuMinutes <= nowMinutes) {
          req.session.error = 'Follow-up time must be in the future.';
          return res.redirect(`/doctor/appointments/${appointmentId}/notes`);
        }
      }

      // 3b) Holiday check
      const [hrows] = await db.query(
        'SELECT id FROM holidays WHERE holiday_date = ?',
        [followup_date]
      );
      if (hrows.length) {
        req.session.error = 'Clinic is closed on the selected follow-up date.';
        return res.redirect(`/doctor/appointments/${appointmentId}/notes`);
      }

      // 3c) Doctor availability (same doctor)
      const [[doctor]] = await db.query(
        'SELECT available_from, available_to FROM doctors WHERE id = ?',
        [doctorId]
      );

      const fromHHMM = getHHMM(doctor.available_from);
      const toHHMM   = getHHMM(doctor.available_to);

      if (!fromHHMM || !toHHMM) {
        req.session.error = 'Doctor availability not configured.';
        return res.redirect(`/doctor/appointments/${appointmentId}/notes`);
      }

      const fuMinutes = timeToMinutes(fuHHMM);
      if (fuMinutes < timeToMinutes(fromHHMM) || fuMinutes >= timeToMinutes(toHHMM)) {
        req.session.error = 'Follow-up time is outside doctor availability.';
        return res.redirect(`/doctor/appointments/${appointmentId}/notes`);
      }

      // 3d) Conflict check
      const [conflicts] = await db.query(
        `SELECT id FROM appointments
         WHERE doctor_id = ? AND appointment_date = ? AND appointment_time = ?
           AND status IN ('pending','confirmed','completed')
         LIMIT 1`,
        [doctorId, followup_date, followup_time]
      );

      if (conflicts.length) {
        req.session.error = 'This follow-up slot is already booked.';
        return res.redirect(`/doctor/appointments/${appointmentId}/notes`);
      }

      // 3e) Create follow-up appointment
      const [result] = await db.query(
        `INSERT INTO appointments
         (user_id, doctor_id, appointment_date, appointment_time,
          status, parent_appointment_id, followup_reason)
         VALUES (?, ?, ?, ?, 'confirmed', ?, ?)`,
        [
          appt.user_id,
          doctorId,
          followup_date,
          followup_time,
          appointmentId,
          followup_reason || null
        ]
      );

      followupCreated = true;

      try {
        await logActivity(
          'doctor',
          doctorId,
          req.doctor ? req.doctor.name : null,
          'Schedule follow-up appointment',
          'appointment',
          result.insertId,
          `Follow-up of appointment #${appointmentId} on ${followup_date} at ${fuHHMM}`
        );
      } catch (e) {}

      // 3f) Email to patient about follow-up
      if (appt.user_email) {
        const fuDisplay = `${followup_date} at ${fuHHMM}`;
        const subject = `Follow-up appointment scheduled with ${appt.doctor_name}`;
        const html = `
          <p>Hi ${appt.user_name},</p>
          <p>Your follow-up appointment has been <strong>scheduled</strong>:</p>
          <ul>
            <li>Doctor: <strong>${appt.doctor_name}</strong> (${appt.specialty_name})</li>
            <li>Date &amp; Time: <strong>${fuDisplay}</strong></li>
          </ul>
          ${followup_reason ? `<p>Reason: ${followup_reason}</p>` : ''}
          <p>Please reach the clinic a few minutes before your appointment time.</p>
          <p>– MediBook</p>
        `;
        sendMail({ to: appt.user_email, subject, html });
      }
    }

    req.session.success = followupCreated
      ? 'Notes updated and follow-up scheduled.'
      : 'Notes updated.';
    res.redirect('/doctor/appointments');
  } catch (err) {
    console.error('Doctor notes save error:', err);
    req.session.error = 'Failed to save notes or schedule follow-up.';
    res.redirect(`/doctor/appointments/${appointmentId}/notes`);
  }
});

// ========== TESTIMONIALS (PUBLIC) ==========

// Show testimonials page (agar yeh pehle se hai to rehne do)
app.get('/testimonials', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT t.*, u.name AS user_name
       FROM testimonials t
       LEFT JOIN users u ON t.user_id = u.id
       WHERE t.is_approved = 1
       ORDER BY t.created_at DESC
       LIMIT 30`
    );
    res.render('testimonials', { testimonials: rows });
  } catch (err) {
    console.error('Testimonials error:', err);
    res.status(500).send('Server error');
  }
});

// YEH WALA POST ROUTE SIRF EK HI HONA CHAHIYE
app.post('/testimonials', requireLogin, async (req, res) => {
  const rawMessage = req.body.message || '';
  const message = rawMessage.trim();

  if (!message || message.length < 10) {
    req.session.error = 'Please write at least 10 characters in your feedback.';
    return res.redirect('/testimonials');
  }

  let rating = parseInt(req.body.rating, 10);
  if (isNaN(rating) || rating < 1 || rating > 5) {
    rating = 5;
  }

  try {
    console.log('Session userId in testimonial:', req.session.userId, typeof req.session.userId);

    const [[userRow]] = await db.query(
      'SELECT name FROM users WHERE id = ?',
      [req.session.userId]
    );
    const displayName = userRow ? userRow.name : 'Anonymous';

    // SABSE IMPORTANT PART – yahan koi ${} nahi, sirf ? placeholders
    await db.query(
      `INSERT INTO testimonials (user_id, name, message, rating, is_approved)
       VALUES (?, ?, ?, ?, 1)`,
      [req.session.userId, displayName, message, rating]
    );

    req.session.success = 'Thank you for your feedback!';
    res.redirect('/testimonials');
  } catch (err) {
    console.error('Testimonials submit error:', err.sqlMessage || err.message, err);
    req.session.error = 'Could not submit feedback.';
    res.redirect('/testimonials');
  }
});

// ========== TESTIMONIALS (ADMIN) ==========
app.get('/admin/testimonials', requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT t.*, u.email AS user_email
       FROM testimonials t
       LEFT JOIN users u ON t.user_id = u.id
       ORDER BY t.created_at DESC`
    );
    res.render('admin_testimonials', { testimonials: rows });
  } catch (err) {
    console.error('Admin testimonials error:', err);
    res.status(500).send('Server error');
  }
});

app.post('/admin/testimonials/:id/status', requireAdmin, async (req, res) => {
  const id = req.params.id;
  const { action } = req.body;

  try {
    if (action === 'approve') {
      await db.query('UPDATE testimonials SET is_approved = 1 WHERE id = ?', [id]);
    } else if (action === 'hide') {
      await db.query('UPDATE testimonials SET is_approved = 0 WHERE id = ?', [id]);
    } else if (action === 'delete') {
      await db.query('DELETE FROM testimonials WHERE id = ?', [id]);
    }
    req.session.success = 'Updated.';
    res.redirect('/admin/testimonials');
  } catch (err) {
    console.error('Admin testimonial status error:', err);
    req.session.error = 'Failed to update testimonial.';
    res.redirect('/admin/testimonials');
  }
});

// ======== FAVORITES (FAVOURITE DOCTORS) =========

// Add to favourites
app.post('/doctors/:id/favorite', requireLogin, async (req, res) => {
  const doctorId = parseInt(req.params.id, 10);
  if (Number.isNaN(doctorId)) {
    return res.redirect('back');
  }
  try {
    await db.query(
      'INSERT IGNORE INTO favorites (user_id, doctor_id) VALUES (?, ?)',
      [req.session.userId, doctorId]
    );
  } catch (err) {
    console.error('Add favorite error:', err);
  }
  res.redirect('back');
});

// Remove from favourites
app.post('/doctors/:id/unfavorite', requireLogin, async (req, res) => {
  const doctorId = parseInt(req.params.id, 10);
  if (Number.isNaN(doctorId)) {
    return res.redirect('back');
  }
  try {
    await db.query(
      'DELETE FROM favorites WHERE user_id = ? AND doctor_id = ?',
      [req.session.userId, doctorId]
    );
  } catch (err) {
    console.error('Remove favorite error:', err);
  }
  res.redirect('back');
});

// List favourite doctors for user
app.get('/favorites', requireLogin, async (req, res) => {
  try {
    const [doctors] = await db.query(
      `SELECT d.*, s.name AS specialty_name
       FROM favorites f
       JOIN doctors d ON f.doctor_id = d.id
       JOIN specialties s ON d.specialty_id = s.id
       WHERE f.user_id = ?
       ORDER BY d.name`,
      [req.session.userId]
    );
    res.render('favorites', { doctors });
  } catch (err) {
    console.error('Favorites list error:', err);
    res.status(500).send('Server error');
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});