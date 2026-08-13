const express = require('express');
const multer = require('multer');
const path = require('path');
const { pool } = require('../db');
const { authenticateToken, optionalAuth } = require('../middleware/auth');
const { normalizePhone } = require('../utils/phone');

const router = express.Router();

// Configure multer for file uploads
const { imageFileFilter } = require('../utils/upload');
const storage = multer.memoryStorage();
const upload = multer({ 
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: imageFileFilter
});

// Get all stores (with pagination, search, filters)
router.get('/', optionalAuth, async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 20, 
      search = '', 
      category = '',
      latitude,
      longitude,
      radius = 10 // km
    } = req.query;

    const offset = (page - 1) * limit;
    let whereClause = 'WHERE s.is_active = TRUE AND s.is_open = TRUE';
    const params = [];

    if (search) {
      whereClause += ' AND (s.name LIKE ? OR s.description LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    // Add distance calculation if location provided
    let selectFields = `
      s.*, 
      u.full_name as owner_name,
      u.phone_number as owner_phone,
      (SELECT COUNT(*) FROM products WHERE store_id = s.id AND is_active = TRUE) as product_count
    `;

    if (latitude && longitude) {
      selectFields += `,
        (6371 * acos(cos(radians(?)) * cos(radians(s.latitude)) * cos(radians(s.longitude) - radians(?)) + sin(radians(?)) * sin(radians(s.latitude)))) AS distance
      `;
      params.push(latitude, longitude, latitude);
      whereClause += ' AND s.latitude IS NOT NULL AND s.longitude IS NOT NULL';
      whereClause += ' HAVING distance <= ?';
      params.push(radius);
    }

    const [stores] = await pool.query(
      `SELECT ${selectFields} FROM stores s 
       JOIN users u ON s.user_id = u.id 
       ${whereClause}
       ORDER BY ${latitude && longitude ? 'distance' : 's.created_at'} ASC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), parseInt(offset)]
    );

    const [total] = await pool.query(
      `SELECT COUNT(*) as count FROM stores s JOIN users u ON s.user_id = u.id ${whereClause}`,
      params
    );

    res.json({
      stores,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: total[0].count,
        pages: Math.ceil(total[0].count / limit)
      }
    });
  } catch (error) {
    console.error('Get stores error:', error);
    res.status(500).json({ error: 'Failed to get stores' });
  }
});

// Get store by ID
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const [stores] = await pool.query(
      `SELECT s.*, u.full_name as owner_name, u.phone_number as owner_phone, u.email as owner_email
       FROM stores s
       JOIN users u ON s.user_id = u.id
       WHERE s.id = ? AND s.is_active = TRUE`,
      [req.params.id]
    );

    if (stores.length === 0) {
      return res.status(404).json({ error: 'Store not found' });
    }

    // Get store products count
    const [productCount] = await pool.query(
      'SELECT COUNT(*) as count FROM products WHERE store_id = ? AND is_active = TRUE',
      [req.params.id]
    );

    // Check if current user favorited this store
    let isFavorited = false;
    if (req.user) {
      const [fav] = await pool.query(
        'SELECT id FROM favorites WHERE user_id = ? AND store_id = ?',
        [req.user.user_id, req.params.id]
      );
      isFavorited = fav.length > 0;
    }

    res.json({
      store: {
        ...stores[0],
        product_count: productCount[0].count,
        is_favorited: isFavorited
      }
    });
  } catch (error) {
    console.error('Get store error:', error);
    res.status(500).json({ error: 'Failed to get store' });
  }
});

// Create store (seller only)
router.post('/', authenticateToken, upload.single('avatar'), async (req, res) => {
  const connection = await pool.getConnection();
  try {
    // Check if user is seller
    const [users] = await connection.query(
      'SELECT role, phone_number FROM users WHERE id = ?',
      [req.user.user_id]
    );

    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!['seller', 'both'].includes(users[0].role)) {
      return res.status(403).json({ error: 'Only sellers can create stores. Please verify your email and become a seller first.' });
    }

    // Check if user already has a store
    const [existingStore] = await connection.query(
      'SELECT id FROM stores WHERE user_id = ?',
      [req.user.user_id]
    );

    if (existingStore.length > 0) {
      return res.status(400).json({ error: 'You already have a store. Each user can only have one store.' });
    }

    const { name, description, phone_number, address, latitude, longitude } = req.body;

    // Validate required fields
    if (!name || !phone_number) {
      return res.status(400).json({ error: 'Store name and phone number are required' });
    }

    // Use user's phone if not provided
    const storePhone = normalizePhone(phone_number || users[0].phone_number);
    if (!storePhone) {
      return res.status(400).json({ error: 'Phone number is required for store (for digital receipts)' });
    }

    // Handle avatar upload (in production, upload to cloud storage)
    let avatarUrl = null;
    if (req.file) {
      const ext = path.extname(req.file.originalname) || '.jpg';
      avatarUrl = `/uploads/stores/${req.user.user_id}_${Date.now()}${ext}`;
    }

    const [result] = await connection.query(
      `INSERT INTO stores (user_id, name, description, phone_number, address, latitude, longitude, avatar_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.user.user_id, name, description || null, storePhone, address || null, 
       latitude || null, longitude || null, avatarUrl]
    );

    // Update user role to seller if they were buyer
    if (users[0].role === 'buyer') {
      await connection.query(
        'UPDATE users SET role = \'both\' WHERE id = ?',
        [req.user.user_id]
      );
    }

    res.status(201).json({
      message: 'Store created successfully',
      store_id: result.insertId
    });
  } catch (error) {
    console.error('Create store error:', error);
    res.status(500).json({ error: 'Failed to create store' });
  } finally {
    connection.release();
  }
});

