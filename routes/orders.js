const express = require('express');
const QRCode = require('qrcode');
const crypto = require('crypto');
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Helper: generate unique order number
function generateOrderNumber() {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `LAPAK-${timestamp}${random}`;
}

// Helper: generate QR data payload
function generateQRData(order, role) {
  return JSON.stringify({
    type: 'LAPAK_ORDER',
    version: 1,
    order_id: order.id,
    order_number: order.order_number,
    role: role, // 'buyer' | 'seller'
    user_id: role === 'buyer' ? order.buyer_id : order.seller_id,
    timestamp: Date.now()
  });
}

// Helper: check both QR scanned
async function checkAndCompleteOrder(connection, orderId) {
  const [order] = await connection.query(
    'SELECT buyer_scanned_at, seller_scanned_at FROM orders WHERE id = ?',
    [orderId]
  );

  if (order.length > 0 && order[0].buyer_scanned_at && order[0].seller_scanned_at) {
    await connection.query(
      'UPDATE orders SET status = "completed", completed_at = NOW() WHERE id = ?',
      [orderId]
    );
    return true;
  }
  return false;
}

// Create order (buyer)
router.post('/', authenticateToken, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { product_id, quantity = 1, notes } = req.body;

    if (!product_id) {
      return res.status(400).json({ error: 'Product ID is required' });
    }

    if (quantity < 1) {
      return res.status(400).json({ error: 'Quantity must be at least 1' });
    }

    await connection.beginTransaction();

    // Get product with store info
    const [products] = await connection.query(
      `SELECT p.*, s.id as store_id, s.user_id as seller_id, s.name as store_name
       FROM products p
       JOIN stores s ON p.store_id = s.id
       WHERE p.id = ? AND p.is_active = TRUE AND s.is_active = TRUE
       FOR UPDATE`,
      [product_id]
    );

    if (products.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Product not found' });
    }

    const product = products[0];

    // Check stock
    if (product.stock < quantity) {
      await connection.rollback();
      return res.status(400).json({ error: `Insufficient stock. Only ${product.stock} available.` });
    }

    // Prevent buying own product
    if (product.seller_id === req.user.user_id) {
      await connection.rollback();
      return res.status(400).json({ error: 'You cannot buy your own product' });
    }

    // Create order
    const orderNumber = generateOrderNumber();
    const totalPrice = product.price * quantity;

    const [orderResult] = await connection.query(
      `INSERT INTO orders (order_number, buyer_id, seller_id, store_id, product_id, quantity, unit_price, total_price, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [orderNumber, req.user.user_id, product.seller_id, product.store_id, product_id,
       quantity, product.price, totalPrice, notes || null]
    );

    const orderId = orderResult.insertId;

    // Decrement stock
    await connection.query(
      'UPDATE products SET stock = stock - ? WHERE id = ?',
      [quantity, product_id]
    );

    // Generate QR codes for both buyer and seller
    const order = {
      id: orderId,
      order_number: orderNumber,
      buyer_id: req.user.user_id,
      seller_id: product.seller_id
    };

    const buyerQRData = generateQRData(order, 'buyer');
    const sellerQRData = generateQRData(order, 'seller');

    const buyerQRCode = await QRCode.toDataURL(buyerQRData);
    const sellerQRCode = await QRCode.toDataURL(sellerQRData);

    // Store QR codes
    await connection.query(
      'UPDATE orders SET buyer_qr_code = ?, seller_qr_code = ? WHERE id = ?',
      [buyerQRCode, sellerQRCode, orderId]
    );

    // Insert QR records
    await connection.query(
      'INSERT INTO qr_codes (order_id, user_id, qr_data, qr_type) VALUES (?, ?, ?, ?), (?, ?, ?, ?)',
      [orderId, req.user.user_id, buyerQRData, 'buyer',
       orderId, product.seller_id, sellerQRData, 'seller']
    );

    await connection.commit();

    res.status(201).json({
      message: 'Order created successfully. Please scan the QR code to complete the deal.',
      order_id: orderId,
      order_number: orderNumber,
      total_price: totalPrice,
      buyer_qr_code: buyerQRCode,
      seller_qr_code: sellerQRCode
    });
  } catch (error) {
    await connection.rollback();
    console.error('Create order error:', error);
    res.status(500).json({ error: 'Failed to create order' });
  } finally {
    connection.release();
  }
});

// Get orders (buyer: own purchases, seller: own sales)
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { role = 'all', status, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let whereClause = '';
    const params = [];

    if (role === 'buyer') {
      whereClause = 'WHERE o.buyer_id = ?';
      params.push(req.user.user_id);
    } else if (role === 'seller') {
      whereClause = 'WHERE o.seller_id = ?';
      params.push(req.user.user_id);
    } else {
      whereClause = 'WHERE (o.buyer_id = ? OR o.seller_id = ?)';
      params.push(req.user.user_id, req.user.user_id);
    }

    if (status) {
      whereClause += ' AND o.status = ?';
      params.push(status);
    }

    const [orders] = await pool.query(
      `SELECT o.*, 
       p.name as product_name, p.price as product_price,
       p.condition_type,
       (SELECT image_url FROM product_images WHERE product_id = p.id AND is_primary = TRUE LIMIT 1) as product_image,
       s.name as store_name, s.phone_number as store_phone,
       buyer.full_name as buyer_name, buyer.phone_number as buyer_phone,
       seller.full_name as seller_name, seller.phone_number as seller_phone
       FROM orders o
       JOIN products p ON o.product_id = p.id
       JOIN stores s ON o.store_id = s.id
       JOIN users buyer ON o.buyer_id = buyer.id
       JOIN users seller ON o.seller_id = seller.id
       ${whereClause}
       ORDER BY o.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), parseInt(offset)]
    );

    const [total] = await pool.query(
      `SELECT COUNT(*) as count FROM orders o ${whereClause}`,
      params
    );

    res.json({
      orders,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: total[0].count,
        pages: Math.ceil(total[0].count / limit)
      }
    });
  } catch (error) {
    console.error('Get orders error:', error);
    res.status(500).json({ error: 'Failed to get orders' });
  }
});

