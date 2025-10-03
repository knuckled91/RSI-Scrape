import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');

// ---- tiny helpers
const log = (...a) => console.log(new Date().toISOString(), '-', ...a);
const env = (k, def=null) => process.env[k] ?? def;
const toYMD = (d) => d.toISOString().slice(0,10); // YYYY-MM-DD

function getTenantIds(cliTenant) {
  if (cliTenant) return [cliTenant];
  const raw = env('TENANTS', '');
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function getCredsForTenant(id) {
  const user = env(`RSI_USER_${id}`);
  const pass = env(`RSI_PASS_${id}`);
  if (!user || !pass) throw new Error(`Missing creds for tenant ${id}. Add RSI_USER_${id}/RSI_PASS_${id} to .env`);
  return { user, pass };
}

function loadTenants() {
  const tenants = JSON.parse(fs.readFileSync(path.join(ROOT, 'tenants.json'), 'utf8'));
  return tenants;
}

async function ensureDir(p) {
  await fs.promises.mkdir(p, { recursive: true });
}

async function setLast12Months(page, cfg) {
  // Option A: click a preset if it exists
  if (cfg.presetLast12Selector) {
    const hasPreset = await page.$(cfg.presetLast12Selector);
    if (hasPreset) {
      await page.click(cfg.presetLast12Selector);
      return;
    }
  }
  // Option B: manually set date inputs
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 364);

  if (cfg.startInput) {
    await page.fill(cfg.startInput, toYMD(start));
  }
  if (cfg.endInput) {
    await page.fill(cfg.endInput, toYMD(end));
  }
  // If there is an "Apply" button, click it (best-effort)
  const applyBtn = await page.$('text=Apply');
  if (applyBtn) await applyBtn.click();
}

async function exportCsv(page, cfg, savePathBase) {
  // Primary: wait for real download after clicking export
  let download;
  try {
    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 12000 }),
      page.click(cfg.exportButton || 'text=Export')
    ]);
    download = dl;
  } catch (e) {
    // Fallbacks
    log('Download event not captured, trying href fallback...');
    // Try to find a direct csv link on the page
    const link = await page.$('a[href$=".csv"]');
    if (link) {
      const href = await link.getAttribute('href');
      const csv = await page.evaluate(async (u) => {
        const res = await fetch(u);
        return await res.text();
      }, href);
      const fp = `${savePathBase}.csv`;
      fs.writeFileSync(fp, csv, 'utf8');
      return fp;
    }
    throw new Error('Could not capture CSV download (neither event nor link). Update selectors for this report.');
  }

  // Save the official download
  const suggested = download.suggestedFilename();
  const fp = `${savePathBase}__${suggested.endsWith('.csv') ? suggested : suggested + '.csv'}`;
  await download.saveAs(fp);
  return fp;
}

async function login(page, baseUrl, user, pass) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  // Adjust selectors if RSI’s login form differs
  await page.fill('#username, input[name="username"], input[type="email"]', user);
  await page.fill('#password, input[name="password"], input[type="password"]', pass);
  await Promise.any([
    page.click('button[type="submit"]'),
    page.click('text=Sign In'),
    page.click('text=Log In')
  ]).catch(()=>{});
  // Wait for a post-login signal (nav bar, user avatar, or redirect)
  await page.waitForLoadState('networkidle', { timeout: 20000 });
}

async function runTenant(browser, tenantCfg, creds) {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  const baseUrl = env(tenantCfg.baseUrlEnv);
  if (!baseUrl) throw new Error(`Base URL env ${tenantCfg.baseUrlEnv} not set`);

  const tDir = path.join(DATA_DIR, tenantCfg.id);
  await ensureDir(tDir);

  log(`[${tenantCfg.id}] Logging in...`);
  await login(page, baseUrl, creds.user, creds.pass);
  log(`[${tenantCfg.id}] Logged in.`);

  // Date stamps for filenames
  const runStamp = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);

  for (const r of tenantCfg.reports) {
    log(`[${tenantCfg.id}] Report: ${r.name}`);
    const url = r.path.startsWith('http') ? r.path : baseUrl.replace(/\/$/,'') + r.path;
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // Set last 12 months (best effort)
    await setLast12Months(page, r);

    // Try export
    const baseName = `${tenantCfg.id}__${r.name}__${runStamp}`;
    const savePathBase = path.join(tDir, baseName);
    const saved = await exportCsv(page, r, savePathBase);
    log(`[${tenantCfg.id}] Saved -> ${saved}`);
  }

  await context.close();
}

async function main() {
  const args = process.argv.slice(2);
  const tIdx = args.indexOf('--tenant');
  const singleTenant = tIdx !== -1 ? args[tIdx + 1] : null;

  const tenantIds = getTenantIds(singleTenant);
  if (!tenantIds.length) throw new Error('No tenants specified. Set TENANTS in .env or use --tenant <id>.');

  // Load configs and filter to what we’re running
  const allTenantsCfg = loadTenants();
  const runCfgs = tenantIds.map(id => {
    const cfg = allTenantsCfg.find(t => t.id === id);
    if (!cfg) throw new Error(`Tenant ${id} missing in tenants.json`);
    return cfg;
  });

  await ensureDir(DATA_DIR);

  const browser = await chromium.launch({ headless: true });

  for (const cfg of runCfgs) {
    try {
      const creds = getCredsForTenant(cfg.id);
      await runTenant(browser, cfg, creds);
    } catch (e) {
      log(`[${cfg.id}] ERROR:`, e.message);
    }
  }
  await browser.close();
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
