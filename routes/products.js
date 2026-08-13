const express = require('express');
const multer = require('multer');
const { pool } = require('../db');
const { authenticateToken, optionalAuth } = require('../middleware/auth');
const { uploadImage, deleteImage } = require('../utils/storage');

const router = express.Router();

// Configure multer for product images
const { imageFileFilter } = require('../utils/upload');
const storage = multer.memoryStorage();
const upload = multer({ 
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: imageFileFilter
});

// Get products (with filters)
router.get('/', optionalAuth, async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 20, 
      store_id,
      category,
      search = '',
      min_price,
      max_price,
      condition_type
    } = req.query;

    const offset = (page - 1) * limit;
    let whereClause = 'WHERE p.is_active = TRUE AND s.is_active = TRUE AND s.is_open = TRUE';
    const params = [];

    if (store_id) {
      whereClause += ' AND p.store_id = ?';
      params.push(store_id);
    }

    if (category) {
      whereClause += ' AND p.category = ?';
      params.push(category);
    }

    if (search) {
      whereClause += ' AND (p.name LIKE ? OR p.description LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    if (min_price) {
      whereClause += ' AND p.price >= ?';
      params.push(min_price);
    }

    if (max_price) {
      whereClause += ' AND p.price <= ?';
      params.push(max_price);
    }

    if (condition_type) {
      whereClause += ' AND p.condition_type = ?';
      params.push(condition_type);
    }

    const [products] = await pool.query(
      `SELECT p.*, s.name as store_name, s.phone_number as store_phone,
       (SELECT image_url FROM product_images WHERE product_id = p.id AND is_primary = TRUE LIMIT 1) as primary_image
       FROM products p
       JOIN stores s ON p.store_id = s.id
       ${whereClause}
       ORDER BY p.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), parseInt(offset)]
    );

    // Get images for each product
    for (let product of products) {
      const [images] = await pool.query(
        'SELECT image_url, is_primary FROM product_images WHERE product_id = ? ORDER BY sort_order, is_primary DESC',
        [product.id]
      );
      product.images = images;
    }

    const [total] = await pool.query(
      `SELECT COUNT(*) as count FROM products p JOIN stores s ON p.store_id = s.id ${whereClause}`,
      params
    );

    res.json({
      products,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: total[0].count,
        pages: Math.ceil(total[0].count / limit)
      }
    });
  } catch (error) {
    console.error('Get products error:', error);
    res.status(500).json({ error: 'Failed to get products' });
  }
});

// Get product by ID
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const [products] = await pool.query(
      `SELECT p.*, s.name as store_name, s.phone_number as store_phone, s.address as store_address,
       u.id as seller_id, u.full_name as seller_name
       FROM products p
       JOIN stores s ON p.store_id = s.id
       JOIN users u ON s.user_id = u.id
       WHERE p.id = ? AND p.is_active = TRUE`,
      [req.params.id]
    );

    if (products.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const [images] = await pool.query(
      'SELECT id, image_url, is_primary FROM product_images WHERE product_id = ? ORDER BY sort_order, is_primary DESC',
      [req.params.id]
    );

    res.json({ product: { ...products[0], images } });
  } catch (error) {
    console.error('Get product error:', error);
    res.status(500).json({ error: 'Failed to get product' });
  }
});

// Create product (seller only)
router.post('/', authenticateToken, upload.array('images', 5), async (req, res) => {
  const connection = await pool.getConnection();
  try {
    // Check if user owns a store
    const [stores] = await connection.query(
      'SELECT id FROM stores WHERE user_id = ? AND is_active = TRUE',
      [req.user.user_id]
    );

    if (stores.length === 0) {
      return res.status(403).json({ error: 'You must have an active store to add products' });
    }

    const storeId = stores[0].id;
    const { name, description, price, stock, category, condition_type, delivery_type, delivery_fee } = req.body;

    // Validation
    if (!name || !price) {
      return res.status(400).json({ error: 'Product name and price are required' });
    }

    if (price <= 0) {
      return res.status(400).json({ error: 'Price must be greater than 0' });
    }

    const deliveryMode = delivery_type || 'pickup';
    if (!['pickup', 'delivery', 'both'].includes(deliveryMode)) {
      return res.status(400).json({ error: 'Invalid delivery type' });
    }

    let fee = 0;
    if (deliveryMode !== 'pickup') {
      fee = parseFloat(delivery_fee) || 0;
      if (fee < 0 || fee > 10000) {
        return res.status(400).json({ error: 'Ongkir maksimal Rp 10.000 dan tidak boleh negatif' });
      }
    }

    const [result] = await connection.query(
      `INSERT INTO products (store_id, name, description, price, stock, category, condition_type, delivery_type, delivery_fee)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [storeId, name, description || null, price, stock || 0, category || null, condition_type || 'new', deliveryMode, fee]
    );

    const productId = result.insertId;

    // Handle images
    if (req.files && req.files.length > 0) {
      for (let i = 0; i < req.files.length; i++) {
        const file = req.files[i];
        const imageUrl = await uploadImage(file.buffer, 'products', file.originalname, `${productId}_${i}`);
        const isPrimary = i === 0;
        
        await connection.query(
          'INSERT INTO product_images (product_id, image_url, is_primary, sort_order) VALUES (?, ?, ?, ?)',
          [productId, imageUrl, isPrimary, i]
        );
      }
    }

    res.status(201).json({
      message: 'Product created successfully',
      product_id: productId
    });
  } catch (error) {
    console.error('Create product error:', error);
    res.status(500).json({ error: 'Failed to create product' });
  } finally {
    connection.release();
  }
});

