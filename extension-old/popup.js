document.addEventListener('DOMContentLoaded', async () => {
  const loading = document.getElementById('loading');
  const noVideos = document.getElementById('no-videos');
  const videosList = document.getElementById('videos-list');
  const footer = document.getElementById('footer');
  const clearBtn = document.getElementById('clear-btn');
  const refreshBtn = document.getElementById('refresh-btn');

  let currentTabId = null;
  let pageTitle = null;

  // Obtém a aba atual
  async function getCurrentTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  // Pede ao content script o título do episódio na página
  function fetchPageTitle(tabId) {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { action: 'getPageTitle' }, (response) => {
        if (chrome.runtime.lastError || !response) {
          resolve(null);
        } else {
          resolve(response.title);
        }
      });
    });
  }

  // Transforma um título em nome de arquivo seguro
  function sanitizeFilename(name) {
    if (!name) return null;
    return name
      .replace(/[<>:"/\\|?*]+/g, '')   // caracteres inválidos no Windows
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 150);
  }

  // Carrega os vídeos detectados
  async function loadVideos() {
    loading.style.display = 'flex';
    noVideos.style.display = 'none';
    videosList.style.display = 'none';
    footer.style.display = 'none';

    const tab = await getCurrentTab();
    currentTabId = tab.id;

    // Captura o título do episódio da página
    pageTitle = sanitizeFilename(await fetchPageTitle(currentTabId));

    chrome.runtime.sendMessage(
      { action: 'getVideos', tabId: currentTabId },
      (response) => {
        loading.style.display = 'none';

        if (response.videos && response.videos.length > 0) {
          displayVideos(response.videos);
          videosList.style.display = 'block';
          footer.style.display = 'flex';
        } else {
          noVideos.style.display = 'flex';
        }
      }
    );
  }

  // Padrões específicos de anúncio (com word boundary, evita falso positivo
  // em URLs com base64/palavras como "download", "adventure", etc.)
  const adUrlPatterns = [
    /[/?&._-](ads?|advert(s|ising)?)[/?&._-]/i,
    /\bbanner\b/i,
    /\bthumb(nail)?\b/i,
    /\bpixel\b/i,
    /\bvast\b/i,
    /\bvpaid\b/i
  ];

  function looksLikeAd(url) {
    return adUrlPatterns.some(p => p.test(url));
  }

  // Exibe os vídeos na lista
  function displayVideos(videos) {
    videosList.innerHTML = '';

    // Filtra e ordena vídeos
    const filteredVideos = videos
      .filter(v => {
        // Remove vídeos muito pequenos (provavelmente anúncios curtos),
        // mas mantém os de tamanho desconhecido (streams HLS, por exemplo)
        if (v.size && v.size < 300000) return false;

        if (looksLikeAd(v.url)) return false;

        return true;
      })
      .sort((a, b) => {
        // Prioriza vídeos com duração conhecida
        if (a.duration && !b.duration) return -1;
        if (!a.duration && b.duration) return 1;
        
        // Depois por tamanho
        if (a.size && b.size) return b.size - a.size;
        if (a.size) return -1;
        if (b.size) return 1;
        
        return 0;
      });

    if (filteredVideos.length === 0) {
      noVideos.style.display = 'flex';
      videosList.style.display = 'none';
      footer.style.display = 'none';
      return;
    }

    filteredVideos.forEach((video, index) => {
      const videoItem = createVideoItem(video, index);
      videosList.appendChild(videoItem);
    });
  }

  // Cria um item de vídeo
  function createVideoItem(video, index) {
    const item = document.createElement('div');
    item.className = 'video-item';

    const isHLS = video.url.includes('.m3u8');
    const isMPD = video.url.includes('.mpd');

    // Define o nome do arquivo: prefere o título do episódio da página
    const urlFilename = getFilenameFromUrl(video.url);
    let filename = urlFilename;
    if (pageTitle) {
      // Define extensão apropriada
      let ext = 'mp4';
      if (!isHLS && !isMPD) {
        const m = urlFilename.match(/\.([a-z0-9]{2,4})$/i);
        if (m) ext = m[1];
      }
      filename = `${pageTitle}.${ext}`;
    }

    const size = formatSize(video.size);
    const duration = formatDuration(video.duration);

    // Cria a lista de metadados
    let metaItems = [];
    
    // Adiciona indicador de vídeo principal
    if (index === 0 && (video.size > 1000000 || video.duration > 60)) {
      metaItems.push(`<span style="color: #4CAF50; font-weight: bold;">⭐ VÍDEO PRINCIPAL</span>`);
    }
    
    // Indica tipo de stream
    if (isHLS) {
      metaItems.push(`<span style="color: #FF9800; font-weight: bold;">📡 HLS Stream</span>`);
    } else if (isMPD) {
      metaItems.push(`<span style="color: #FF9800; font-weight: bold;">📡 DASH Stream</span>`);
    }
    
    metaItems.push(`📁 ${filename}`);
    
    if (duration !== 'Desconhecido') {
      metaItems.push(`⏱️ ${duration}`);
    }
    
    if (size !== 'Desconhecido') {
      metaItems.push(`📊 ${size}`);
    }

    if (video.loading) {
      metaItems.push(`<span class="loading-text">⏳ Carregando...</span>`);
    }

    // Botões diferentes para HLS/DASH
    const downloadButton = (isHLS || isMPD) ? `
      <button class="btn btn-download btn-stream" data-url="${video.url}" data-filename="${filename}">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="7 10 12 15 17 10"></polyline>
          <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
        Baixar Stream
      </button>
    ` : `
      <button class="btn btn-download" data-url="${video.url}" data-filename="${filename}">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="7 10 12 15 17 10"></polyline>
          <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
        Baixar
      </button>
    `;

    item.innerHTML = `
      <div class="video-info">
        <div class="video-url" title="${video.url}">${video.url}</div>
        <div class="video-meta">
          ${metaItems.map(item => `<span>${item}</span>`).join('')}
        </div>
      </div>
      <div class="video-actions">
        ${downloadButton}
        <button class="btn btn-copy" data-url="${video.url}">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
          Copiar
        </button>
      </div>
    `;

    // Adiciona event listeners
    const downloadBtn = item.querySelector('.btn-download');
    const copyBtn = item.querySelector('.btn-copy');

    downloadBtn.addEventListener('click', () => downloadVideo(video.url, filename));
    copyBtn.addEventListener('click', (e) => copyUrl(video.url, e.target.closest('.btn-copy')));

    return item;
  }

  // Baixa o vídeo
  function downloadVideo(url, filename) {
    const isHLS = url.includes('.m3u8');
    const isMPD = url.includes('.mpd');

    if (isHLS || isMPD) {
      // Abre página de download HLS
      const downloadUrl = chrome.runtime.getURL('hls-downloader.html') + 
                         `?url=${encodeURIComponent(url)}&filename=${encodeURIComponent(filename)}`;
      chrome.tabs.create({ url: downloadUrl });
    } else {
      // Download normal
      chrome.runtime.sendMessage(
        { action: 'downloadVideo', url: url, filename: filename },
        (response) => {
          if (response.success) {
            showNotification('Download iniciado!', 'success');
          } else {
            showNotification('Erro ao baixar: ' + response.error, 'error');
          }
        }
      );
    }
  }

  // Copia a URL para a área de transferência
  async function copyUrl(url, button) {
    try {
      await navigator.clipboard.writeText(url);
      const originalText = button.innerHTML;
      button.innerHTML = '✓ Copiado!';
      button.classList.add('copied');
      
      setTimeout(() => {
        button.innerHTML = originalText;
        button.classList.remove('copied');
      }, 2000);
    } catch (err) {
      showNotification('Erro ao copiar URL', 'error');
    }
  }

  // Limpa a lista de vídeos
  function clearVideos() {
    chrome.runtime.sendMessage(
      { action: 'clearVideos', tabId: currentTabId },
      () => {
        loadVideos();
      }
    );
  }

  // Mostra notificação
  function showNotification(message, type) {
    // Implementação simples - pode ser melhorada
    console.log(`[${type}] ${message}`);
  }

  // Extrai nome do arquivo da URL
  function getFilenameFromUrl(url) {
    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      const filename = pathname.substring(pathname.lastIndexOf('/') + 1);
      return filename || 'video.mp4';
    } catch (e) {
      return 'video.mp4';
    }
  }

  // Formata o tamanho do arquivo
  function formatSize(bytes) {
    if (bytes === 'Desconhecido' || !bytes) return 'Desconhecido';
    
    const size = parseInt(bytes);
    if (isNaN(size)) return 'Desconhecido';

    const units = ['B', 'KB', 'MB', 'GB'];
    let unitIndex = 0;
    let fileSize = size;

    while (fileSize >= 1024 && unitIndex < units.length - 1) {
      fileSize /= 1024;
      unitIndex++;
    }

    return `${fileSize.toFixed(2)} ${units[unitIndex]}`;
  }

  // Formata a duração do vídeo
  function formatDuration(seconds) {
    if (!seconds || isNaN(seconds) || !isFinite(seconds)) return 'Desconhecido';
    
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}h ${minutes}m ${secs}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    } else {
      return `${secs}s`;
    }
  }

  // Seção de URL manual (fallback para sites não detectados automaticamente)
  const manualToggle = document.getElementById('manual-toggle');
  const manualForm = document.getElementById('manual-form');
  const manualUrlInput = document.getElementById('manual-url');
  const manualDownloadBtn = document.getElementById('manual-download-btn');

  manualToggle.addEventListener('click', () => {
    manualForm.style.display = manualForm.style.display === 'none' ? 'block' : 'none';
  });

  manualDownloadBtn.addEventListener('click', () => {
    const url = manualUrlInput.value.trim();
    if (!url) return;

    let ext = 'mp4';
    if (!url.includes('.m3u8') && !url.includes('.mpd')) {
      const m = getFilenameFromUrl(url).match(/\.([a-z0-9]{2,4})$/i);
      if (m) ext = m[1];
    }
    const name = pageTitle ? `${pageTitle}.${ext}` : getFilenameFromUrl(url);

    downloadVideo(url, name);
  });

  // Event listeners
  clearBtn.addEventListener('click', clearVideos);
  refreshBtn.addEventListener('click', loadVideos);

  // Carrega os vídeos ao abrir o popup
  loadVideos();
});
