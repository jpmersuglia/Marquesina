const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const torrentStream = require('torrent-stream');
const parseTorrent = require('parse-torrent');

const PORT = process.env.PORT || 3333;

// Lista de los mejores trackers públicos para garantizar conexión instantánea a cualquier magnet
const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.qu.ax:6969/announce',
  'udp://explodie.org:6969/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://tracker.coppersurfer.tk:6969/announce',
  'http://tracker.openbittorrent.com:80/announce'
];

// Almacén de motores torrent activos en memoria: infoHash -> { engine, lastAccess, activeStreams, files }
const activeEngines = new Map();

function getTorrentEngine(magnetOrHash) {
  let magnet = (magnetOrHash || '').trim();
  if (!magnet.startsWith('magnet:?')) {
    magnet = 'magnet:?xt=urn:btih:' + magnet;
  }

  // Extraer infoHash canónico normalizado (40 caracteres hex)
  let infoHash;
  try {
    const parsed = parseTorrent(magnet);
    infoHash = (parsed.infoHash || '').toLowerCase();
  } catch (e) {
    const match = magnet.match(/urn:btih:([a-zA-Z0-9]+)/i);
    infoHash = match ? match[1].toLowerCase() : null;
  }

  if (!infoHash) {
    throw new Error('Enlace magnet o infoHash inválido');
  }

  if (activeEngines.has(infoHash)) {
    const entry = activeEngines.get(infoHash);
    entry.lastAccess = Date.now();
    return entry;
  }

  console.log(`[Torrent] Inicializando motor torrent: ${infoHash}`);

  const engine = torrentStream(magnet, {
    tmp: os.tmpdir(),
    trackers: DEFAULT_TRACKERS,
    verify: false, // CLAVE: No verificar piezas en disco al inicio (reduce carga de 5 min a 200ms)
    uploads: 0,
    connections: 60
  });

  try {
    engine.listen(0);
  } catch(e) {}

  const entry = {
    infoHash,
    engine,
    ready: false,
    lastAccess: Date.now(),
    activeStreams: 0,
    files: []
  };

  engine.on('ready', () => {
    entry.ready = true;
    entry.files = engine.files;
    // Deseleccionar todos los archivos para evitar descargas en segundo plano de episodios no solicitados
    engine.files.forEach(f => {
      try { f.deselect(); } catch(e) {}
    });
    console.log(`[Torrent] Listo: "${engine.torrent ? engine.torrent.name : infoHash}" (${engine.files.length} archivos)`);
  });

  engine.on('error', (err) => {
    console.warn(`[Torrent Error] ${infoHash}:`, err.message);
  });

  activeEngines.set(infoHash, entry);
  return entry;
}

// Limpieza automática de torrents verdaderamente inactivos (> 3 horas sin uso ni streams activos)
setInterval(() => {
  const now = Date.now();
  for (const [hash, entry] of activeEngines.entries()) {
    if ((entry.activeStreams || 0) === 0 && (now - entry.lastAccess > 3 * 60 * 60 * 1000)) {
      console.log(`[Torrent] Liberando motor inactivo: ${hash}`);
      try {
        entry.engine.destroy(() => {});
      } catch(e) {}
      activeEngines.delete(hash);
    }
  }
}, 10 * 60 * 1000);

function srtToVtt(srtText) {
  if (!srtText) return "WEBVTT\n\n";
  let text = srtText.trim();
  if (text.startsWith("WEBVTT")) return text;
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  text = text.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2 --> $3.$4');
  return "WEBVTT\n\n" + text;
}

function decodeText(buffer) {
  if (typeof buffer === 'string') return buffer;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (e) {
    try {
      return new TextDecoder('windows-1252').decode(buffer);
    } catch (err) {
      return new TextDecoder('utf-8').decode(buffer);
    }
  }
}

