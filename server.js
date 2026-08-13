const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
require('dotenv').config();
const { initializeDatabase, pool } = require('./db');

const app = express();
const server = http.createServer(app);

// Socket.IO for real-time features
const { Server } = require('socket.io');
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Cold start serverless (Vercel) tidak memanggil startServer(), jadi pastikan schema ada di request pertama
let dbInitPromise = null;
function ensureDatabase() {
  if (!dbInitPromise) {
    dbInitPromise = initializeDatabase().catch((error) => {
      console.error('Database init failed (will retry on next request):', error.message);
      dbInitPromise = null;
      throw error;
    });
  }
  return dbInitPromise;
}

app.use(async (req, res, next) => {
  if (process.env.VERCEL) {
    try {
      await ensureDatabase();
    } catch (error) {
      return res.status(503).json({ error: 'Database not ready: ' + error.message });
    }
  }
  next();
});

// Import routes
const authRoutes = require('./routes/auth');
const storeRoutes = require('./routes/stores');
const productRoutes = require('./routes/products');
const orderRoutes = require('./routes/orders');
const favoriteRoutes = require('./routes/favorites');
const chatRoutes = require('./routes/chat');
const notificationRoutes = require('./routes/notifications');
const adminRoutes = require('./routes/admin');
const settingsRoutes = require('./routes/settings');

// Mount routes
app.use('/api/auth', authRoutes);
app.use('/api/stores', storeRoutes);
app.use('/api/products', productRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/favorites', favoriteRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/settings', settingsRoutes);

// Health check
app.get('/health', async (req, res) => {
  try {
    const [result] = await pool.query('SELECT 1 as ok');
    res.json({ 
      status: 'ok', 
      database: result[0].ok === 1 ? 'connected' : 'error',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ status: 'error', database: 'disconnected', error: error.message });
  }
});

// API Info
app.get('/', (req, res) => {
  res.json({
    name: 'Lapak Marketplace API',
    version: '1.0.0',
    endpoints: {
      auth: '/api/auth',
      stores: '/api/stores',
      products: '/api/products',
      orders: '/api/orders',
      favorites: '/api/favorites',
      chat: '/api/chat',
      notifications: '/api/notifications'
    }
  });
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Authenticate socket connection
  socket.on('authenticate', (data) => {
    try {
      const jwt = require('jsonwebtoken');
      const token = data.token;
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = decoded.user_id;
      socket.join(`user_${decoded.user_id}`);
      console.log(`User ${decoded.user_id} authenticated on socket ${socket.id}`);
      socket.emit('authenticated', { user_id: decoded.user_id });
    } catch (error) {
      socket.emit('auth_error', { error: 'Invalid token' });
    }
  });

  // Join order chat room
  socket.on('join_order_room', (data) => {
    socket.join(`order_${data.order_id}`);
    console.log(`Socket ${socket.id} joined order room ${data.order_id}`);
  });

  // Send chat message via socket
  socket.on('send_message', async (data) => {
    try {
      const { order_id, message } = data;
      const senderId = socket.userId;

      if (!senderId) {
        socket.emit('error', { error: 'Not authenticated' });
        return;
      }

      // Insert message into DB
      const [result] = await pool.query(
        'INSERT INTO chat_messages (order_id, sender_id, message) VALUES (?, ?, ?)',
        [order_id, senderId, message]
      );

      const [messages] = await pool.query(
        `SELECT m.*, u.full_name as sender_name
         FROM chat_messages m
         JOIN users u ON m.sender_id = u.id
         WHERE m.id = ?`,
        [result.insertId]
      );

      // Get order to find other party
      const [orders] = await pool.query(
        'SELECT buyer_id, seller_id FROM orders WHERE id = ?',
        [order_id]
      );

      if (orders.length > 0) {
        const order = orders[0];
        const otherPartyId = senderId === order.buyer_id ? order.seller_id : order.buyer_id;

        // Emit to room
        io.to(`order_${order_id}`).emit('new_message', messages[0]);

        // Notify other party
        io.to(`user_${otherPartyId}`).emit('notification', {
          type: 'chat',
          title: 'Pesan Baru',
          message: message.substring(0, 100),
          order_id
        });

        // Save notification to DB
        await pool.query(
          `INSERT INTO notifications (user_id, type, title, message, reference_id)
           VALUES (?, 'chat', ?, ?, ?)`,
          [otherPartyId, 'Pesan Baru', message.substring(0, 100), order_id]
        );
      }
    } catch (error) {
      console.error('Socket message error:', error);
      socket.emit('error', { error: 'Failed to send message' });
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: `Upload gagal: ${err.message}` });
  }
  console.error('Error:', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// Initialize database then start server
const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    await initializeDatabase();
    console.log('Database initialized successfully');
    
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`Lapak API server running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Only start if run directly
if (require.main === module) {
  startServer();
}

module.exports = { app, server, io };