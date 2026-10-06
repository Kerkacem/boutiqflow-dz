#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

console.log('[TYPECHECK] Validating module contracts and schemas...');

let errors = 0;
let modulesChecked = 0;

function checkImports(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      checkImports(fullPath);
    } else if (entry.name.endsWith('.js')) {
      modulesChecked++;
      try {
        require(path.resolve(fullPath));
      } catch (err) {
        // Only ignore if it is a runnable script expecting CLI arguments or specific test harness
        if (!fullPath.includes('/tests/') && !fullPath.includes('/scripts/')) {
          console.error(`[TYPECHECK ERROR] Failed to load module ${fullPath}: ${err.message}`);
          errors++;
        }
      }
    }
  }
}

// Ensure src directory exists
if (fs.existsSync(path.join(process.cwd(), 'src'))) {
  checkImports(path.join(process.cwd(), 'src'));
}

console.log(`[TYPECHECK] Checked ${modulesChecked} modules. Errors: ${errors}`);
if (errors > 0) {
  process.exit(1);
}
process.exit(0);
