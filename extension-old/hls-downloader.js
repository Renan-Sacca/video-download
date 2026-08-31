// Obtém parâmetros da URL
const urlParams = new URLSearchParams(window.location.search);
let videoUrl = urlParams.get('url');
let filename = urlParams.get('filename') || 'video.mp4';

// Elementos DOM
const statusEl = document.getElementById('status');
const progressEl = document.getElementById('progress');
const filenameEl = document.getElementById('filename');
const sizeEl = document.getElementById('size');
const speedEl = document.getElementById('speed');
const timeEl = document.getElementById('time');
const cancelBtn = document.getElementById('cancelBtn');
const closeBtn = document.getElementById('closeBtn');
const errorEl = document.getElementById('error');

let cancelled = false;
let startTime;

// ---------- Utilidades ----------

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '-';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.style.display = 'block';
  statusEl.textContent = 'Erro ao baixar';
  cancelBtn.style.display = 'none';
  closeBtn.style.display = 'block';
  console.error('[HLS Downloader]', message);
}

function setProgress(percent) {
  const p = Math.min(100, Math.max(0, percent));
  progressEl.style.width = p + '%';
  progressEl.textContent = Math.round(p) + '%';
}

// Resolve URL relativa contra uma base
function resolveUrl(base, relative) {
  try {
    return new URL(relative, base).href;
  } catch (e) {
    return relative;
  }
}

// Extrai a URL real do .m3u8 caso esteja embutida em um parâmetro (ex: videohls.php?d=...m3u8)
function extractRealUrl(url) {
  try {
    const u = new URL(url);
    // Procura qualquer parâmetro que contenha um .m3u8
    for (const [, value] of u.searchParams.entries()) {
      if (value && value.includes('.m3u8')) {
        return value;
      }
    }
    // Caso o próprio parâmetro 'd' aponte para um arquivo
    const d = u.searchParams.get('d');
    if (d && (d.includes('.mp4') || d.includes('.m3u8'))) {
      return d;
    }
  } catch (e) {}
  return url;
}

// Fetch com host_permissions (ignora CORS)
async function fetchWithRetry(url, options = {}, retries = 3) {
  let lastError;
  for (let i = 0; i < retries; i++) {
    if (cancelled) throw new Error('Cancelado');
    try {
      const response = await fetch(url, options);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      return response;
    } catch (e) {
      lastError = e;
      console.warn(`[HLS Downloader] Tentativa ${i + 1}/${retries} falhou para ${url}:`, e.message);
      await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw lastError;
}

// ---------- Parsing de M3U8 ----------

function parseMasterPlaylist(text, baseUrl) {
  const lines = text.split('\n').map(l => l.trim());
  const variants = [];

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      const bandwidthMatch = lines[i].match(/BANDWIDTH=(\d+)/);
      const resolutionMatch = lines[i].match(/RESOLUTION=(\d+x\d+)/);
      const bandwidth = bandwidthMatch ? parseInt(bandwidthMatch[1]) : 0;
      const resolution = resolutionMatch ? resolutionMatch[1] : '';
      // A próxima linha não comentada é a URL
      let j = i + 1;
      while (j < lines.length && (lines[j].startsWith('#') || lines[j] === '')) j++;
      if (j < lines.length) {
        variants.push({
          url: resolveUrl(baseUrl, lines[j]),
          bandwidth,
          resolution
        });
      }
    }
  }
  return variants;
}

function parseMediaPlaylist(text, baseUrl) {
  const lines = text.split('\n').map(l => l.trim());
  const segments = [];
  let currentKey = null;
  let sequence = 0;
  let totalDuration = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE')) {
      const m = line.match(/:(\d+)/);
      if (m) sequence = parseInt(m[1]);
    } else if (line.startsWith('#EXT-X-KEY')) {
      const methodMatch = line.match(/METHOD=([^,]+)/);
      const uriMatch = line.match(/URI="([^"]+)"/);
      const ivMatch = line.match(/IV=0x([0-9A-Fa-f]+)/);
      const method = methodMatch ? methodMatch[1] : 'NONE';

      if (method === 'NONE') {
        currentKey = null;
      } else {
        currentKey = {
          method,
          uri: uriMatch ? resolveUrl(baseUrl, uriMatch[1]) : null,
          iv: ivMatch ? hexToBytes(ivMatch[1]) : null
        };
      }
    } else if (line.startsWith('#EXTINF')) {
      const durMatch = line.match(/#EXTINF:([\d.]+)/);
      const duration = durMatch ? parseFloat(durMatch[1]) : 0;
      // Próxima linha não comentada é a URL do segmento
      let j = i + 1;
      while (j < lines.length && (lines[j].startsWith('#') || lines[j] === '')) j++;
      if (j < lines.length) {
        const segIndex = segments.length;
        let iv = null;
        if (currentKey) {
          iv = currentKey.iv || sequenceToIV(sequence + segIndex);
        }
        segments.push({
          url: resolveUrl(baseUrl, lines[j]),
          duration,
          key: currentKey ? { ...currentKey, iv } : null
        });
        totalDuration += duration;
      }
    }
  }
  return { segments, totalDuration };
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

