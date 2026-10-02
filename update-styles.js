#!/usr/bin/env node
// Script to update class names from old design to YolaFresh design system

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const appFile = path.join(__dirname, 'src', 'App.jsx');
let content = fs.readFileSync(appFile, 'utf-8');

// Track replacements
let replacements = 0;

// Color replacements: brand-* → yf-primary, slate-* → neutral-*
const colorMap = {
  'brand-900': 'yf-primary',
  'brand-800': 'yf-primary',
  'brand-700': 'yf-primary',
  'brand-600': 'yf-primary',
  'brand-100': 'yf-primary/10',
  'brand-50': 'neutral-50',

  'slate-900': 'neutral-900',
  'slate-800': 'neutral-800',
  'slate-700': 'neutral-700',
  'slate-600': 'neutral-600',
  'slate-500': 'neutral-500',
  'slate-400': 'neutral-400',
  'slate-300': 'neutral-300',
  'slate-200': 'neutral-200',
  'slate-100': 'neutral-100',
  'slate-50': 'neutral-50',

  'rose-600': 'yf-red',
};

// Apply color replacements
for (const [old, newClass] of Object.entries(colorMap)) {
  const regex = new RegExp(`\\b${old.replace(/-/g, '\\-')}\\b`, 'g');
  const newContent = content.replace(regex, newClass);
  if (newContent !== content) {
    replacements += (content.match(regex) || []).length;
    content = newContent;
  }
}

// Update old class string variables with new component classes
const classReplacements = [
  // Replace inputCls usage with .input
  [`className={inputCls + ' mb-3 mt-1'}`, `className="input mb-3 mt-1"`],
  [`className={inputCls + ' mt-1'}`, `className="input mt-1"`],
  [`className={inputCls + ' mb-4 mt-1'}`, `className="input mb-4 mt-1"`],
  [`className={inputCls + ' mb-3'}`, `className="input mb-3"`],
  [`className={inputCls}`, `className="input"`],

  // Replace btnPrimary with .btn-primary
  [`className={btnPrimary + ' w-full justify-center'}`, `className="btn-primary w-full"`],
  [`className={btnPrimary}`, `className="btn-primary"`],

  // Replace btnGhost with .btn-ghost
  [`className={btnGhost + ' disabled:opacity-40'}`, `className="btn-ghost disabled:opacity-40"`],
  [`className={btnGhost + ' flex-1 justify-center'}`, `className="btn-ghost flex-1"`],
  [`className={btnGhost}`, `className="btn-ghost"`],
];

for (const [old, newClass] of classReplacements) {
  const regex = old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const newContent = content.replace(new RegExp(regex, 'g'), newClass);
  if (newContent !== content) {
    replacements += 1;
    content = newContent;
  }
}

// Write the updated file
fs.writeFileSync(appFile, content, 'utf-8');

console.log(`✓ Updated App.jsx with ${replacements} replacements`);
console.log('Next steps:');
console.log('1. Review the changes');
console.log('2. Update the Header component to use the new Layout');
console.log('3. Test the styling');
