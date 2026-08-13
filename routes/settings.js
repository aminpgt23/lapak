const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// Pengaturan publik (slogan, no WA admin) — tanpa auth
router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT setting_key, setting_value FROM app_settings');
    const settings = {};
    for (const row of rows) {
      settings[row.setting_key] = row.setting_value;
    }
    res.json({ settings });
  } catch (error) {
    console.error('Get public settings error:', error);
    res.status(500).json({ error: 'Failed to get settings' });
  }
});

module.exports = router;
