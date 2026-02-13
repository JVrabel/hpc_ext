/**
 * Build a .vsix package without requiring vsce or npm.
 * Usage: node scripts/package.js
 *
 * A .vsix is a ZIP (using deflate) with:
 *   [Content_Types].xml
 *   extension.vsixmanifest
 *   extension/  — the actual extension files
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const outName = `${pkg.name}-${pkg.version}.vsix`;
const outPath = path.join(ROOT, outName);

// Files/dirs to include in extension/
const INCLUDE = [
  'dist/',
  'media/',
  'package.json',
  'LICENSE',
  'README.md',
];

// ---- ZIP writer (minimal, deflate-only) ----

class ZipWriter {
  constructor() {
    this.entries = [];
    this.offset = 0;
    this.buffers = [];
  }

  addFile(name, data) {
    const compressed = zlib.deflateRawSync(data);
    const useDeflate = compressed.length < data.length;
    const stored = useDeflate ? compressed : data;
    const crc = crc32(data);
    const method = useDeflate ? 8 : 0;

    // Local file header
    const nameBytes = Buffer.from(name, 'utf8');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);  // signature
    header.writeUInt16LE(20, 4);           // version needed
    header.writeUInt16LE(0, 6);            // flags
    header.writeUInt16LE(method, 8);       // compression
    header.writeUInt16LE(0, 10);           // mod time
    header.writeUInt16LE(0, 12);           // mod date
    header.writeUInt32LE(crc, 14);         // crc32
    header.writeUInt32LE(stored.length, 18);  // compressed size
    header.writeUInt32LE(data.length, 22);    // uncompressed size
    header.writeUInt16LE(nameBytes.length, 26); // name length
    header.writeUInt16LE(0, 28);           // extra length

    this.entries.push({
      name: nameBytes,
      offset: this.offset,
      crc,
      compressedSize: stored.length,
      uncompressedSize: data.length,
      method,
    });

    this.buffers.push(header, nameBytes, stored);
    this.offset += header.length + nameBytes.length + stored.length;
  }

  finish() {
    const centralStart = this.offset;
    for (const e of this.entries) {
      const rec = Buffer.alloc(46);
      rec.writeUInt32LE(0x02014b50, 0);     // signature
      rec.writeUInt16LE(20, 4);              // version made by
      rec.writeUInt16LE(20, 6);              // version needed
      rec.writeUInt16LE(0, 8);               // flags
      rec.writeUInt16LE(e.method, 10);       // compression
      rec.writeUInt16LE(0, 12);              // mod time
      rec.writeUInt16LE(0, 14);              // mod date
      rec.writeUInt32LE(e.crc, 16);          // crc32
      rec.writeUInt32LE(e.compressedSize, 20);
      rec.writeUInt32LE(e.uncompressedSize, 24);
      rec.writeUInt16LE(e.name.length, 28);  // name length
      rec.writeUInt16LE(0, 30);              // extra length
      rec.writeUInt16LE(0, 32);              // comment length
      rec.writeUInt16LE(0, 34);              // disk number
      rec.writeUInt16LE(0, 36);              // internal attrs
      rec.writeUInt32LE(0, 38);              // external attrs
      rec.writeUInt32LE(e.offset, 42);       // local header offset
      this.buffers.push(rec, e.name);
      this.offset += rec.length + e.name.length;
    }

    const centralSize = this.offset - centralStart;

    // End of central directory
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);                     // disk number
    end.writeUInt16LE(0, 6);                     // central dir disk
    end.writeUInt16LE(this.entries.length, 8);    // entries on disk
    end.writeUInt16LE(this.entries.length, 10);   // total entries
    end.writeUInt32LE(centralSize, 12);           // central dir size
    end.writeUInt32LE(centralStart, 16);          // central dir offset
    end.writeUInt16LE(0, 20);                     // comment length
    this.buffers.push(end);

    return Buffer.concat(this.buffers);
  }
}

// CRC-32 (standard polynomial)
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ---- Collect files ----

function walk(dir, base) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.join(base, entry.name).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      results.push(...walk(full, rel));
    } else {
      results.push({ rel, full });
    }
  }
  return results;
}

// ---- Generate manifests ----

function contentTypesXml() {
  return `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json"/>
  <Default Extension=".js" ContentType="application/javascript"/>
  <Default Extension=".js.map" ContentType="application/json"/>
  <Default Extension=".svg" ContentType="image/svg+xml"/>
  <Default Extension=".md" ContentType="text/markdown"/>
  <Default Extension=".txt" ContentType="text/plain"/>
  <Default Extension=".vsixmanifest" ContentType="text/xml"/>
</Types>`;
}

function vsixManifest() {
  const id = `${pkg.publisher}.${pkg.name}`;
  return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"
  xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${pkg.name}" Version="${pkg.version}" Publisher="${pkg.publisher}"/>
    <DisplayName>${pkg.displayName}</DisplayName>
    <Description xml:space="preserve">${pkg.description}</Description>
    <Tags>${(pkg.categories || []).join(',')}</Tags>
    <Categories>${(pkg.categories || ['Other']).join(',')}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${pkg.engines.vscode}"/>
      <Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="${(pkg.repository && pkg.repository.url) || ''}"/>
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
  </Assets>
</PackageManifest>`;
}

// ---- Main ----

// 1. Ensure dist/ is built
if (!fs.existsSync(path.join(ROOT, 'dist', 'extension.js'))) {
  console.error('Error: dist/extension.js not found. Run "npm run build" first.');
  process.exit(1);
}

const zip = new ZipWriter();

// Add manifests
zip.addFile('[Content_Types].xml', Buffer.from(contentTypesXml(), 'utf8'));
zip.addFile('extension.vsixmanifest', Buffer.from(vsixManifest(), 'utf8'));

// Add extension files
let fileCount = 0;
for (const pattern of INCLUDE) {
  const full = path.join(ROOT, pattern);
  if (pattern.endsWith('/')) {
    // Directory
    if (!fs.existsSync(full)) { continue; }
    for (const file of walk(full, pattern)) {
      zip.addFile('extension/' + file.rel, fs.readFileSync(file.full));
      fileCount++;
    }
  } else {
    // Single file
    if (!fs.existsSync(full)) { continue; }
    zip.addFile('extension/' + pattern, fs.readFileSync(full));
    fileCount++;
  }
}

const result = zip.finish();
fs.writeFileSync(outPath, result);

console.log(`Packaged ${fileCount} files -> ${outName} (${(result.length / 1024).toFixed(0)} KB)`);
