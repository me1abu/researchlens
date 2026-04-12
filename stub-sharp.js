// Run once after npm install: node stub-sharp.js
// Prevents sharp native binary crash when used with @xenova/transformers for text models
const fs   = require('fs');
const path = require('path');

const target = path.join(__dirname, 'node_modules', 'sharp', 'lib', 'index.js');
if (!fs.existsSync(target)) { console.log('sharp not found — nothing to stub'); process.exit(0); }

const stub = `// Stub: sharp native binary unavailable. Safe no-op for text-only NLP models.
'use strict';
function Sharp() { if (!(this instanceof Sharp)) return new Sharp(); return this; }
Sharp.prototype.resize   = function() { return this; };
Sharp.prototype.toBuffer = function() { return Promise.resolve(Buffer.alloc(0)); };
Sharp.prototype.toFile   = function() { return Promise.resolve({}); };
Sharp.prototype.metadata = function() { return Promise.resolve({ width:0, height:0, format:'stub' }); };
Sharp.prototype.raw      = function() { return this; };
Sharp.format = {}; Sharp.versions = {}; Sharp.vendor = {};
module.exports = Sharp;
`;

// Backup if not already done
const bak = target + '.bak';
if (!fs.existsSync(bak)) fs.copyFileSync(target, bak);
fs.writeFileSync(target, stub);
console.log('sharp stubbed successfully — @xenova/transformers will load without crash');
