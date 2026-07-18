/**
 * Configuration loader for zylos-rounds
 *
 * Loads config from ~/zylos/components/rounds/config.json
 * with hot-reload support via file watcher.
 */

import fs from 'fs';
import path from 'path';

const HOME = process.env.HOME;
export const DATA_DIR = path.join(HOME, 'zylos/components/rounds');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

// Default configuration
export const DEFAULT_CONFIG = {
  enabled: true,
  port: 3478,
  publicOrigin: '', // e.g. https://host/standup — overrides X-Forwarded-* for member links
  model: 'gpt-realtime-2.1',
  voice: 'marin',
  transcriptionModel: 'gpt-realtime-whisper',
  maxConcurrent: 4,
  maxSessionMs: 10 * 60 * 1000,
  timeZone: 'Asia/Shanghai',
  auth: {
    enabled: true,
    password: '', // scrypt hash; plaintext is auto-migrated to a hash on first start
  },
};

/**
 * Read OPENAI_API_KEY and proxy settings from ~/zylos/.env (shared workspace
 * secrets — never duplicated into config.json) with process.env taking precedence.
 */
export function loadEnvSecrets() {
  const out = {};
  try {
    const file = path.join(HOME, 'zylos/.env');
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env — rely on process.env */ }
  const env = { ...out, ...process.env };
  return {
    openaiApiKey: env.OPENAI_API_KEY || '',
    proxy: env.HTTPS_PROXY || env.HTTP_PROXY || null,
  };
}

let config = null;
let configWatcher = null;

/**
 * Load configuration from file
 * @returns {Object} Configuration object
 */
export function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const content = fs.readFileSync(CONFIG_PATH, 'utf8');
      const parsed = JSON.parse(content);
      config = {
        ...DEFAULT_CONFIG,
        ...parsed,
        auth: { ...DEFAULT_CONFIG.auth, ...(parsed.auth || {}) },
      };
    } else {
      console.warn(`[rounds] Config file not found: ${CONFIG_PATH}`);
      config = { ...DEFAULT_CONFIG };
    }
  } catch (err) {
    console.error(`[rounds] Failed to load config: ${err.message}`);
    config = { ...DEFAULT_CONFIG };
  }
  return config;
}

/**
 * Get current configuration
 * @returns {Object} Configuration object
 */
export function getConfig() {
  if (!config) {
    loadConfig();
  }
  return config;
}

/**
 * Save configuration to file
 * @param {Object} newConfig - Configuration to save
 */
export function saveConfig(newConfig) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2));
    config = newConfig;
  } catch (err) {
    console.error(`[rounds] Failed to save config: ${err.message}`);
    throw err;
  }
}

/**
 * Start watching config file for changes
 * @param {Function} onChange - Callback when config changes
 */
export function watchConfig(onChange) {
  if (configWatcher) {
    configWatcher.close();
  }

  if (fs.existsSync(CONFIG_PATH)) {
    configWatcher = fs.watch(CONFIG_PATH, (eventType) => {
      if (eventType === 'change') {
        console.log('[rounds] Config file changed, reloading...');
        loadConfig();
        if (onChange) {
          onChange(config);
        }
      }
    });
  }
}

/**
 * Stop watching config file
 */
export function stopWatching() {
  if (configWatcher) {
    configWatcher.close();
    configWatcher = null;
  }
}