// Gera IV a partir do número de sequência (16 bytes big-endian)
function sequenceToIV(seq) {
  const iv = new Uint8Array(16);
  const view = new DataView(iv.buffer);
  // Coloca o número nos últimos 4 bytes (suficiente para a maioria dos casos)
  view.setUint32(12, seq, false);
  return iv;
}

// ---------- Descriptografia AES-128 ----------

const keyCache = new Map();

async function getDecryptionKey(uri) {
  if (keyCache.has(uri)) return keyCache.get(uri);
  const response = await fetchWithRetry(uri);
  const keyData = await response.arrayBuffer();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'AES-CBC' },
    false,
    ['decrypt']
  );
  keyCache.set(uri, cryptoKey);
  return cryptoKey;
}

async function decryptSegment(encryptedData, key) {
  const cryptoKey = await getDecryptionKey(key.uri);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv: key.iv },
    cryptoKey,
    encryptedData
  );
  return new Uint8Array(decrypted);
}

// ---------- Download principal ----------

async function downloadVideo() {
  try {
    if (!videoUrl) {
      showError('URL do vídeo não fornecida');
      return;
    }

    filenameEl.textContent = filename;

    // Extrai a URL real do m3u8 se estiver embutida
    videoUrl = extractRealUrl(videoUrl);
    console.log('[HLS Downloader] URL real:', videoUrl);

    if (videoUrl.includes('.m3u8')) {
      await downloadHLS();
    } else {
      await downloadDirect();
    }
  } catch (error) {
    if (cancelled) {
      statusEl.textContent = 'Download cancelado';
    } else {
      showError('Erro ao baixar: ' + error.message);
    }
  }
}

// Download direto (MP4, WebM, etc.)
async function downloadDirect() {
  statusEl.textContent = 'Baixando vídeo...';

  const response = await fetchWithRetry(videoUrl);
  const contentLength = +response.headers.get('Content-Length');
  const reader = response.body.getReader();

  let receivedLength = 0;
  const chunks = [];
  startTime = Date.now();

  while (true) {
    const { done, value } = await reader.read();
    if (done || cancelled) break;

    chunks.push(value);
    receivedLength += value.length;

    if (contentLength) {
      setProgress((receivedLength / contentLength) * 100);
      sizeEl.textContent = `${formatBytes(receivedLength)} / ${formatBytes(contentLength)}`;
    } else {
      sizeEl.textContent = formatBytes(receivedLength);
    }

    const elapsed = (Date.now() - startTime) / 1000;
    const speed = receivedLength / elapsed;
    speedEl.textContent = formatBytes(speed) + '/s';
    if (contentLength) {
      timeEl.textContent = formatTime((contentLength - receivedLength) / speed);
    }
  }

  if (cancelled) {
    statusEl.textContent = 'Download cancelado';
    return;
  }

  statusEl.textContent = 'Salvando arquivo...';
  downloadBlob(new Blob(chunks), filename);
  finishDownload();
}