// Get current user's store
router.get('/my/store', authenticateToken, async (req, res) => {
  try {
    const [stores] = await pool.query(
      'SELECT * FROM stores WHERE user_id = ?',
      [req.user.user_id]
    );

    if (stores.length === 0) {
      return res.status(404).json({ error: 'No store found. Create one first.' });
    }

    res.json({ store: stores[0] });
  } catch (error) {
    console.error('Get my store error:', error);
    res.status(500).json({ error: 'Failed to get store' });
  }
});

// Update store
router.put('/my/store', authenticateToken, upload.single('avatar'), async (req, res) => {
  try {
    const [stores] = await pool.query(
      'SELECT * FROM stores WHERE user_id = ?',
      [req.user.user_id]
    );

    if (stores.length === 0) {
      return res.status(404).json({ error: 'Store not found' });
    }

    const { name, description, phone_number, address, latitude, longitude, is_open } = req.body;
    const normalizedPhone = normalizePhone(phone_number);

    // Validate phone number
    if (phone_number && normalizedPhone && normalizedPhone.length < 12) {
      return res.status(400).json({ error: 'Valid phone number is required for digital receipts' });
    }

    let avatarUrl = stores[0].avatar_url;
    if (req.file) {
      const ext = path.extname(req.file.originalname) || '.jpg';
      avatarUrl = `/uploads/stores/${req.user.user_id}_${Date.now()}${ext}`;
    }

    await pool.query(
      `UPDATE stores SET name = ?, description = ?, phone_number = ?, address = ?, 
       latitude = ?, longitude = ?, avatar_url = ?, is_active = ?, is_open = ?
       WHERE user_id = ?`,
      [name || stores[0].name, description || stores[0].description, 
       normalizedPhone || stores[0].phone_number, address || stores[0].address,
       latitude || stores[0].latitude, longitude || stores[0].longitude,
       avatarUrl, is_active !== undefined ? is_active : stores[0].is_active,
       is_open !== undefined ? is_open : stores[0].is_open,
       req.user.user_id]
    );

    const [updated] = await pool.query('SELECT * FROM stores WHERE user_id = ?', [req.user.user_id]);
    res.json({ store: updated[0] });
  } catch (error) {
    console.error('Update store error:', error);
    res.status(500).json({ error: 'Failed to update store' });
  }
});

// Toggle buka/tutup toko
router.post('/my/store/toggle-open', authenticateToken, async (req, res) => {
  try {
    const [stores] = await pool.query(
      'SELECT id, is_open FROM stores WHERE user_id = ?',
      [req.user.user_id]
    );

    if (stores.length === 0) {
      return res.status(404).json({ error: 'Store not found' });
    }

    const newOpen = !stores[0].is_open;
    await pool.query('UPDATE stores SET is_open = ? WHERE id = ?', [newOpen, stores[0].id]);

    const [updated] = await pool.query('SELECT * FROM stores WHERE id = ?', [stores[0].id]);
    res.json({ store: updated[0] });
  } catch (error) {
    console.error('Toggle store open error:', error);
    res.status(500).json({ error: 'Failed to toggle store status' });
  }
});

module.exports = router;