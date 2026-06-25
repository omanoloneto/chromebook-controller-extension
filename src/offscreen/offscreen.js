// Offscreen document — hospeda o cliente de long-poll (CommandClient).
// Roda fora do service worker porque o loop de fetch precisa de um documento
// que não hiberna (o SW hiberna após ~30s ocioso).

import { IPC, TARGET_OFFSCREEN, STORAGE_KEY } from '../lib/ipc.js';
import { CommandClient } from '../lib/client.js';
import { MessageType } from '../lib/protocol.js';

let client = null;

function broadcastState(connected, detail) {
  chrome.runtime
    .sendMessage({
      cmd: IPC.STATE_CHANGED,
      state: connected ? 'connected' : 'disconnected',
      detail: detail ?? null,
    })
    .catch(() => {});
}

// Executa um comando recebido do celular. open_url vai para o service worker
// (só ele tem chrome.tabs). Retorna o resultado para virar ACK.
async function executarComando(cmd) {
  if (cmd.type === MessageType.OPEN_URL) {
    const res = await chrome.runtime
      .sendMessage({ cmd: IPC.EXEC_OPEN_URL, ...(cmd.payload ?? {}) })
      .catch((e) => ({ ok: false, error: String(e) }));
    return res ?? { ok: false, error: 'sem_resposta' };
  }
  return { ok: false, error: 'tipo_desconhecido' };
}

async function startClient() {
  const data = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  if (!data?.ip || !data?.port || !data?.key) {
    console.warn('[CdA] offscreen: sem pareamento no storage ainda.');
    return;
  }
  console.log('[CdA] offscreen: iniciando cliente para', `${data.ip}:${data.port}`);
  client?.stop();
  client = new CommandClient({
    ip: data.ip,
    port: data.port,
    keyB64: data.key,
    onState: broadcastState,
    onCommand: executarComando,
  });
  await client.start();
}

function stopClient() {
  client?.stop();
  client = null;
  broadcastState(false);
}

// Mensagens vindas do service worker.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== TARGET_OFFSCREEN) return false;
  (async () => {
    try {
      if (msg.cmd === IPC.OFF_START_CLIENT) {
        await startClient();
        sendResponse({ ok: true });
      } else if (msg.cmd === IPC.OFF_STOP_CLIENT) {
        stopClient();
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: 'cmd_desconhecido' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message ?? e) });
    }
  })();
  return true;
});

// Ao ser (re)criado pelo service worker, tenta reconectar do storage sozinho.
startClient();
