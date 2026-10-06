#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

console.log('[LINT] Scanning codebase for syntax and forbidden patterns...');

const FORBIDDEN_PATTERNS = [
  { pattern: /parseFloat\s*\(/, message: 'Floats forbidden for money/price calculations. Use bigint centimes.' },
  { pattern: /SELECT\s+.*\s+FROM\s+.*\+\s*['"]/, message: 'String concatenated SQL forbidden. Use parameterized queries.' },
  { pattern: /INSERT\s+INTO\s+.*\+\s*['"]/, message: 'String concatenated SQL forbidden. Use parameterized queries.' },
  { pattern: /UPDATE\s+.*\+\s*['"]/, message: 'String concatenated SQL forbidden. Use parameterized queries.' },
  { pattern: /SET\s+LOCAL\s+app\.tenant_id\s*=\s*['"]?\s*;\s*--\s*bypass/i, message: 'RLS bypass attempt detected.' },
  { pattern: /DISABLE\s+ROW\s+LEVEL\s+SECURITY/i, message: 'Disabling RLS is strictly forbidden.' },
];

let errors = 0;
let filesChecked = 0;

function checkFile(fullPath) {
  if (!fs.existsSync(fullPath)) return;
  filesChecked++;
  const content = fs.readFileSync(fullPath, 'utf8');

  if (fullPath.endsWith('.js')) {
    try {
      // Strip shebang if present
      const cleanContent = content.startsWith('#!')
        ? content.replace(/^#![^\n]+/, '// shebang')
        : content;
      new Function(cleanContent);
    } catch (syntaxErr) {
      console.error(`[LINT ERROR] Syntax error in ${fullPath}: ${syntaxErr.message}`);
      errors++;
    }
  }

  for (const rule of FORBIDDEN_PATTERNS) {
    if (rule.pattern.test(content)) {
      if (!fullPath.includes('lint.js') && !fullPath.includes('mutation_test')) {
        console.error(`[LINT ERROR] Forbidden pattern in ${fullPath}: ${rule.message}`);
        errors++;
      }
    }
  }
}

function scanDirectory(dir) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanDirectory(fullPath);
    } else if (entry.name.endsWith('.js') || entry.name.endsWith('.ts') || entry.name.endsWith('.sql')) {
      checkFile(fullPath);
    }
  }
}

// Scan subdirectories
const TARGET_DIRS = ['src', 'tests', 'scripts', 'migrations'];
for (const target of TARGET_DIRS) {
  scanDirectory(path.join(process.cwd(), target));
}

// Check root files
['package.json'].forEach(f => {
  const p = path.join(process.cwd(), f);
  if (fs.existsSync(p)) {
    try {
      JSON.parse(fs.readFileSync(p, 'utf8'));
      filesChecked++;
    } catch (e) {
      console.error(`[LINT ERROR] Invalid JSON in ${f}: ${e.message}`);
      errors++;
    }
  }
});

console.log(`[LINT] Scanned ${filesChecked} files. Found ${errors} errors.`);
if (errors > 0) {
  process.exit(1);
}
process.exit(0);