// Calcula el progreso de descarga de un archivo específico del torrent
// usando el bitfield (mapa de piezas descargadas del motor).
function getFileProgress(entry, fileIndex) {
  if (!entry || !entry.ready || !entry.engine || !entry.engine.torrent || !entry.engine.bitfield) {
    return { engineReady: false, percent: 0, downloadedPieces: 0, totalPieces: 0 };
  }
  const file = entry.engine.files[fileIndex];
  if (!file) {
    return { engineReady: true, percent: 0, downloadedPieces: 0, totalPieces: 0, error: 'fileIndex fuera de rango' };
  }
  const torrent = entry.engine.torrent;
  const pieceLength = torrent.pieceLength;
  const startPiece = Math.floor(file.offset / pieceLength);
  const endPiece = Math.floor((file.offset + file.length - 1) / pieceLength);
  const totalPieces = endPiece - startPiece + 1;
  let downloadedPieces = 0;
  for (let i = startPiece; i <= endPiece; i++) {
    if (entry.engine.bitfield.get(i)) downloadedPieces++;
  }
  const speed = (entry.engine.swarm && typeof entry.engine.swarm.downloadSpeed === 'function')
    ? entry.engine.swarm.downloadSpeed()
    : 0;
  return {
    engineReady: true,
    percent: totalPieces > 0 ? Math.round(downloadedPieces / totalPieces * 100) : 0,
    downloadedPieces,
    totalPieces,
    downloadedMB: parseFloat((downloadedPieces * pieceLength / (1024 * 1024)).toFixed(1)),
    totalMB: parseFloat((file.length / (1024 * 1024)).toFixed(1)),
    speedKBps: Math.round(speed / 1024),
    prebuffering: entry.prebuffering ? entry.prebuffering.has(fileIndex) : false
  };
}


