const express = require('express');
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Get user's favorite stores
router.get('/', authenticateToken, async (req, res) => {
  try {
    const [favorites] = await pool.query(
      `SELECT f.*, 
       s.name as store_name, s.avatar_url, s.phone_number, s.address,
       u.full_name as owner_name,
       (SELECT COUNT(*) FROM products WHERE store_id = s.id AND is_active = TRUE) as product_count
       FROM favorites f
       JOIN stores s ON f.store_id = s.id
       JOIN users u ON s.user_id = u.id
       WHERE f.user_id = ?
       ORDER BY f.created_at DESC`,
      [req.user.user_id]
    );

    res.json({ favorites });
  } catch (error) {
    console.error('Get favorites error:', error);
    res.status(500).json({ error: 'Failed to get favorites' });
  }
});

// Add store to favorites
router.post('/:storeId', authenticateToken, async (req, res) => {
  try {
    const { storeId } = req.params;

    // Check store exists
    const [stores] = await pool.query(
      'SELECT id FROM stores WHERE id = ? AND is_active = TRUE',
      [storeId]
    );

    if (stores.length === 0) {
      return res.status(404).json({ error: 'Store not found' });
    }

    // Check if already favorited
    const [existing] = await pool.query(
      'SELECT id FROM favorites WHERE user_id = ? AND store_id = ?',
      [req.user.user_id, storeId]
    );

    if (existing.length > 0) {
      return res.status(400).json({ error: 'Store already in favorites' });
    }

    await pool.query(
      'INSERT INTO favorites (user_id, store_id) VALUES (?, ?)',
      [req.user.user_id, storeId]
    );

    // Get store owner to notify
    const [storeOwner] = await pool.query(
      'SELECT user_id FROM stores WHERE id = ?',
      [storeId]
    );

    const [user] = await pool.query(
      'SELECT full_name FROM users WHERE id = ?',
      [req.user.user_id]
    );

    // Notify store owner about new favorite
    if (storeOwner[0] && storeOwner[0].user_id !== req.user.user_id) {
      await pool.query(
        `INSERT INTO notifications (user_id, type, title, message, reference_id)
         VALUES (?, 'favorite', ?, ?, ?)`,
        [storeOwner[0].user_id, 'Toko Baru Difavoritkan',
         `${user[0].full_name || 'Seseorang'} baru saja memfavoritkan toko Anda.`, storeId]
      );
    }

    res.status(201).json({ message: 'Store added to favorites' });
  } catch (error) {
    console.error('Add favorite error:', error);
    res.status(500).json({ error: 'Failed to add favorite' });
  }
});

// Remove store from favorites
router.delete('/:storeId', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM favorites WHERE user_id = ? AND store_id = ?',
      [req.user.user_id, req.params.storeId]
    );

    if (result[0].affectedRows === 0) {
      return res.status(404).json({ error: 'Favorite not found' });
    }

    res.json({ message: 'Store removed from favorites' });
  } catch (error) {
    console.error('Remove favorite error:', error);
    res.status(500).json({ error: 'Failed to remove favorite' });
  }
});

// Check if store is favorited
router.get('/check/:storeId', authenticateToken, async (req, res) => {
  try {
    const [fav] = await pool.query(
      'SELECT id FROM favorites WHERE user_id = ? AND store_id = ?',
      [req.user.user_id, req.params.storeId]
    );

    res.json({ is_favorited: fav.length > 0 });
  } catch (error) {
    console.error('Check favorite error:', error);
    res.status(500).json({ error: 'Failed to check favorite' });
  }
});

module.exports = router;