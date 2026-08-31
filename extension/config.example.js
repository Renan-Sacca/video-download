// Configuracao da extensao.
//
// Copie este arquivo para "config.js" e ajuste os valores:
//   cp config.example.js config.js
//
// Altere API_BASE_URL para o dominio publico da sua API (o mesmo configurado
// em API_DOMAIN / PUBLIC_BASE_URL no .env do backend, atras do Traefik).
// Altere API_KEY para a mesma chave configurada em API_KEY no .env do backend.
//
// Este arquivo e carregado antes de popup.js (via <script> em popup.html) e
// antes de background.js (via importScripts no service worker), entao os
// valores abaixo ficam disponiveis como `globalThis.VIDEODL_CONFIG` nos dois
// contextos (no popup, `globalThis` == `window`; no service worker, `window`
// nao existe, apenas `self`/`globalThis`).
globalThis.VIDEODL_CONFIG = {
  API_BASE_URL: "https://ytdl.exemplo.com",
  API_KEY: "troque-esta-chave-por-uma-aleatoria-e-forte",

  // Intervalo (ms) entre verificacoes de status do job de download.
  POLL_INTERVAL_MS: 1500,
};