// Download HLS (.m3u8) - baixa segmentos e junta
async function downloadHLS() {
  statusEl.textContent = 'Carregando lista de reprodução...';

  // Baixa o manifesto principal
  let response = await fetchWithRetry(videoUrl);
  let manifestText = await response.text();
  let manifestUrl = videoUrl;

  // Se for um master playlist, escolhe a melhor qualidade
  if (manifestText.includes('#EXT-X-STREAM-INF')) {
    const variants = parseMasterPlaylist(manifestText, manifestUrl);
    if (variants.length === 0) {
      throw new Error('Nenhuma variante encontrada no playlist');
    }
    // Escolhe a maior qualidade (maior bandwidth)
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    const best = variants[0];
    console.log('[HLS Downloader] Qualidade escolhida:', best.resolution, best.bandwidth);
    statusEl.textContent = `Carregando qualidade ${best.resolution || 'máxima'}...`;

    manifestUrl = best.url;
    response = await fetchWithRetry(manifestUrl);
    manifestText = await response.text();
  }

  // Parse dos segmentos
  const { segments, totalDuration } = parseMediaPlaylist(manifestText, manifestUrl);

  if (segments.length === 0) {
    throw new Error('Nenhum segmento de vídeo encontrado');
  }

  console.log(`[HLS Downloader] ${segments.length} segmentos, duração ~${Math.round(totalDuration)}s`);
  timeEl.textContent = formatTime(totalDuration) + ' (vídeo)';

  // Baixa todos os segmentos
  statusEl.textContent = `Baixando ${segments.length} segmentos...`;
  startTime = Date.now();

  const segmentData = new Array(segments.length);
  let downloadedCount = 0;
  let totalBytes = 0;

  // Baixa com paralelismo limitado
  const CONCURRENCY = 6;
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < segments.length && !cancelled) {
      const index = nextIndex++;
      const segment = segments[index];

      const segResponse = await fetchWithRetry(segment.url);
      let data = new Uint8Array(await segResponse.arrayBuffer());

      // Descriptografa se necessário
      if (segment.key && segment.key.method === 'AES-128') {
        data = await decryptSegment(data, segment.key);
      }

      segmentData[index] = data;
      downloadedCount++;
      totalBytes += data.length;

      // Atualiza progresso
      setProgress((downloadedCount / segments.length) * 100);
      sizeEl.textContent = formatBytes(totalBytes) + ` (${downloadedCount}/${segments.length} partes)`;

      const elapsed = (Date.now() - startTime) / 1000;
      const speed = totalBytes / elapsed;
      speedEl.textContent = formatBytes(speed) + '/s';

      const remainingSegs = segments.length - downloadedCount;
      const avgTimePerSeg = elapsed / downloadedCount;
      timeEl.textContent = formatTime(remainingSegs * avgTimePerSeg);
    }
  }

  // Inicia workers em paralelo
  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  if (cancelled) {
    statusEl.textContent = 'Download cancelado';
    return;
  }

  // Concatena todos os segmentos TS em um único buffer
  let totalLength = 0;
  for (const seg of segmentData) totalLength += seg.length;
  const allData = new Uint8Array(totalLength);
  let offset = 0;
  for (const seg of segmentData) {
    allData.set(seg, offset);
    offset += seg.length;
  }

  // Converte para MP4 usando ffmpeg (-c copy normaliza timestamps)
  statusEl.textContent = 'Convertendo para MP4...';
  setProgress(100);
  speedEl.textContent = '-';
  timeEl.textContent = 'Processando...';

  try {
    const mp4Data = await convertToMp4(allData);
    const outName = filename.replace(/\.[^/.]+$/, '') + '.mp4';
    downloadBlob(new Blob([mp4Data], { type: 'video/mp4' }), outName);
  } catch (e) {
    console.warn('[HLS Downloader] Falha na conversão MP4, salvando como .ts:', e);
    const outName = filename.replace(/\.[^/.]+$/, '') + '.ts';
    downloadBlob(new Blob([allData], { type: 'video/mp2t' }), outName);
  }

  finishDownload();
}

// ---------- Conversão TS -> MP4 com ffmpeg.wasm ----------

let ffmpegModule = null;

async function loadFFmpeg() {
  if (ffmpegModule) return ffmpegModule;

  if (typeof createFFmpegCore === 'undefined') {
    throw new Error('ffmpeg-core não carregado');
  }

  const wasmUrl = chrome.runtime.getURL('ffmpeg-core.wasm');

  ffmpegModule = await createFFmpegCore({
    locateFile: (path) => {
      if (path.endsWith('.wasm')) return wasmUrl;
      return path;
    },
  });

  // Configura logger (obrigatório no core 0.12)
  ffmpegModule.setLogger((data) => {
    if (data && data.message) console.log('[ffmpeg]', data.message);
  });

  return ffmpegModule;
}

async function convertToMp4(tsData) {
  const Module = await loadFFmpeg();
  const FS = Module.FS;

  const inputName = 'input.ts';
  const outputName = 'output.mp4';

  // Escreve o arquivo TS no sistema de arquivos virtual
  FS.writeFile(inputName, tsData);

  // Remuxa copiando os streams. -c copy não recodifica (rápido).
  // ffmpeg normaliza automaticamente os timestamps do TS ao gerar o MP4,
  // corrigindo a duração errada e os problemas de seek.
  Module.reset();
  let ret = Module.exec(
    '-i', inputName,
    '-c', 'copy',
    '-movflags', 'faststart',
    outputName
  );

  let outExists = false;
  try { FS.stat(outputName); outExists = true; } catch (e) { outExists = false; }

  // Se o copy falhar (timestamps de áudio quebrados), recodifica o áudio
  if (!outExists || (ret !== 0 && ret !== undefined)) {
    try { FS.unlink(outputName); } catch (e) {}
    Module.reset();
    ret = Module.exec(
      '-i', inputName,
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', 'faststart',
      outputName
    );
    try { FS.stat(outputName); outExists = true; } catch (e) { outExists = false; }
  }

  if (!outExists) {
    throw new Error('ffmpeg não gerou o arquivo de saída');
  }

  const mp4Data = FS.readFile(outputName);

  // Limpa o sistema de arquivos virtual
  try { FS.unlink(inputName); } catch (e) {}
  try { FS.unlink(outputName); } catch (e) {}

  return mp4Data;
}

function finishDownload() {
  statusEl.textContent = 'Download concluído!';
  setProgress(100);
  speedEl.textContent = '-';
  timeEl.textContent = 'Concluído';
  cancelBtn.style.display = 'none';
  closeBtn.style.display = 'block';
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---------- Event listeners ----------

cancelBtn.addEventListener('click', () => {
  cancelled = true;
  statusEl.textContent = 'Cancelando...';
  cancelBtn.style.display = 'none';
  closeBtn.style.display = 'block';
});

closeBtn.addEventListener('click', () => {
  window.close();
});

// Inicia
downloadVideo();
