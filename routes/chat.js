const express = require('express');
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Get conversations (list of orders the user has chatted about)
router.get('/conversations', authenticateToken, async (req, res) => {
  try {
    const [conversations] = await pool.query(
      `SELECT DISTINCT 
         o.id as order_id, o.order_number, o.status, o.product_id,
         p.name as product_name,
         (SELECT image_url FROM product_images WHERE product_id = o.product_id AND is_primary = TRUE LIMIT 1) as product_image,
         CASE 
           WHEN o.buyer_id = ? THEN 
             (SELECT full_name FROM users WHERE id = o.seller_id)
           ELSE 
             (SELECT full_name FROM users WHERE id = o.buyer_id)
         END as other_party_name,
         CASE 
           WHEN o.buyer_id = ? THEN o.seller_id
           ELSE o.buyer_id
         END as other_party_id,
         (SELECT message FROM chat_messages WHERE order_id = o.id ORDER BY created_at DESC LIMIT 1) as last_message,
         (SELECT created_at FROM chat_messages WHERE order_id = o.id ORDER BY created_at DESC LIMIT 1) as last_message_at,
         (SELECT COUNT(*) FROM chat_messages WHERE order_id = o.id AND sender_id != ? AND is_read = FALSE) as unread_count
       FROM orders o
       JOIN products p ON o.product_id = p.id
       WHERE o.buyer_id = ? OR o.seller_id = ?
       ORDER BY last_message_at DESC`,
      [req.user.user_id, req.user.user_id, req.user.user_id, req.user.user_id, req.user.user_id]
    );

    res.json({ conversations });
  } catch (error) {
    console.error('Get conversations error:', error);
    res.status(500).json({ error: 'Failed to get conversations' });
  }
});

// Get messages for a specific order
router.get('/order/:orderId', authenticateToken, async (req, res) => {
  try {
    const { orderId } = req.params;

    // Check user is part of the order
    const [orders] = await pool.query(
      'SELECT id FROM orders WHERE id = ? AND (buyer_id = ? OR seller_id = ?)',
      [orderId, req.user.user_id, req.user.user_id]
    );

    if (orders.length === 0) {
      return res.status(403).json({ error: 'Unauthorized to view this chat' });
    }

    // Get messages
    const [messages] = await pool.query(
      `SELECT m.*, u.full_name as sender_name
       FROM chat_messages m
       JOIN users u ON m.sender_id = u.id
       WHERE m.order_id = ?
       ORDER BY m.created_at ASC`,
      [orderId]
    );

    // Mark messages as read
    await pool.query(
      'UPDATE chat_messages SET is_read = TRUE WHERE order_id = ? AND sender_id != ? AND is_read = FALSE',
      [orderId, req.user.user_id]
    );

    res.json({ messages });
  } catch (error) {
    console.error('Get messages error:', error);
    res.status(500).json({ error: 'Failed to get messages' });
  }
});

// Send message
router.post('/order/:orderId', authenticateToken, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { message, message_type = 'text' } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Check user is part of the order
    const [orders] = await pool.query(
      'SELECT buyer_id, seller_id FROM orders WHERE id = ?',
      [orderId]
    );

    if (orders.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orders[0];
    if (order.buyer_id !== req.user.user_id && order.seller_id !== req.user.user_id) {
      return res.status(403).json({ error: 'Unauthorized to send message in this chat' });
    }

    // Insert message
    const [result] = await pool.query(
      `INSERT INTO chat_messages (order_id, sender_id, message, message_type)
       VALUES (?, ?, ?, ?)`,
      [orderId, req.user.user_id, message.trim(), message_type]
    );

    // Notify the other party
    const otherPartyId = req.user.user_id === order.buyer_id ? order.seller_id : order.buyer_id;

    await pool.query(
      `INSERT INTO notifications (user_id, type, title, message, reference_id)
       VALUES (?, 'chat', ?, ?, ?)`,
      [otherPartyId, 'Pesan Baru', message.trim().substring(0, 100), orderId]
    );

    // Get created message
    const [messages] = await pool.query(
      `SELECT m.*, u.full_name as sender_name
       FROM chat_messages m
       JOIN users u ON m.sender_id = u.id
       WHERE m.id = ?`,
      [result.insertId]
    );

    res.status(201).json({ message: messages[0] });
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Mark messages as read
router.post('/order/:orderId/read', authenticateToken, async (req, res) => {
  try {
    await pool.query(
      'UPDATE chat_messages SET is_read = TRUE WHERE order_id = ? AND sender_id != ? AND is_read = FALSE',
      [req.params.orderId, req.user.user_id]
    );

    res.json({ message: 'Messages marked as read' });
  } catch (error) {
    console.error('Mark read error:', error);
    res.status(500).json({ error: 'Failed to mark messages as read' });
  }
});

module.exports = router;