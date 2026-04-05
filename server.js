'use strict';
const http   = require('http');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const PORT   = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const rooms  = new Map(); // roomId → Set<socket>
const MIME   = { '.html':'text/html; charset=utf-8', '.css':'text/css', '.js':'text/javascript', '.ico':'image/x-icon' };
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const server = http.createServer((req, res) => {
  if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
  let fp = path.join(PUBLIC, req.url === '/' ? 'index.html' : req.url);
  if (!fp.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
  fs.stat(fp, (err, stat) => {
    if (err || !stat.isFile()) fp = path.join(PUBLIC, 'index.html');
    const mime = MIME[path.extname(fp)] || 'application/octet-stream';
    fs.readFile(fp, (e, data) => {
      if (e) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  });
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + WS_MAGIC).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );

  let buf = Buffer.alloc(0);
  let currentRoom = null;
  let mySeat = null;

  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    let r;
    try { r = parseFrames(buf); } catch { socket.destroy(); return; }
    buf = r.remaining;
    for (const f of r.messages) {
      if (f.type === 'close') { socket.destroy(); return; }
      if (f.type === 'ping')  { try { socket.write(Buffer.from([0x8a,0x00])); } catch{} continue; }
      if (f.type !== 'text')  continue;
      let msg; try { msg = JSON.parse(f.data); } catch { continue; }

      if (msg.type === 'join') {
        currentRoom = String(msg.roomId).trim().toUpperCase();
        if (!rooms.has(currentRoom)) rooms.set(currentRoom, new Set());
        // Seat = position in room (1 = leader/host, 2 = joiner)
        mySeat = rooms.get(currentRoom).size + 1;
        rooms.get(currentRoom).add(socket);
        const count = rooms.get(currentRoom).size;
        safeSend(socket, { type:'joined', roomId:currentRoom, count, seat: mySeat });
        broadcast(currentRoom, socket, { type:'peer_joined', count });
        broadcastAll(currentRoom, { type:'user_count', count });
      } else if (currentRoom && rooms.has(currentRoom)) {
        broadcast(currentRoom, socket, msg);
      }
    }
  });

  const cleanup = () => {
    if (!currentRoom || !rooms.has(currentRoom)) return;
    rooms.get(currentRoom).delete(socket);
    const count = rooms.get(currentRoom).size;
    if (count === 0) { rooms.delete(currentRoom); }
    else {
      broadcast(currentRoom, socket, { type:'peer_left', count });
      broadcastAll(currentRoom, { type:'user_count', count });
    }
    currentRoom = null;
  };
  socket.on('close', cleanup);
  socket.on('error', () => { cleanup(); socket.destroy(); });
});

function safeSend(s, obj) { if (s.writable) try { s.write(encodeFrame(JSON.stringify(obj))); } catch{} }
function broadcast(rid, sender, obj) {
  if (!rooms.has(rid)) return;
  const f = encodeFrame(JSON.stringify(obj));
  rooms.get(rid).forEach(s => { if (s !== sender && s.writable) try { s.write(f); } catch{} });
}
function broadcastAll(rid, obj) {
  if (!rooms.has(rid)) return;
  const f = encodeFrame(JSON.stringify(obj));
  rooms.get(rid).forEach(s => { if (s.writable) try { s.write(f); } catch{} });
}

function parseFrames(buf) {
  const messages = []; let offset = 0;
  while (offset < buf.length) {
    if (buf.length - offset < 2) break;
    const b0 = buf[offset], b1 = buf[offset+1];
    const opcode = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
    let plen = b1 & 0x7f, hlen = 2;
    if (plen === 126) { if (buf.length-offset < 4) break; plen = buf.readUInt16BE(offset+2); hlen = 4; }
    else if (plen === 127) { if (buf.length-offset < 10) break; plen = buf.readUInt32BE(offset+6); hlen = 10; }
    if (masked) hlen += 4;
    if (buf.length-offset < hlen+plen) break;
    let payload = Buffer.from(buf.slice(offset+hlen, offset+hlen+plen));
    if (masked) { const ms = offset+hlen-4; for (let i=0;i<payload.length;i++) payload[i]^=buf[ms+(i%4)]; }
    if (opcode===0x1) messages.push({type:'text', data:payload.toString('utf8')});
    else if (opcode===0x8) messages.push({type:'close'});
    else if (opcode===0x9) messages.push({type:'ping'});
    offset += hlen+plen;
  }
  return { messages, remaining: Buffer.from(buf.slice(offset)) };
}

function encodeFrame(data) {
  const p = Buffer.from(data,'utf8'), len = p.length;
  let h;
  if (len < 126)      { h = Buffer.alloc(2);  h[0]=0x81; h[1]=len; }
  else if (len<65536) { h = Buffer.alloc(4);  h[0]=0x81; h[1]=126; h.writeUInt16BE(len,2); }
  else                { h = Buffer.alloc(10); h[0]=0x81; h[1]=127; h.writeUInt32BE(0,2); h.writeUInt32BE(len,6); }
  return Buffer.concat([h, p]);
}

server.listen(PORT, () => console.log(`\n  ▶  SyncPlay → http://localhost:${PORT}\n`));
