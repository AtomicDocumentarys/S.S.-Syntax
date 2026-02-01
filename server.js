// Ultra simple server - NO dependencies needed!
const http = require('http');

const server = http.createServer((req, res) => {
  // Always return 200 OK for health checks
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
  
  console.log(`${new Date().toISOString()} - Request to: ${req.url}`);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🕐 Started at: ${new Date().toISOString()}`);
});
