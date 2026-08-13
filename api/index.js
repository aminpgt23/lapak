// Vercel Serverless entry — export Express app sebagai handler
// Vercel memanggil handler ini per-request, bukan server.listen()
const { app } = require('../server');

module.exports = app;
