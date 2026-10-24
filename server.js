// Fury Fists relay server: serves the game and connects two players by room code.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8777;
const PUB = path.join(__dirname, 'www');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  const u = decodeURIComponent((req.url || '/').split('?')[0]);
  if (u === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    res.end('ok');
    return;
  }
  const file = path.normalize(path.join(PUB, u === '/' ? 'index.html' : u));
  if (file !== PUB && !file.startsWith(PUB + path.sep)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });
const rooms = new Map(); // code -> { code, peers: [ws, ws] }
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

function newCode() {
  for (let tries = 0; tries < 200; tries++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += LETTERS[Math.floor(Math.random() * LETTERS.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}
function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function announce(room) { for (const p of room.peers) send(p, { t: 'peers', n: room.peers.length }); }
function fail(ws, m) { send(ws, { t: 'error', m }); setTimeout(() => { try { ws.close(); } catch (e) {} }, 200); }

wss.on('connection', (ws, req) => {
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('error', () => {});
  let q;
  try { q = new URL(req.url, 'http://x').searchParams; } catch (e) { ws.close(); return; }
  const action = q.get('a');
  let room, role;
  if (action === 'create') {
    if (rooms.size >= 500) return fail(ws, 'The server is busy. Try again in a minute.');
    const code = newCode();
    if (!code) return fail(ws, 'The server is busy. Try again in a minute.');
    room = { code, peers: [ws] };
    rooms.set(code, room);
    role = 'host';
  } else if (action === 'join') {
    const code = (q.get('room') || '').toUpperCase();
    room = rooms.get(code);
    if (!room) return fail(ws, 'Room ' + code + ' was not found. Check the code and try again.');
    if (room.peers.length >= 2) return fail(ws, 'That room is already full.');
    room.peers.push(ws);
    role = 'guest';
  } else { ws.close(); return; }

  send(ws, { t: 'role', r: role, room: room.code });
  announce(room);

  ws.on('message', (data, isBinary) => {
    for (const p of room.peers) if (p !== ws && p.readyState === 1) p.send(data, { binary: isBinary });
  });
  ws.on('close', () => {
    if (rooms.get(room.code) === room) rooms.delete(room.code);
    room.peers = room.peers.filter(p => p !== ws);
    for (const p of room.peers) {
      send(p, { t: 'peers', n: room.peers.length });
      setTimeout(() => { try { p.close(); } catch (e) {} }, 300);
    }
  });
});

setInterval(() => {
  wss.clients.forEach(ws => { if (!ws.alive) { ws.terminate(); return; } ws.alive = false; try { ws.ping(); } catch (e) {} });
}, 20000);

server.listen(PORT, () => console.log('Fury Fists server running on port ' + PORT));
