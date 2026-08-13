const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: {
    require: process.env.DB_SSL === 'true',
    rejectUnauthorized: false
  },
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Initialize database schema
async function initializeDatabase() {
  const connection = await pool.getConnection();
  try {
    // Users table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        full_name VARCHAR(255),
        phone_number VARCHAR(20),
        role ENUM('buyer', 'seller', 'both', 'admin') DEFAULT 'buyer',
        email_verified BOOLEAN DEFAULT FALSE,
        wa_verified BOOLEAN DEFAULT FALSE,
        is_active BOOLEAN DEFAULT TRUE,
        verification_token VARCHAR(255),
        verification_expires DATETIME,
        avatar_url VARCHAR(500),
        seller_status ENUM('none', 'pending', 'approved', 'rejected') DEFAULT 'none',
        agreed_terms_at DATETIME NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Migrasi tabel yang sudah ada (CREATE IF NOT EXISTS tidak mengubah struktur lama)
    try {
      await connection.query(
        `ALTER TABLE users MODIFY role ENUM('buyer', 'seller', 'both', 'admin') DEFAULT 'buyer'`
      );
    } catch (_) {}

    try {
      await connection.query(
        `ALTER TABLE users ADD COLUMN seller_status ENUM('none', 'pending', 'approved', 'rejected') DEFAULT 'none'`
      );
    } catch (_) {}

    try {
      await connection.query(`ALTER TABLE users ADD COLUMN wa_verified BOOLEAN DEFAULT FALSE`);
    } catch (_) {}

    try {
      await connection.query(`ALTER TABLE users ADD COLUMN is_active BOOLEAN DEFAULT TRUE`);
    } catch (_) {}

    try {
      await connection.query(`ALTER TABLE users ADD COLUMN agreed_terms_at DATETIME NULL`);
    } catch (_) {}

    // Seed akun admin (kredensial bisa diubah via env)
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@lapak.id';
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
    const [adminRows] = await connection.query(
      'SELECT id FROM users WHERE email = ?',
      [adminEmail]
    );
    if (adminRows.length === 0) {
      const bcrypt = require('bcryptjs');
      const adminHash = await bcrypt.hash(adminPassword, 10);
      await connection.query(
        `INSERT INTO users (email, password_hash, full_name, role, email_verified, wa_verified, seller_status, agreed_terms_at)
         VALUES (?, ?, 'Admin Lapak', 'admin', TRUE, TRUE, 'approved', NOW())`,
        [adminEmail, adminHash]
      );
      console.log(`Admin account seeded: ${adminEmail}`);
    }

    // Stores table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS stores (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        phone_number VARCHAR(20) NOT NULL,
        address TEXT,
        latitude DECIMAL(10, 8),
        longitude DECIMAL(11, 8),
        avatar_url VARCHAR(500),
        is_active BOOLEAN DEFAULT TRUE,
        is_open BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        INDEX idx_user_id (user_id),
        INDEX idx_active (is_active)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    try {
      await connection.query(`ALTER TABLE stores ADD COLUMN is_open BOOLEAN DEFAULT TRUE`);
    } catch (_) {}

    // Products table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS products (
        id INT AUTO_INCREMENT PRIMARY KEY,
        store_id INT NOT NULL,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        price DECIMAL(12, 2) NOT NULL,
        stock INT DEFAULT 0,
        category VARCHAR(100),
        condition_type ENUM('new', 'used') DEFAULT 'new',
        delivery_type ENUM('pickup', 'delivery', 'both') DEFAULT 'pickup',
        delivery_fee DECIMAL(12, 2) DEFAULT 0,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE,
        INDEX idx_store_id (store_id),
        INDEX idx_active (is_active),
        INDEX idx_category (category)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    try {
      await connection.query(
        `ALTER TABLE products ADD COLUMN delivery_type ENUM('pickup', 'delivery', 'both') DEFAULT 'pickup'`
      );
    } catch (_) {}

    try {
      await connection.query(`ALTER TABLE products ADD COLUMN delivery_fee DECIMAL(12, 2) DEFAULT 0`);
    } catch (_) {}

    // Product images table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS product_images (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_id INT NOT NULL,
        image_url VARCHAR(500) NOT NULL,
        is_primary BOOLEAN DEFAULT FALSE,
        sort_order INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
        INDEX idx_product_id (product_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Orders table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_number VARCHAR(50) UNIQUE NOT NULL,
        buyer_id INT NOT NULL,
        seller_id INT NOT NULL,
        store_id INT NOT NULL,
        product_id INT NOT NULL,
        quantity INT DEFAULT 1,
        unit_price DECIMAL(12, 2) NOT NULL,
        delivery_type ENUM('pickup', 'delivery') DEFAULT 'pickup',
        delivery_fee DECIMAL(12, 2) DEFAULT 0,
        total_price DECIMAL(12, 2) NOT NULL,
        status ENUM('pending', 'confirmed', 'completed', 'cancelled') DEFAULT 'pending',
        buyer_qr_code VARCHAR(500),
        seller_qr_code VARCHAR(500),
        buyer_scanned_at DATETIME NULL,
        seller_scanned_at DATETIME NULL,
        completed_at DATETIME NULL,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (buyer_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
        INDEX idx_buyer_id (buyer_id),
        INDEX idx_seller_id (seller_id),
        INDEX idx_status (status),
        INDEX idx_order_number (order_number)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Favorites table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS favorites (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        store_id INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE,
        UNIQUE KEY unique_user_store (user_id, store_id),
        INDEX idx_user_id (user_id),
        INDEX idx_store_id (store_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Chat messages table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_id INT NOT NULL,
        sender_id INT NOT NULL,
        message TEXT NOT NULL,
        message_type ENUM('text', 'image', 'system') DEFAULT 'text',
        is_read BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
        FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
        INDEX idx_order_id (order_id),
        INDEX idx_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Notifications table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        type ENUM('order', 'chat', 'favorite', 'system') NOT NULL,
        title VARCHAR(255) NOT NULL,
        message TEXT,
        reference_id INT,
        is_read BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        INDEX idx_user_id (user_id),
        INDEX idx_is_read (is_read)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    try {
      await connection.query(`ALTER TABLE orders ADD COLUMN delivery_type ENUM('pickup', 'delivery') DEFAULT 'pickup'`);
    } catch (_) {}

    try {
      await connection.query(`ALTER TABLE orders ADD COLUMN delivery_fee DECIMAL(12, 2) DEFAULT 0`);
    } catch (_) {}

    // App settings table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        setting_key VARCHAR(100) PRIMARY KEY,
        setting_value TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Seed pengaturan default
    const defaultSettings = {
      admin_wa_number: '085943576826',
      slogan: 'Anda lapar saat kerja? Cari disini.. belanja & tetap mematuhi aturan toko dan perusahaan anda',
      delivery_fee_max: '10000'
    };
    for (const [key, value] of Object.entries(defaultSettings)) {
      await connection.query(
        'INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES (?, ?)',
        [key, value]
      );
    }

    // QR codes table (for generating unique QR codes)
    await connection.query(`
      CREATE TABLE IF NOT EXISTS qr_codes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_id INT NOT NULL,
        user_id INT NOT NULL,
        qr_data TEXT NOT NULL,
        qr_type ENUM('buyer', 'seller') NOT NULL,
        is_scanned BOOLEAN DEFAULT FALSE,
        scanned_at DATETIME NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        INDEX idx_order_id (order_id),
        INDEX idx_user_id (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    console.log('Database schema initialized successfully');
  } catch (error) {
    console.error('Database initialization error:', error);
    throw error;
  } finally {
    connection.release();
  }
}

module.exports = { pool, initializeDatabase };