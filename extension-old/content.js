// Script de conteúdo para detectar vídeos na página
(function() {
  'use strict';

  // Detecta vídeos em iframes
  function detectIframeVideos() {
    const iframes = document.querySelectorAll('iframe');
    const videoData = [];

    iframes.forEach(iframe => {
      try {
        // Tenta acessar o conteúdo do iframe (só funciona se for same-origin)
        const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
        
        // Procura por vídeos dentro do iframe
        const videos = iframeDoc.querySelectorAll('video');
        videos.forEach(video => {
          addVideoData(video, videoData);
        });

        // Procura por scripts que contenham URLs de vídeo
        const scripts = iframeDoc.querySelectorAll('script');
        scripts.forEach(script => {
          const content = script.textContent;
          
          // Procura por URLs .m3u8, .mp4, etc.
          const urlPatterns = [
            /https?:\/\/[^\s"']+\.m3u8[^\s"']*/gi,
            /https?:\/\/[^\s"']+\.mp4[^\s"']*/gi,
            /https?:\/\/[^\s"']+\.webm[^\s"']*/gi,
            /file:\s*['"]([^'"]+)['"]/gi
          ];

          urlPatterns.forEach(pattern => {
            const matches = content.matchAll(pattern);
            for (const match of matches) {
              const url = match[0].replace(/['"]/g, '');
              if (url && !videoData.some(v => v.url === url)) {
                videoData.push({
                  url: url,
                  type: url.includes('.m3u8') ? 'HLS Stream' : 'Video File',
                  element: false,
                  duration: null,
                  width: 0,
                  height: 0
                });
              }
            }
          });
        });
      } catch (e) {
        // Iframe de origem diferente - não conseguimos acessar
        // Mas podemos tentar detectar pela URL do iframe
        const src = iframe.src;
        if (src && (src.includes('video') || src.includes('player'))) {
          videoData.push({
            url: src,
            type: 'Iframe Player',
            element: false,
            duration: null,
            width: iframe.width || 0,
            height: iframe.height || 0
          });
        }
      }
    });

    return videoData;
  }

  // Detecta elementos de vídeo HTML5
  function detectVideoElements() {
    const videos = document.querySelectorAll('video');
    const videoData = [];

    videos.forEach(video => {
      // Aguarda o carregamento dos metadados do vídeo
      if (video.readyState >= 1) {
        addVideoData(video, videoData);
      } else {
        video.addEventListener('loadedmetadata', () => {
          const newData = [];
          addVideoData(video, newData);
          if (newData.length > 0) {
            chrome.runtime.sendMessage({
              action: 'videosDetected',
              videos: newData
            });
          }
        }, { once: true });
      }
    });

    return videoData;
  }

  // Adiciona dados do vídeo ao array
  function addVideoData(video, videoData) {
    const duration = video.duration && isFinite(video.duration) ? video.duration : null;
    
    // Só adiciona vídeos com duração razoável (> 10 segundos)
    if (duration && duration < 10) {
      return; // Provavelmente é um anúncio
    }
    
    if (video.src) {
      videoData.push({
        url: video.src,
        type: 'HTML5 Video',
        element: true,
        duration: duration,
        width: video.videoWidth || 0,
        height: video.videoHeight || 0
      });
    }

    // Verifica sources dentro do elemento video
    const sources = video.querySelectorAll('source');
    sources.forEach(source => {
      if (source.src) {
        videoData.push({
          url: source.src,
          type: 'HTML5 Video Source',
          element: true,
          duration: duration,
          width: video.videoWidth || 0,
          height: video.videoHeight || 0
        });
      }
    });
  }

  // Envia vídeos detectados para o background script
  function sendVideosToBackground() {
    const videos = detectVideoElements();
    const iframeVideos = detectIframeVideos();
    
    const allVideos = [...videos, ...iframeVideos];
    
    if (allVideos.length > 0) {
      chrome.runtime.sendMessage({
        action: 'videosDetected',
        videos: allVideos
      });
    }
  }

  // Tenta extrair o nome/título do episódio mostrado na página
  function getEpisodeTitle() {
    // Seletores comuns em sites de anime/vídeo (do mais específico ao mais genérico)
    const selectors = [
      '#anime_title',
      '.videoTitleBar h1',
      '.videoInfos h1',
      'h1[itemprop="name"]',
      'meta[itemprop="name"]',
      'h1.title',
      'h1'
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        const text = (el.content || el.textContent || '').trim();
        if (text) return text;
      }
    }

    // Tenta usar o og:title
    const og = document.querySelector('meta[property="og:title"]');
    if (og && og.content) {
      return cleanTitle(og.content);
    }

    // Fallback: título da página, removendo sufixos comuns
    return cleanTitle(document.title || '');
  }

  // Remove sufixos comuns do título (Online, FHD, HD, Grátis, etc.)
  function cleanTitle(title) {
    return title
      .replace(/\s*(Online|FHD|HD|4K|Gr[áa]tis|Assistir|Dublado|Legendado)\b.*$/i, '')
      .replace(/\s*[-|–·»].*$/, '')
      .trim() || 'video';
  }

  // Responde a pedidos do popup pelo título da página
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'getPageTitle') {
      sendResponse({ title: getEpisodeTitle() });
    }
    return true;
  });

  // Observa mudanças no DOM para detectar vídeos carregados dinamicamente
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.addedNodes.length) {
        for (const node of mutation.addedNodes) {
          if (node.nodeName === 'VIDEO' || 
              (node.querySelectorAll && node.querySelectorAll('video').length > 0)) {
            sendVideosToBackground();
            break;
          }
        }
      }
    }
  });

  // Inicia observação
  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  // Detecta vídeos iniciais
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', sendVideosToBackground);
  } else {
    sendVideosToBackground();
  }
})();