const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ==========================================
  // API: Inspeccionar archivos de un Torrent/Magnet
  // GET /api/torrent/inspect?magnet=...
  // ==========================================
  if (req.url.startsWith('/api/torrent/inspect?')) {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const magnet = parsedUrl.searchParams.get('magnet');
    if (!magnet) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Parámetro magnet requerido' }));
      return;
    }

    try {
      const entry = getTorrentEngine(magnet);
      const onReady = () => {
        const fileList = entry.engine.files.map((f, idx) => ({
          index: idx,
          name: f.name,
          path: f.path,
          length: f.length
        }));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          infoHash: entry.infoHash,
          name: entry.engine.torrent ? entry.engine.torrent.name : '',
          files: fileList
        }));
      };

      if (entry.ready) {
        onReady();
      } else {
        // Esperar hasta 45 segundos para obtener metadatos de los peers
        const timer = setTimeout(() => {
          res.writeHead(504, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Tiempo de espera agotado buscando metadatos del torrent en la red' }));
        }, 45000);

        entry.engine.once('ready', () => {
          clearTimeout(timer);
          onReady();
        });
      }
    } catch(err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ==========================================
  // API: Progreso de descarga de un archivo de torrent
  // GET /api/torrent/progress?magnet=...&fileIndex=N
  // ==========================================
  if (req.url.startsWith('/api/torrent/progress?')) {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const magnet = parsedUrl.searchParams.get('magnet');
    const fileIndex = parseInt(parsedUrl.searchParams.get('fileIndex') || '0', 10);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    try {
      const parsed = parseTorrent(magnet || '');
      const infoHash = (parsed.infoHash || '').toLowerCase();
      if (!infoHash || !activeEngines.has(infoHash)) {
        res.end(JSON.stringify({ engineReady: false, percent: 0, speedKBps: 0, prebuffering: false }));
      } else {
        const entry = activeEngines.get(infoHash);
        res.end(JSON.stringify(getFileProgress(entry, fileIndex)));
      }
    } catch (err) {
      res.end(JSON.stringify({ engineReady: false, percent: 0, speedKBps: 0, error: err.message }));
    }
    return;
  }

  // ==========================================
  // API: Pre-buffer de los primeros N bytes de un archivo de torrent
  // GET /api/torrent/prebuffer?magnet=...&fileIndex=N&bytes=N
  // Inicia la descarga anticipada sin bloquear. Responde inmediatamente.
  // ==========================================
  if (req.url.startsWith('/api/torrent/prebuffer?')) {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const magnet = parsedUrl.searchParams.get('magnet');
    const fileIndex = parseInt(parsedUrl.searchParams.get('fileIndex') || '0', 10);
    const prebufferBytes = parseInt(parsedUrl.searchParams.get('bytes') || String(60 * 1024 * 1024), 10); // 60 MB por defecto

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });

    try {
      const entry = getTorrentEngine(magnet);

      const doPrebuffer = () => {
        const file = entry.engine.files[fileIndex];
        if (!file) { res.end(JSON.stringify({ ok: false, error: 'fileIndex fuera de rango' })); return; }

        // Evitar arrancar un prebuffer duplicado para el mismo archivo
        if (!entry.prebuffering) entry.prebuffering = new Set();
        if (entry.prebuffering.has(fileIndex)) {
          res.end(JSON.stringify({ ok: true, alreadyRunning: true }));
          return;
        }

        const progress = getFileProgress(entry, fileIndex);
        if (progress.percent >= 100) {
          res.end(JSON.stringify({ ok: true, alreadyDone: true, percent: 100 }));
          return;
        }

        entry.prebuffering.add(fileIndex);
        entry.lastAccess = Date.now();

        const endByte = Math.min(prebufferBytes, file.length) - 1;
        let stream;
        try {
          stream = file.createReadStream({ start: 0, end: endByte });
        } catch (e) {
          entry.prebuffering.delete(fileIndex);
          res.end(JSON.stringify({ ok: false, error: e.message }));
          return;
        }

        // Drenar el stream (sin guardar en memoria) para forzar la descarga de piezas
        stream.resume();
        stream.on('end', () => {
          entry.prebuffering.delete(fileIndex);
          console.log(`[Torrent] Prebuffer completo: fileIndex=${fileIndex}, ${(endByte / 1024 / 1024).toFixed(1)} MB`);
        });
        stream.on('error', (err) => {
          entry.prebuffering.delete(fileIndex);
          console.warn(`[Torrent] Prebuffer error fileIndex=${fileIndex}:`, err.message);
        });

        console.log(`[Torrent] Iniciando prebuffer fileIndex=${fileIndex}, primeros ${(endByte / 1024 / 1024).toFixed(1)} MB`);
        res.end(JSON.stringify({ ok: true, started: true, bytes: endByte + 1 }));
      };

      if (entry.ready) {
        doPrebuffer();
      } else {
        entry.engine.once('ready', doPrebuffer);
        res.end(JSON.stringify({ ok: true, waitingForReady: true }));
      }
    } catch (err) {
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // ==========================================
  // API: Streaming de video de un Torrent/Magnet
  // GET /api/torrent/stream?magnet=...&fileIndex=N
  // ==========================================
  if (req.url.startsWith('/api/torrent/stream?')) {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const magnet = parsedUrl.searchParams.get('magnet');
    const fileIndex = parseInt(parsedUrl.searchParams.get('fileIndex') || '0', 10);

    try {
      const entry = getTorrentEngine(magnet);
      const startStreaming = () => {
        const file = entry.engine.files[fileIndex];
        if (!file) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Archivo no encontrado en el torrent');
          return;
        }

        entry.activeStreams = (entry.activeStreams || 0) + 1;
        entry.lastAccess = Date.now();

        const ext = path.extname(file.name).toLowerCase();
        let mime = 'video/mp4';
        if (ext === '.mkv') mime = 'video/x-matroska';
        else if (ext === '.webm') mime = 'video/webm';
        else if (ext === '.avi') mime = 'video/x-msvideo';

        const total = file.length;
        const range = req.headers.range;

        if (range) {
          const parts = range.replace(/bytes=/, '').split('-');
          const start = parseInt(parts[0], 10);
          const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
          const chunkSize = (end - start) + 1;

          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
            'Content-Type': mime,
            'Access-Control-Allow-Origin': '*'
          });

          const stream = file.createReadStream({ start, end });
          stream.pipe(res);
          stream.on('data', () => {
            entry.lastAccess = Date.now();
          });
          res.on('close', () => {
            entry.activeStreams = Math.max(0, (entry.activeStreams || 1) - 1);
            entry.lastAccess = Date.now();
            try { stream.destroy(); } catch(e) {}
          });
        } else {
          res.writeHead(200, {
            'Content-Length': total,
            'Accept-Ranges': 'bytes',
            'Content-Type': mime,
            'Access-Control-Allow-Origin': '*'
          });

          const stream = file.createReadStream();
          stream.pipe(res);
          stream.on('data', () => {
            entry.lastAccess = Date.now();
          });
          res.on('close', () => {
            entry.activeStreams = Math.max(0, (entry.activeStreams || 1) - 1);
            entry.lastAccess = Date.now();
            try { stream.destroy(); } catch(e) {}
          });
        }
      };

      if (entry.ready) {
        startStreaming();
      } else {
        const timer = setTimeout(() => {
          res.writeHead(504, { 'Content-Type': 'text/plain' });
          res.end('Tiempo de espera agotado buscando archivo en la red torrent');
        }, 60000);

        entry.engine.once('ready', () => {
          clearTimeout(timer);
          startStreaming();
        });
      }
    } catch(err) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Error de streaming: ' + err.message);
    }
    return;
  }

  // ==========================================
  // API: Subtítulos de un Torrent/Magnet (convertidos a WebVTT)
  // GET /api/torrent/sub?magnet=...&fileIndex=N
  // ==========================================
  if (req.url.startsWith('/api/torrent/sub?')) {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const magnet = parsedUrl.searchParams.get('magnet');
    const fileIndex = parseInt(parsedUrl.searchParams.get('fileIndex') || '0', 10);

    try {
      const entry = getTorrentEngine(magnet);
      const sendSub = () => {
        const file = entry.engine.files[fileIndex];
        if (!file) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Archivo de subtítulo no encontrado en el torrent');
          return;
        }

        const stream = file.createReadStream();
        const chunks = [];
        stream.on('data', c => chunks.push(c));
        stream.on('end', () => {
          const rawBuffer = Buffer.concat(chunks);
          const rawText = decodeText(rawBuffer);
          const vtt = srtToVtt(rawText);
          res.writeHead(200, {
            'Content-Type': 'text/vtt; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(vtt);
        });
        stream.on('error', (err) => {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Error leyendo subtítulo: ' + err.message);
        });
      };

      if (entry.ready) {
        sendSub();
      } else {
        const timer = setTimeout(() => {
          res.writeHead(504, { 'Content-Type': 'text/plain' });
          res.end('Tiempo de espera agotado descargando subtítulo');
        }, 20000);

        entry.engine.once('ready', () => {
          clearTimeout(timer);
          sendSub();
        });
      }
    } catch(err) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Error: ' + err.message);
    }
    return;
  }

  // ==========================================
  // API: Puente para subtítulos HTTP externos (CORS + WebVTT)
  // GET /api/sub?url=...
  // ==========================================
  if (req.url.startsWith('/api/sub?url=')) {
    const rawTarget = decodeURIComponent(req.url.slice('/api/sub?url='.length));
    try {
      const parsed = new URL(rawTarget);
      const options = {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        headers: {}
      };
      if (parsed.username && parsed.password) {
        options.headers['Authorization'] = 'Basic ' + Buffer.from(parsed.username + ':' + parsed.password).toString('base64');
      }

      http.get(options, (upstreamRes) => {
        let chunks = [];
        upstreamRes.on('data', c => chunks.push(c));
        upstreamRes.on('end', () => {
          const rawBuffer = Buffer.concat(chunks);
          const srtText = decodeText(rawBuffer);
          const vttText = srtToVtt(srtText);
          res.writeHead(200, {
            'Content-Type': 'text/vtt; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(vttText);
        });
      }).on('error', (err) => {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end("Error al conectar con el servidor de subtítulos: " + err.message);
      });
    } catch(err) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end("URL inválida: " + err.message);
    }
    return;
  }

  // ==========================================
  // Servir archivos estáticos de la aplicación
  // ==========================================
  let reqPath = req.url.split('?')[0];
  if (reqPath === '/' || reqPath === '') reqPath = '/index.html';
  const filePath = path.join(__dirname, reqPath);

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Archivo no encontrado');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.m3u': 'audio/x-mpegurl; charset=utf-8',
    '.vtt': 'text/vtt; charset=utf-8',
    '.srt': 'text/plain; charset=utf-8'
  };

  res.writeHead(200, {
    'Content-Type': mimeTypes[ext] || 'application/octet-stream',
    'Access-Control-Allow-Origin': '*'
  });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('Marquesina corriendo en http://localhost:' + PORT);
});

