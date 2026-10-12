// Shared browser configuration for local machines and managed cloud workspaces.
const fs = require('node:fs');

function loadPlaywright() {
  if (process.env.PLAYWRIGHT_MODULE) return require(process.env.PLAYWRIGHT_MODULE);
  let modulePath;
  try {
    modulePath = require.resolve('playwright');
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    const managedPath = '/opt/codex/cua_node/lib/node_modules/playwright';
    if (!fs.existsSync(managedPath)) {
      throw new Error('Playwright is required: install playwright locally or set PLAYWRIGHT_MODULE to its module path.');
    }
    modulePath = managedPath;
  }
  return require(modulePath);
}

const {chromium} = loadPlaywright();
const executablePath = process.env.CHROMIUM_PATH || ['/usr/bin/chromium', '/usr/bin/chromium-browser'].find(file => fs.existsSync(file));
const launchOptions = {
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  ...(executablePath ? {executablePath} : {}),
};
const appURL = process.env.APP_URL || process.env.QA_URL || process.env.DECISION_LAB_URL || 'http://127.0.0.1:8080/';

module.exports = {chromium, launchOptions, appURL};
