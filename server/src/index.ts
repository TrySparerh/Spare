// Spare API — Robinhood Chain (4663)
import http from 'http';
import { allowedOrigins, createApp } from './app.js';
import { env } from './env.js';
import { SPARE_MCP_SERVER, toolList } from './mcp/server.js';

const PORT = env.PORT;
const server = http.createServer(createApp());

server.listen(PORT, () => {
  console.log(`Spare API listening on port ${PORT}`);
  console.log(`  environment: ${env.NODE_ENV}`);
  console.log(`  CORS origins: ${allowedOrigins().length}`);
  console.log(`  ${SPARE_MCP_SERVER.title} v${SPARE_MCP_SERVER.version}: POST /mcp (${toolList('spare').length} engine tools)`);
  if (env.TEST_MODE) console.log('  TEST_MODE ACTIVE: local dev origins allowed for CORS');
});
