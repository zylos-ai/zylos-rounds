#!/usr/bin/env node
/**
 * zylos-standup
 *
 * AI-assisted async daily standup tool
 */

import { getConfig, watchConfig, DATA_DIR } from './lib/config.js';

// Initialize
console.log(`[standup] Starting...`);
console.log(`[standup] Data directory: ${DATA_DIR}`);

// Load configuration
let config = getConfig();
console.log(`[standup] Config loaded, enabled: ${config.enabled}`);

if (!config.enabled) {
  console.log(`[standup] Component disabled in config, exiting.`);
  process.exit(0);
}

// Watch for config changes
watchConfig((newConfig) => {
  console.log(`[standup] Config reloaded`);
  config = newConfig;
  if (!newConfig.enabled) {
    console.log(`[standup] Component disabled, stopping...`);
    shutdown();
  }
});

// Main component logic
async function main() {
  // TODO: Implement your component logic here
  //
  // Communication components: set up platform SDK, listen for events, forward to C4
  // Capability components: start HTTP server or other service interface
  // Utility components: run task and exit (remove the keepalive below)

  console.log(`[standup] Running`);
}

// Graceful shutdown
function shutdown() {
  console.log(`[standup] Shutting down...`);
  // TODO: Close connections, stop listeners, cleanup
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Run
main().catch(err => {
  console.error(`[standup] Fatal error:`, err);
  process.exit(1);
});
