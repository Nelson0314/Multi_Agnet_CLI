'use strict';
// 由 assets/icon.svg 產生 icon.png / icon.ico / icon.icns。
// 執行：npm run icons（用 Electron 的 Chromium 把 SVG 畫成各尺寸 PNG，再用純 Node 打包 ico / icns）
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ASSETS = path.join(__dirname, '..', 'assets');
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const ICNS_TYPES = [
  ['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024],
  ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512],
];

function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = 6 + 16 * pngs.length;
  const entries = pngs.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

function buildIcns(chunks) {
  const parts = chunks.map(({ type, data }) => {
    const h = Buffer.alloc(8);
    h.write(type, 0, 'ascii');
    h.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([h, data]);
  });
  const body = Buffer.concat(parts);
  const h = Buffer.alloc(8);
  h.write('icns', 0, 'ascii');
  h.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([h, body]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<html><body></body></html>');
  const svg = fs.readFileSync(path.join(ASSETS, 'icon.svg'), 'utf8');
  const render = async (size) => {
    const b64 = await win.webContents.executeJavaScript(`new Promise((ok, fail) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = c.height = ${size};
        const g = c.getContext('2d');
        g.imageSmoothingQuality = 'high';
        g.drawImage(img, 0, 0, ${size}, ${size});
        ok(c.toDataURL('image/png').split(',')[1]);
      };
      img.onerror = fail;
      img.src = 'data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}';
    })`);
    return Buffer.from(b64, 'base64');
  };
  const cache = new Map();
  const png = async (s) => cache.get(s) || cache.set(s, await render(s)).get(s);
  fs.writeFileSync(path.join(ASSETS, 'icon.png'), await png(1024));
  fs.writeFileSync(path.join(ASSETS, 'icon-256.png'), await png(256));
  const ico = [];
  for (const size of ICO_SIZES) ico.push({ size, data: await png(size) });
  fs.writeFileSync(path.join(ASSETS, 'icon.ico'), buildIco(ico));
  const icns = [];
  for (const [type, size] of ICNS_TYPES) icns.push({ type, data: await png(size) });
  fs.writeFileSync(path.join(ASSETS, 'icon.icns'), buildIcns(icns));
  console.log('icons written to', ASSETS);
  app.exit(0);
});
