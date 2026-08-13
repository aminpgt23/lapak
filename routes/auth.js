const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const nodemailer = require('nodemailer');
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/auth');
const { normalizePhone } = require('../utils/phone');

const router = express.Router();

// Upload avatar profile — terima semua type gambar
const { imageFileFilter } = require('../utils/upload');

const uploadAvatar = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: imageFileFilter
});

// Generate verification token
function generateVerificationToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Send verification email
async function sendVerificationEmail(email, token) {
  const verificationUrl = `${process.env.APP_URL}/api/auth/verify-email?token=${token}`;
  
  // For development, just log the URL
  console.log(`Verification email to ${email}: ${verificationUrl}`);
  
  // Uncomment and configure for production
  // const transporter = nodemailer.createTransport({
  //   host: process.env.EMAIL_HOST,
  //   port: process.env.EMAIL_PORT,
  //   secure: false,
  //   auth: {
  //     user: process.env.EMAIL_USER,
  //     pass: process.env.EMAIL_PASS
  //   }
  // });
  // 
  // await transporter.sendMail({
  //   from: process.env.EMAIL_FROM,
  //   to: email,
  //   subject: 'Verify your Lapak account',
  //   html: `
  //     <h1>Welcome to Lapak!</h1>
  //     <p>Please click the link below to verify your email address:</p>
  //     <a href="${verificationUrl}">${verificationUrl}</a>
  //     <p>This link expires in 24 hours.</p>
  //   `
  // });
}

// Register
router.post('/register', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { email, password, full_name, phone_number, agree_terms } = req.body;

    // Validation
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    if (agree_terms !== true) {
      return res.status(400).json({ error: 'Anda harus menyetujui Syarat & Ketentuan untuk membuat akun' });
    }

    const normalizedPhone = normalizePhone(phone_number);

    await connection.beginTransaction();

    // Check if email exists
    const [existing] = await connection.query(
      'SELECT id FROM users WHERE email = ?',
      [email]
    );

    if (existing.length > 0) {
      await connection.rollback();
      return res.status(400).json({ error: 'Email already registered' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Insert user
    const [result] = await connection.query(
      `INSERT INTO users (email, password_hash, full_name, phone_number, agreed_terms_at)
       VALUES (?, ?, ?, ?, NOW())`,
      [email, passwordHash, full_name || null, normalizedPhone]
    );

    await connection.commit();

    res.status(201).json({
      message: 'Registrasi berhasil. Silakan login. Untuk menjadi penjual, nomor WhatsApp Anda harus diverifikasi admin.',
      user_id: result.insertId
    });
  } catch (error) {
    await connection.rollback();
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  } finally {
    connection.release();
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const [users] = await pool.query(
      'SELECT id, email, password_hash, full_name, phone_number, role, email_verified, wa_verified, is_active, seller_status FROM users WHERE email = ?',
      [email]
    );

    if (users.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = users[0];

    if (!user.is_active) {
      return res.status(403).json({ error: 'Akun Anda dinonaktifkan. Hubungi admin.' });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Generate JWT
    const token = jwt.sign(
      { 
        user_id: user.id, 
        email: user.email, 
        role: user.role,
        email_verified: user.email_verified,
        wa_verified: user.wa_verified
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    // Remove password hash from response
    delete user.password_hash;

    res.json({
      message: 'Login successful',
      token,
      user
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Verify email
router.get('/verify-email', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { token } = req.query;

    if (!token) {
      return res.status(400).send('Verification token is required');
    }

    const [users] = await connection.query(
      'SELECT id, email_verified FROM users WHERE verification_token = ? AND verification_expires > NOW()',
      [token]
    );

    if (users.length === 0) {
      return res.status(400).send('Invalid or expired verification token');
    }

    if (users[0].email_verified) {
      return res.send('Email already verified. You can now log in.');
    }

    await connection.query(
      'UPDATE users SET email_verified = TRUE, verification_token = NULL, verification_expires = NULL WHERE id = ?',
      [users[0].id]
    );

    res.send('Email verified successfully! You can now log in and open your store.');
  } catch (error) {
    console.error('Email verification error:', error);
    res.status(500).send('Verification failed');
  } finally {
    connection.release();
  }
});

// Resend verification email
router.post('/resend-verification', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.user_id;

    const [users] = await pool.query(
      'SELECT email, email_verified FROM users WHERE id = ?',
      [userId]
    );

    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (users[0].email_verified) {
      return res.status(400).json({ error: 'Email already verified' });
    }

    const verificationToken = generateVerificationToken();
    const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await pool.query(
      'UPDATE users SET verification_token = ?, verification_expires = ? WHERE id = ?',
      [verificationToken, verificationExpires, userId]
    );

    await sendVerificationEmail(users[0].email, verificationToken);

    res.json({ message: 'Verification email sent' });
  } catch (error) {
    console.error('Resend verification error:', error);
    res.status(500).json({ error: 'Failed to send verification email' });
  }
});

// Get current user profile
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const [users] = await pool.query(
      'SELECT id, email, full_name, phone_number, role, email_verified, wa_verified, is_active, avatar_url, seller_status, created_at FROM users WHERE id = ?',
      [req.user.user_id]
    );

    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user: users[0] });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Failed to get profile' });
  }
});

// Update profile (bisa include foto avatar)
router.put('/profile', authenticateToken, uploadAvatar.single('avatar'), async (req, res) => {
  try {
    const { full_name, phone_number } = req.body;
    const normalizedPhone = normalizePhone(phone_number);

    let avatarUrl = null;
    if (req.file) {
      const ext = path.extname(req.file.originalname) || '.jpg';
      avatarUrl = `/uploads/users/${req.user.user_id}_${Date.now()}${ext}`;
    }

    await pool.query(
      `UPDATE users SET full_name = COALESCE(?, full_name), phone_number = COALESCE(?, phone_number), 
       avatar_url = COALESCE(?, avatar_url) WHERE id = ?`,
      [full_name || null, normalizedPhone, avatarUrl, req.user.user_id]
    );

    const [users] = await pool.query(
      'SELECT id, email, full_name, phone_number, role, email_verified, wa_verified, is_active, avatar_url, seller_status FROM users WHERE id = ?',
      [req.user.user_id]
    );

    res.json({ user: users[0] });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Update role to seller (after WA verified by admin + approval)
router.post('/become-seller', authenticateToken, async (req, res) => {
  try {
    const [users] = await pool.query(
      'SELECT wa_verified, seller_status FROM users WHERE id = ?',
      [req.user.user_id]
    );

    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!users[0].wa_verified) {
      return res.status(400).json({ error: 'Nomor WhatsApp Anda belum diverifikasi admin. Hubungi admin untuk verifikasi.' });
    }

    if (users[0].seller_status === 'approved') {
      return res.json({ message: 'You are already approved as a seller', seller_status: 'approved' });
    }

    // Set status pending — butuh persetujuan admin
    await pool.query(
      "UPDATE users SET seller_status = 'pending' WHERE id = ?",
      [req.user.user_id]
    );

    res.json({
      message: 'Permintaan menjadi penjual terkirim. Tunggu persetujuan admin.',
      seller_status: 'pending'
    });
  } catch (error) {
    console.error('Become seller error:', error);
    res.status(500).json({ error: 'Failed to update role' });
  }
});

module.exports = router;