// Update product
router.put('/:id', authenticateToken, upload.array('images', 5), async (req, res) => {
  try {
    // Check ownership
    const [products] = await pool.query(
      `SELECT p.* FROM products p
       JOIN stores s ON p.store_id = s.id
       WHERE p.id = ? AND s.user_id = ?`,
      [req.params.id, req.user.user_id]
    );

    if (products.length === 0) {
      return res.status(404).json({ error: 'Product not found or unauthorized' });
    }

    const { name, description, price, stock, category, condition_type, delivery_type, delivery_fee, is_active } = req.body;

    const deliveryMode = delivery_type || products[0].delivery_type || 'pickup';
    if (!['pickup', 'delivery', 'both'].includes(deliveryMode)) {
      return res.status(400).json({ error: 'Invalid delivery type' });
    }

    let fee = products[0].delivery_fee || 0;
    if (delivery_fee !== undefined) {
      fee = parseFloat(delivery_fee) || 0;
      if (fee < 0 || fee > 10000) {
        return res.status(400).json({ error: 'Ongkir maksimal Rp 10.000 dan tidak boleh negatif' });
      }
    }

    await pool.query(
      `UPDATE products SET name = ?, description = ?, price = ?, stock = ?, 
       category = ?, condition_type = ?, delivery_type = ?, delivery_fee = ?, is_active = ?
       WHERE id = ?`,
      [name, description, price, stock, category, condition_type, deliveryMode, fee, is_active, req.params.id]
    );

    // Handle new images
    if (req.files && req.files.length > 0) {
      for (let i = 0; i < req.files.length; i++) {
        const imageUrl = await uploadImage(req.files[i].buffer, 'products', req.files[i].originalname, `${req.params.id}_${Date.now()}_${i}`);
        const isPrimary = i === 0;
        
        await pool.query(
          'INSERT INTO product_images (product_id, image_url, is_primary, sort_order) VALUES (?, ?, ?, ?)',
          [req.params.id, imageUrl, isPrimary, i]
        );
      }
    }

    res.json({ message: 'Product updated successfully' });
  } catch (error) {
    console.error('Update product error:', error);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

// Delete product
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const [products] = await pool.query(
      `SELECT p.id FROM products p
       JOIN stores s ON p.store_id = s.id
       WHERE p.id = ? AND s.user_id = ?`,
      [req.params.id, req.user.user_id]
    );

    if (products.length === 0) {
      return res.status(404).json({ error: 'Product not found or unauthorized' });
    }

    // Soft delete
    await pool.query('UPDATE products SET is_active = FALSE WHERE id = ?', [req.params.id]);

    const [images] = await pool.query('SELECT image_url FROM product_images WHERE product_id = ?', [req.params.id]);
    for (const img of images) {
      await deleteImage(img.image_url);
    }

    res.json({ message: 'Product deleted successfully' });
  } catch (error) {
    console.error('Delete product error:', error);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

// Get seller's products
router.get('/my/products', authenticateToken, async (req, res) => {
  try {
    const [stores] = await pool.query(
      'SELECT id FROM stores WHERE user_id = ?',
      [req.user.user_id]
    );

    if (stores.length === 0) {
      return res.json({ products: [] });
    }

    const [products] = await pool.query(
      `SELECT p.*, 
       (SELECT image_url FROM product_images WHERE product_id = p.id AND is_primary = TRUE LIMIT 1) as primary_image
       FROM products p
       WHERE p.store_id = ?
       ORDER BY p.created_at DESC`,
      [stores[0].id]
    );

    for (let product of products) {
      const [images] = await pool.query(
        'SELECT image_url, is_primary FROM product_images WHERE product_id = ? ORDER BY sort_order',
        [product.id]
      );
      product.images = images;
    }

    res.json({ products });
  } catch (error) {
    console.error('Get my products error:', error);
    res.status(500).json({ error: 'Failed to get products' });
  }
});

module.exports = router;