// Get order by ID
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const [orders] = await pool.query(
      `SELECT o.*, 
       p.name as product_name, p.description as product_description,
       p.condition_type,
       (SELECT image_url FROM product_images WHERE product_id = p.id AND is_primary = TRUE LIMIT 1) as product_image,
       s.name as store_name, s.phone_number as store_phone, s.address as store_address,
       buyer.full_name as buyer_name, buyer.phone_number as buyer_phone, buyer.email as buyer_email,
       seller.full_name as seller_name, seller.phone_number as seller_phone, seller.email as seller_email
       FROM orders o
       JOIN products p ON o.product_id = p.id
       JOIN stores s ON o.store_id = s.id
       JOIN users buyer ON o.buyer_id = buyer.id
       JOIN users seller ON o.seller_id = seller.id
       WHERE o.id = ?`,
      [req.params.id]
    );

    if (orders.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orders[0];

    // Check authorization
    if (order.buyer_id !== req.user.user_id && order.seller_id !== req.user.user_id) {
      return res.status(403).json({ error: 'Unauthorized to view this order' });
    }

    // Determine which QR to show based on role
    let myQRCode = null;
    let counterQRCode = null;
    let myScanned = false;
    let counterScanned = false;

    if (req.user.user_id === order.buyer_id) {
      myQRCode = order.buyer_qr_code;
      counterQRCode = order.seller_qr_code;
      myScanned = !!order.buyer_scanned_at;
      counterScanned = !!order.seller_scanned_at;
    } else {
      myQRCode = order.seller_qr_code;
      counterQRCode = order.buyer_qr_code;
      myScanned = !!order.seller_scanned_at;
      counterScanned = !!order.buyer_scanned_at;
    }

    res.json({
      order: {
        ...order,
        my_qr_code: myQRCode,
        my_scanned: myScanned,
        counter_scanned: counterScanned
      }
    });
  } catch (error) {
    console.error('Get order error:', error);
    res.status(500).json({ error: 'Failed to get order' });
  }
});

