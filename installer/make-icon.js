// 生成深红 iH 图标：PS 画 256 原图 + 缩放 16/32/48 → 标准多尺寸 BMP ICO
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const SIZES = [16, 32, 48, 256];
const tmp = os.tmpdir();
const binFor = s => path.join(tmp, `ihicon_${s}.bin`).replace(/\\/g, '\\\\');
const pngPath = path.join(tmp, 'AppIcon.png').replace(/\\/g, '\\\\');

const sizeList = SIZES.join(',');
const ps = `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap(256,256)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAliasGridFit'
$g.Clear([System.Drawing.Color]::FromArgb(0,0,0,0))
$brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255,166,30,42))
$p = New-Object System.Drawing.Drawing2D.GraphicsPath
$r=56; $s=20
$p.AddArc($s,$s,$r,$r,180,90); $p.AddArc(256-$s-$r,$s,$r,$r,270,90); $p.AddArc(256-$s-$r,256-$s-$r,$r,$r,0,90); $p.AddArc($s,256-$s-$r,$r,$r,90,90); $p.CloseFigure()
$g.FillPath($brush,$p)
$font = New-Object System.Drawing.Font('Segoe UI',108,[System.Drawing.FontStyle]::Bold)
$fmt = New-Object System.Drawing.StringFormat; $fmt.Alignment='Center'; $fmt.LineAlignment='Center'
$g.DrawString('iH',$font,[System.Drawing.Brushes]::White,128,132,$fmt)
$g.Dispose()
# 导出 512px PNG（macOS icns 用）
$big = New-Object System.Drawing.Bitmap(512,512)
$g3 = [System.Drawing.Graphics]::FromImage($big)
$g3.InterpolationMode = 'HighQualityBicubic'
$g3.DrawImage($bmp,0,0,512,512); $g3.Dispose()
$big.Save('${pngPath}',[System.Drawing.Imaging.ImageFormat]::Png)
foreach ($sz in @(${sizeList.split(',').join(',')})) {
  $scaled = New-Object System.Drawing.Bitmap($sz,$sz)
  $g2 = [System.Drawing.Graphics]::FromImage($scaled)
  $g2.InterpolationMode = 'HighQualityBicubic'
  $g2.DrawImage($bmp,0,0,$sz,$sz); $g2.Dispose()
  $rect = New-Object System.Drawing.Rectangle(0,0,$sz,$sz)
  $bd = $scaled.LockBits($rect,[System.Drawing.Imaging.ImageLockMode]::ReadOnly,[System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $out = [System.IO.File]::Create('ihicon_' + $sz + '.bin')
  $buf = New-Object byte[] ($bd.Stride * $sz)
  [System.Runtime.InteropServices.Marshal]::Copy($bd.Scan0,$buf,0,$buf.Length)
  $out.Write($buf,0,$buf.Length); $out.Close()
  $scaled.UnlockBits($bd); $scaled.Dispose()
}
`;
execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore', cwd: tmp });

// 组装多尺寸 ICO（BMP 条目）
const entries = SIZES.map(sz => {
  const raw = fs.readFileSync(binFor(sz).replace(/\\\\/g, '\\'));
  const stride = sz * 4;
  const xor = Buffer.alloc(stride * sz);
  for (let y = 0; y < sz; y++) raw.copy(xor, (sz - 1 - y) * stride, y * stride, y * stride + stride);
  const andRowBytes = Math.ceil(sz / 8 / 4) * 4;          // 32bit 对齐
  const and = Buffer.alloc(andRowBytes * sz);
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(sz, 4); header.writeInt32LE(sz * 2, 8);
  header.writeUInt16LE(1, 12); header.writeUInt16LE(32, 14);
  header.writeUInt32LE(xor.length + and.length, 20);
  return { size: sz, data: Buffer.concat([header, xor, and]) };
});

const total = entries.reduce((a, e) => a + e.data.length, 0);
const ico = Buffer.alloc(6 + 16 * entries.length + total);
ico.writeUInt16LE(0, 0); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(entries.length, 4);
let off = 6 + 16 * entries.length;
entries.forEach((e, i) => {
  const b = 6 + 16 * i;                 // ICONDIRENTRY 起点
  const dim = e.size === 256 ? 0 : e.size;
  ico[b] = dim; ico[b + 1] = dim;       // 宽/高（256 用 0 表示）
  ico[b + 2] = 0; ico[b + 3] = 0;       // colorCount / reserved
  ico.writeUInt16LE(1, b + 4);          // planes
  ico.writeUInt16LE(32, b + 6);         // bpp
  ico.writeUInt32LE(e.data.length, b + 8); // bytesInRes
  ico.writeUInt32LE(off, b + 12);       // imageOffset
  e.data.copy(ico, off); off += e.data.length;
});
fs.writeFileSync(path.join(__dirname, 'icon.ico'), ico);
fs.copyFileSync(pngPath.replace(/\\\\/g, '\\'), path.join(__dirname, 'macos', 'AppIcon.png'));
console.log('icon.ico written:', ico.length, 'bytes, sizes:', SIZES.join('/'), '+ AppIcon.png');
