const express = require('express');
const { pool } = require('../db');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// Semua route admin butuh auth + role admin
router.use(authenticateToken, requireAdmin);

// Daftar user yang minta jadi penjual (menunggu approval)
router.get('/sellers/pending', async (req, res) => {
  try {
    const [users] = await pool.query(
      `SELECT id, email, full_name, phone_number, email_verified, seller_status, created_at
       FROM users
       WHERE seller_status = 'pending'
       ORDER BY created_at ASC`
    );
    res.json({ users });
  } catch (error) {
    console.error('Get pending sellers error:', error);
    res.status(500).json({ error: 'Failed to get pending sellers' });
  }
});

// Daftar semua seller (approved) untuk keperluan kelola
router.get('/sellers', async (req, res) => {
  try {
    const [users] = await pool.query(
      `SELECT id, email, full_name, phone_number, email_verified, seller_status, created_at
       FROM users
       WHERE seller_status IN ('approved', 'pending', 'rejected')
       ORDER BY created_at DESC`
    );
    res.json({ users });
  } catch (error) {
    console.error('Get sellers error:', error);
    res.status(500).json({ error: 'Failed to get sellers' });
  }
});

// Approve user menjadi penjual
router.post('/sellers/:id/approve', async (req, res) => {
  try {
    const userId = req.params.id;
    const [users] = await pool.query(
      'SELECT id, role FROM users WHERE id = ?',
      [userId]
    );

    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = users[0];
    const newRole = user.role === 'admin' ? 'admin' : 'seller';

    await pool.query(
      'UPDATE users SET role = ?, seller_status = ? WHERE id = ?',
      [newRole, 'approved', userId]
    );

    // Notifikasi ke user
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, message)
       VALUES (?, 'system', 'Status Penjual Disetujui', 'Selamat! Anda sudah bisa membuka toko dan menjual produk di Lapak.')`,
      [userId]
    );

    res.json({ message: 'User approved as seller' });
  } catch (error) {
    console.error('Approve seller error:', error);
    res.status(500).json({ error: 'Failed to approve seller' });
  }
});

// Reject / tolak user jadi penjual
router.post('/sellers/:id/reject', async (req, res) => {
  try {
    const userId = req.params.id;
    const [users] = await pool.query(
      'SELECT id FROM users WHERE id = ?',
      [userId]
    );

    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    await pool.query(
      "UPDATE users SET seller_status = 'rejected' WHERE id = ?",
      [userId]
    );

    await pool.query(
      `INSERT INTO notifications (user_id, type, title, message)
       VALUES (?, 'system', 'Status Penjual Ditolak', 'Permintaan menjadi penjual ditolak. Hubungi admin jika ada kendala.')`,
      [userId]
    );

    res.json({ message: 'Seller request rejected' });
  } catch (error) {
    console.error('Reject seller error:', error);
    res.status(500).json({ error: 'Failed to reject seller' });
  }
});

// Verifikasi nomor WhatsApp user (manual oleh admin)
router.post('/users/:id/verify-wa', async (req, res) => {
  try {
    const userId = req.params.id;
    const { verified = true } = req.body;

    const [users] = await pool.query('SELECT id FROM users WHERE id = ?', [userId]);
    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    await pool.query('UPDATE users SET wa_verified = ? WHERE id = ?', [verified ? 1 : 0, userId]);

    await pool.query(
      `INSERT INTO notifications (user_id, type, title, message)
       VALUES (?, 'system', ?, ?)`,
      [userId,
       verified ? 'Nomor WhatsApp Terverifikasi' : 'Verifikasi WhatsApp Dicabut',
       verified
         ? 'Nomor WhatsApp Anda telah diverifikasi admin. Anda kini bisa mengajukan menjadi penjual.'
         : 'Verifikasi WhatsApp Anda dicabut admin. Hubungi admin untuk info lebih lanjut.']
    );

    res.json({ message: verified ? 'WhatsApp number verified' : 'WhatsApp verification revoked' });
  } catch (error) {
    console.error('Verify WA error:', error);
    res.status(500).json({ error: 'Failed to verify WhatsApp number' });
  }
});

// Nonaktifkan akun user
router.post('/users/:id/deactivate', async (req, res) => {
  try {
    const userId = req.params.id;
    const [users] = await pool.query('SELECT id FROM users WHERE id = ?', [userId]);
    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    await pool.query('UPDATE users SET is_active = FALSE WHERE id = ?', [userId]);

    await pool.query(
      `INSERT INTO notifications (user_id, type, title, message)
       VALUES (?, 'system', 'Akun Dinonaktifkan', 'Akun Anda dinonaktifkan oleh admin. Hubungi admin jika ada kendala.')`,
      [userId]
    );

    res.json({ message: 'User deactivated' });
  } catch (error) {
    console.error('Deactivate user error:', error);
    res.status(500).json({ error: 'Failed to deactivate user' });
  }
});

// Aktifkan kembali akun user
router.post('/users/:id/activate', async (req, res) => {
  try {
    const userId = req.params.id;
    const [users] = await pool.query('SELECT id FROM users WHERE id = ?', [userId]);
    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    await pool.query('UPDATE users SET is_active = TRUE WHERE id = ?', [userId]);

    await pool.query(
      `INSERT INTO notifications (user_id, type, title, message)
       VALUES (?, 'system', 'Akun Diaktifkan', 'Akun Anda telah diaktifkan kembali oleh admin.')`,
      [userId]
    );

    res.json({ message: 'User activated' });
  } catch (error) {
    console.error('Activate user error:', error);
    res.status(500).json({ error: 'Failed to activate user' });
  }
});

// Daftar semua user untuk kelola akun
router.get('/users', async (req, res) => {
  try {
    const { search = '', status } = req.query;

    let whereClause = 'WHERE 1=1';
    const params = [];

    if (search) {
      whereClause += ' AND (email LIKE ? OR full_name LIKE ? OR phone_number LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    if (status === 'active') {
      whereClause += ' AND is_active = TRUE';
    } else if (status === 'inactive') {
      whereClause += ' AND is_active = FALSE';
    }

    const [users] = await pool.query(
      `SELECT id, email, full_name, phone_number, role, email_verified, wa_verified, is_active, seller_status, avatar_url, created_at
       FROM users ${whereClause}
       ORDER BY created_at DESC
       LIMIT 100`,
      params
    );

    res.json({ users });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Failed to get users' });
  }
});

// Insight / ikhtisar aplikasi
router.get('/insights', async (req, res) => {
  try {
    const [users] = await pool.query('SELECT COUNT(*) as count FROM users');
    const [sellers] = await pool.query("SELECT COUNT(*) as count FROM users WHERE role IN ('seller','both')");
    const [pendingSellers] = await pool.query("SELECT COUNT(*) as count FROM users WHERE seller_status = 'pending'");
    const [stores] = await pool.query('SELECT COUNT(*) as count FROM stores');
    const [openStores] = await pool.query('SELECT COUNT(*) as count FROM stores WHERE is_open = TRUE');
    const [products] = await pool.query('SELECT COUNT(*) as count FROM products WHERE is_active = TRUE');
    const [orders] = await pool.query('SELECT COUNT(*) as count FROM orders');
    const [completedOrders] = await pool.query("SELECT COUNT(*) as count FROM orders WHERE status = 'completed'");
    const [revenue] = await pool.query("SELECT COALESCE(SUM(total_price),0) as total FROM orders WHERE status = 'completed'");
    const [todayOrders] = await pool.query(
      'SELECT COUNT(*) as count FROM orders WHERE DATE(created_at) = CURDATE()'
    );

    res.json({
      users: users[0].count,
      sellers: sellers[0].count,
      pending_sellers: pendingSellers[0].count,
      stores: stores[0].count,
      open_stores: openStores[0].count,
      products: products[0].count,
      orders: orders[0].count,
      completed_orders: completedOrders[0].count,
      revenue: revenue[0].total,
      today_orders: todayOrders[0].count
    });
  } catch (error) {
    console.error('Get insights error:', error);
    res.status(500).json({ error: 'Failed to get insights' });
  }
});

// Ambil pengaturan aplikasi
router.get('/settings', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT setting_key, setting_value FROM app_settings');
    const settings = {};
    for (const row of rows) {
      settings[row.setting_key] = row.setting_value;
    }
    res.json({ settings });
  } catch (error) {
    console.error('Get settings error:', error);
    res.status(500).json({ error: 'Failed to get settings' });
  }
});

// Update pengaturan aplikasi (no WA admin, slogan, dll)
router.put('/settings', async (req, res) => {
  try {
    const { settings } = req.body;
    if (!settings || typeof settings !== 'object') {
      return res.status(400).json({ error: 'Settings object is required' });
    }

    for (const [key, value] of Object.entries(settings)) {
      await pool.query(
        `INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
        [key, String(value)]
      );
    }

    const [rows] = await pool.query('SELECT setting_key, setting_value FROM app_settings');
    const updated = {};
    for (const row of rows) {
      updated[row.setting_key] = row.setting_value;
    }

    res.json({ message: 'Settings updated', settings: updated });
  } catch (error) {
    console.error('Update settings error:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

module.exports = router;