// Update order status
router.patch('/:id/status', authenticateToken, async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ['pending', 'confirmed', 'completed', 'cancelled'];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const [orders] = await pool.query(
      'SELECT * FROM orders WHERE id = ?',
      [req.params.id]
    );

    if (orders.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orders[0];

    // Only seller can confirm, either can cancel, admin flow for complete
    if (status === 'confirmed' && order.seller_id !== req.user.user_id) {
      return res.status(403).json({ error: 'Only the seller can confirm orders' });
    }

    if (status === 'cancelled' && order.buyer_id !== req.user.user_id && order.seller_id !== req.user.user_id) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // Cancellation rules
    if (status === 'cancelled' && order.status === 'completed') {
      return res.status(400).json({ error: 'Cannot cancel a completed order' });
    }

    await pool.query(
      'UPDATE orders SET status = ? WHERE id = ?',
      [status, req.params.id]
    );

    // If cancelled, restore stock
    if (status === 'cancelled' && order.status !== 'cancelled') {
      await pool.query(
        'UPDATE products SET stock = stock + ? WHERE id = ?',
        [order.quantity, order.product_id]
      );
    }

    res.json({ message: 'Order status updated', status });
  } catch (error) {
    console.error('Update order status error:', error);
    res.status(500).json({ error: 'Failed to update order status' });
  }
});

// Scan QR to confirm deal
router.post('/scan', authenticateToken, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { qr_data } = req.body;

    if (!qr_data) {
      return res.status(400).json({ error: 'QR data is required' });
    }

    // Parse QR data
    let qrPayload;
    try {
      qrPayload = JSON.parse(qr_data);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid QR code format' });
    }

    if (qrPayload.type !== 'LAPAK_ORDER' || !qrPayload.order_id) {
      return res.status(400).json({ error: 'Invalid QR code type' });
    }

    await connection.beginTransaction();

    // Get order
    const [orders] = await connection.query(
      'SELECT * FROM orders WHERE id = ?',
      [qrPayload.order_id]
    );

    if (orders.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orders[0];

    // Check order status
    if (order.status === 'completed') {
      await connection.rollback();
      return res.status(400).json({ error: 'This order is already completed' });
    }

    if (order.status === 'cancelled') {
      await connection.rollback();
      return res.status(400).json({ error: 'This order has been cancelled' });
    }

    // Check authorization: only buyer or seller of this order can scan
    if (req.user.user_id !== order.buyer_id && req.user.user_id !== order.seller_id) {
      await connection.rollback();
      return res.status(403).json({ error: 'You are not part of this order' });
    }

    // Determine which role is scanning
    const isBuyer = req.user.user_id === order.buyer_id;
    const isSeller = req.user.user_id === order.seller_id;

    // The QR being scanned must match the scanning user's role
    // i.e., buyer scans the SELLER's QR (or their own), logic:
    // The user scans a QR; the QR payload has a role field
    const scannedRole = qrPayload.role; // 'buyer' or 'seller'

    // Validation: seller scans the buyer's QR, buyer scans the seller's QR
    if (isSeller && scannedRole !== 'buyer') {
      await connection.rollback();
      return res.status(400).json({ error: 'Seller must scan the buyers QR code' });
    }

    if (isBuyer && scannedRole !== 'seller') {
      await connection.rollback();
      return res.status(400).json({ error: 'Buyer must scan the sellers QR code' });
    }

    // Prevent double scanning
    if (isBuyer && order.buyer_scanned_at) {
      await connection.rollback();
      return res.status(400).json({ error: 'Buyer already scanned. Awaiting seller scan.' });
    }

    if (isSeller && order.seller_scanned_at) {
      await connection.rollback();
      return res.status(400).json({ error: 'Seller already scanned. Awaiting buyer scan.' });
    }

    // Record scan
    if (isBuyer) {
      await connection.query(
        'UPDATE orders SET buyer_scanned_at = NOW() WHERE id = ?',
        [order.id]
      );
      await connection.query(
        'UPDATE qr_codes SET is_scanned = TRUE, scanned_at = NOW() WHERE order_id = ? AND user_id = ? AND qr_type = ?',
        [order.id, req.user.user_id, 'buyer']
      );
    } else {
      await connection.query(
        'UPDATE orders SET seller_scanned_at = NOW() WHERE id = ?',
        [order.id]
      );
      await connection.query(
        'UPDATE qr_codes SET is_scanned = TRUE, scanned_at = NOW() WHERE order_id = ? AND user_id = ? AND qr_type = ?',
        [order.id, req.user.user_id, 'seller']
      );
    }

    // Check if both scanned → complete order
    const completed = await checkAndCompleteOrder(connection, order.id);

    // Notify counter party
    const notifyUserId = isBuyer ? order.seller_id : order.buyer_id;
    const notifierName = isBuyer ? 'Buyer' : 'Seller';
    
    if (completed) {
      await connection.query(
        `INSERT INTO notifications (user_id, type, title, message, reference_id)
         VALUES (?, 'order', ?, ?, ?)`,
        [notifyUserId, 'Deal Selesai!', `Pesanan ${order.order_number} telah selesai. Kedua pihak telah scan QR.`, order.id]
      );
      
      // Also notify the scanner
      await connection.query(
        `INSERT INTO notifications (user_id, type, title, message, reference_id)
         VALUES (?, 'order', ?, ?, ?)`,
        [req.user.user_id, 'Deal Selesai!', `Pesanan ${order.order_number} telah selesai.`, order.id]
      );
    } else {
      await connection.query(
        `INSERT INTO notifications (user_id, type, title, message, reference_id)
         VALUES (?, 'order', ?, ?, ?)`,
        [notifyUserId, 'QR Scanned', `${notifierName} telah scan QR untuk pesanan ${order.order_number}. Kedua pihak harus scan QR untuk menyelesaikan deal.`, order.id]
      );
    }

    await connection.commit();

    res.json({
      message: completed 
        ? 'Deal completed! Both parties have scanned the QR codes.'
        : 'QR scanned successfully. Waiting for the other party to scan.',
      completed,
      order_status: completed ? 'completed' : order.status
    });
  } catch (error) {
    await connection.rollback();
    console.error('Scan QR error:', error);
    res.status(500).json({ error: 'Failed to process QR scan' });
  } finally {
    connection.release();
  }
});

