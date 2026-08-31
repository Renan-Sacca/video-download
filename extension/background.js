// Service worker (Manifest V3) responsavel por:
// - acompanhar o progresso de jobs de download mesmo que o popup seja
//   fechado pelo usuario;
// - disparar chrome.downloads.download() quando o job terminar.
//
// A extensao usa fetch simples (sem bibliotecas) para falar com a API.
// Cada chamada de rede reinicia o "idle timer" do service worker, o que e
// suficiente para acompanhar downloads de duracao tipica (segundos a poucos
// minutos). Ver README para detalhes/limitacoes desse modelo em MV3.

importScripts("config.js");

const jobs = new Map(); // job_id -> { status, progress, error, downloadUrl, filename }

function apiHeaders() {
  return {
    "Content-Type": "application/json",
    "X-API-Key": globalThis.VIDEODL_CONFIG.API_KEY,
  };
}

function broadcastUpdate(jobId) {
  const state = jobs.get(jobId);
  if (!state) return;
  chrome.runtime
    .sendMessage({ type: "JOB_UPDATE", jobId, ...state })
    .catch(() => {
      // Nenhum popup aberto para receber a mensagem; sem problema, o estado
      // continua disponivel via GET_JOB_STATE quando o popup for reaberto.
    });
}

async function pollJob(jobId) {
  const { API_BASE_URL, POLL_INTERVAL_MS } = globalThis.VIDEODL_CONFIG;

  try {
    const res = await fetch(`${API_BASE_URL}/api/download/${jobId}`, {
      method: "GET",
      headers: apiHeaders(),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      jobs.set(jobId, {
        status: "error",
        progress: 0,
        error: body.detail || `Erro HTTP ${res.status}`,
      });
      broadcastUpdate(jobId);
      return;
    }

    const data = await res.json();
    jobs.set(jobId, {
      status: data.status,
      progress: data.progress || 0,
      error: data.error || null,
      downloadUrl: data.download_url || null,
      filename: data.filename || null,
    });
    broadcastUpdate(jobId);

    if (data.status === "finished" && data.download_url) {
      triggerBrowserDownload(API_BASE_URL + data.download_url, data.filename);
      return;
    }

    if (data.status === "error") {
      return;
    }

    setTimeout(() => pollJob(jobId), POLL_INTERVAL_MS);
  } catch (err) {
    jobs.set(jobId, {
      status: "error",
      progress: 0,
      error: err && err.message ? err.message : "Falha de rede ao consultar o job.",
    });
    broadcastUpdate(jobId);
  }
}

function triggerBrowserDownload(fileUrl, filename) {
  chrome.downloads.download(
    {
      url: fileUrl,
      filename: filename || undefined,
      saveAs: false,
    },
    () => {
      if (chrome.runtime.lastError) {
        const jobEntries = [...jobs.entries()];
        const [jobId] = jobEntries[jobEntries.length - 1] || [];
        if (jobId) {
          jobs.set(jobId, {
            ...jobs.get(jobId),
            status: "error",
            error: chrome.runtime.lastError.message,
          });
          broadcastUpdate(jobId);
        }
      }
    }
  );
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "TRACK_JOB") {
    jobs.set(message.jobId, { status: "queued", progress: 0 });
    pollJob(message.jobId);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "GET_JOB_STATE") {
    const state = jobs.get(message.jobId) || null;
    sendResponse({ ok: true, state });
    return true;
  }

  return false;
});
