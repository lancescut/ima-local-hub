// Convert the approved mountain-window PNG into Windows, web and macOS icons.
// Run on Windows: node installer/make-icon.js
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const source = path.join(__dirname, 'brand-icon.png');
const publicDir = path.join(__dirname, '..', 'public');
if (!fs.existsSync(source)) throw new Error('Missing approved installer/brand-icon.png');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ima-brand-'));
const psQuote = s => "'" + s.replace(/'/g, "''") + "'";
const ps = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Drawing',
  '$source = [System.Drawing.Image]::FromFile(' + psQuote(source) + ')',
  'try {',
  '  foreach ($sz in @(' + [...SIZES, 1024].join(',') + ')) {',
  '    $scaled = New-Object System.Drawing.Bitmap($sz, $sz, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)',
  '    $g = [System.Drawing.Graphics]::FromImage($scaled)',
  '    try {',
  '      $g.Clear([System.Drawing.Color]::Transparent)',
  "      $g.CompositingMode = 'SourceCopy'",
  "      $g.InterpolationMode = 'HighQualityBicubic'",
  "      $g.PixelOffsetMode = 'HighQuality'",
  '      $g.DrawImage($source, 0, 0, $sz, $sz)',
  '    } finally { $g.Dispose() }',
  '    try {',
  '      $scaled.Save((Join-Path ' + psQuote(tmp) + ' "$sz.png"), [System.Drawing.Imaging.ImageFormat]::Png)',
  '      if ($sz -le 256) {',
  '        $rect = New-Object System.Drawing.Rectangle(0, 0, $sz, $sz)',
  '        $bd = $scaled.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)',
  '        try {',
  '          $buf = New-Object byte[] ($sz * $sz * 4)',
  '          for ($y = 0; $y -lt $sz; $y++) {',
  '            $ptr = [IntPtr]::Add($bd.Scan0, $y * $bd.Stride)',
  '            [System.Runtime.InteropServices.Marshal]::Copy($ptr, $buf, $y * $sz * 4, $sz * 4)',
  '          }',
  '          [System.IO.File]::WriteAllBytes((Join-Path ' + psQuote(tmp) + ' "$sz.bin"), $buf)',
  '        } finally { $scaled.UnlockBits($bd) }',
  '      }',
  '    } finally { $scaled.Dispose() }',
  '  }',
  '} finally { $source.Dispose() }'
].join('\n');

try {
  const scriptPath = path.join(tmp, 'convert.ps1');
  fs.writeFileSync(scriptPath, '\uFEFF' + ps, 'utf8');
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
    stdio: 'inherit', windowsHide: true
  });
  const entries = SIZES.map(size => {
    const raw = fs.readFileSync(path.join(tmp, size + '.bin'));
    const stride = size * 4;
    const xor = Buffer.alloc(stride * size);
    const maskStride = Math.ceil(size / 32) * 4;
    const mask = Buffer.alloc(maskStride * size);
    for (let y = 0; y < size; y++) {
      const bottomRow = size - 1 - y;
      raw.copy(xor, bottomRow * stride, y * stride, (y + 1) * stride);
      for (let x = 0; x < size; x++) {
        if (raw[y * stride + x * 4 + 3] === 0) {
          mask[bottomRow * maskStride + (x >> 3)] |= 0x80 >> (x & 7);
        }
      }
    }
    const header = Buffer.alloc(40);
    header.writeUInt32LE(40, 0);
    header.writeInt32LE(size, 4);
    header.writeInt32LE(size * 2, 8);
    header.writeUInt16LE(1, 12);
    header.writeUInt16LE(32, 14);
    header.writeUInt32LE(xor.length + mask.length, 20);
    return { size, data: Buffer.concat([header, xor, mask]) };
  });
  const ico = Buffer.alloc(6 + entries.length * 16 + entries.reduce((sum, e) => sum + e.data.length, 0));
  ico.writeUInt16LE(1, 2);
  ico.writeUInt16LE(entries.length, 4);
  let offset = 6 + entries.length * 16;
  entries.forEach((entry, index) => {
    const start = 6 + index * 16;
    ico[start] = ico[start + 1] = entry.size === 256 ? 0 : entry.size;
    ico.writeUInt16LE(1, start + 4);
    ico.writeUInt16LE(32, start + 6);
    ico.writeUInt32LE(entry.data.length, start + 8);
    ico.writeUInt32LE(offset, start + 12);
    entry.data.copy(ico, offset);
    offset += entry.data.length;
  });
  fs.writeFileSync(path.join(__dirname, 'icon.ico'), ico);
  fs.writeFileSync(path.join(publicDir, 'favicon.ico'), ico);
  fs.copyFileSync(path.join(tmp, '256.png'), path.join(publicDir, 'logo.png'));
  fs.copyFileSync(path.join(tmp, '1024.png'), path.join(__dirname, 'macos', 'AppIcon.png'));
  console.log('Mountain-window icons built:', SIZES.join('/'), 'px ICO, 256 px web PNG, 1024 px macOS PNG');
} finally {
  // Only unlink this conversion's known files; never recursively delete a computed path.
  for (const name of ['convert.ps1', ...[...SIZES, 1024].map(s => s + '.png'), ...SIZES.map(s => s + '.bin')]) {
    const file = path.join(tmp, name);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  fs.rmdirSync(tmp);
}