// Regenerate QR codes
router.post('/:id/regenerate-qr', authenticateToken, async (req, res) => {
  try {
    const [orders] = await pool.query(
      'SELECT * FROM orders WHERE id = ?',
      [req.params.id]
    );

    if (orders.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orders[0];

    // Only buyer or seller can regenerate
    if (order.buyer_id !== req.user.user_id && order.seller_id !== req.user.user_id) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // Don't regenerate completed orders
    if (order.status === 'completed') {
      return res.status(400).json({ error: 'Cannot regenerate QR for completed order' });
    }

    const buyerQRData = generateQRData(order, 'buyer');
    const sellerQRData = generateQRData(order, 'seller');

    const buyerQRCode = await QRCode.toDataURL(buyerQRData);
    const sellerQRCode = await QRCode.toDataURL(sellerQRData);

    await pool.query(
      'UPDATE orders SET buyer_qr_code = ?, seller_qr_code = ? WHERE id = ?',
      [buyerQRCode, sellerQRCode, order.id]
    );

    // Update QR records
    await pool.query(
      'UPDATE qr_codes SET qr_data = ? WHERE order_id = ? AND qr_type = ?',
      [buyerQRData, order.id, 'buyer']
    );
    await pool.query(
      'UPDATE qr_codes SET qr_data = ? WHERE order_id = ? AND qr_type = ?',
      [sellerQRData, order.id, 'seller']
    );

    res.json({
      message: 'QR codes regenerated',
      buyer_qr_code: buyerQRCode,
      seller_qr_code: sellerQRCode
    });
  } catch (error) {
    console.error('Regenerate QR error:', error);
    res.status(500).json({ error: 'Failed to regenerate QR codes' });
  }
});

module.exports = router;