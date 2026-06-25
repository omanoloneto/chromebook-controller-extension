// Offscreen document — orquestra descoberta + vínculo (TOFU) + conexão.
// Vive fora do service worker (que hiberna). Ver docs/protocolo.md.

import {
  IPC,
  TARGET_OFFSCREEN,
  STORAGE_KEYPAIR,
  STORAGE_BINDING,
  STORAGE_HINT,
} from '../lib/ipc.js';
import { scanForPhones, FIXED_PORT } from '../lib/discovery.js';
import { CommandClient } from '../lib/client.js';
import {
  generateKeyPair,
  exportPrivateJwk,
  importPrivateJwk,
  exportPublicRaw,
  importPublicRaw,
  pubToB64url,
  pubFromB64url,
  deriveSessionKey,
} from '../lib/keypair.js';
import { MessageType } from '../lib/protocol.js';

let identity = null; // { privKey, pubRaw, deviceId, label }
let currentClient = null;
let looping = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// O offscreen NÃO tem chrome.storage; usa o service worker como proxy.
const storeGet = async (key) =>
  (await chrome.runtime.sendMessage({ cmd: IPC.STORE_GET, key }))?.value ?? null;
const storeSet = (key, value) =>
  chrome.runtime.sendMessage({ cmd: IPC.STORE_SET, key, value });

function broadcast(state, detail, teacher) {
  if (detail) console.log('[CdA]', state, '-', detail);
  chrome.runtime
    .sendMessage({ cmd: IPC.STATE_CHANGED, state, detail: detail ?? null, teacher: teacher ?? null })
    .catch(() => {});
}

async function ensureIdentity() {
  if (identity) return identity;
  const saved = await storeGet(STORAGE_KEYPAIR);
  if (saved?.privJwk) {
    identity = {
      privKey: await importPrivateJwk(saved.privJwk),
      pubRaw: pubFromB64url(saved.pub),
      deviceId: saved.deviceId,
      label: saved.label,
    };
    return identity;
  }
  const kp = await generateKeyPair();
  const pubRaw = await exportPublicRaw(kp);
  const deviceId = crypto.randomUUID();
  const label = 'Chromebook-' + deviceId.slice(0, 4);
  await storeSet(STORAGE_KEYPAIR, {
    privJwk: await exportPrivateJwk(kp),
    pub: pubToB64url(pubRaw),
    deviceId,
    label,
  });
  identity = { privKey: kp.privateKey, pubRaw, deviceId, label };
  return identity;
}

const getBinding = async () => (await storeGet(STORAGE_BINDING)) || null;
const getHint = async () => (await storeGet(STORAGE_HINT)) || {};
async function rememberIp(ip) {
  const h = await getHint();
  h.last = ip;
  await storeSet(STORAGE_HINT, h);
}

function pickPhone(phones, binding) {
  if (!phones.length) return null;
  if (binding?.teacherPub) {
    return phones.find((p) => p.teacherPub === binding.teacherPub) || null;
  }
  return phones[0]; // TOFU: primeiro professor achado
}

async function doBind(ip, id) {
  try {
    const res = await fetch(`http://${ip}:${FIXED_PORT}/bind`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({
        devicePub: pubToB64url(id.pubRaw),
        deviceId: id.deviceId,
        label: id.label,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.ok ? data.teacherPub : null;
  } catch {
    return null;
  }
}

async function executarComando(cmd) {
  if (cmd.type === MessageType.OPEN_URL) {
    const res = await chrome.runtime
      .sendMessage({ cmd: IPC.EXEC_OPEN_URL, ...(cmd.payload ?? {}) })
      .catch((e) => ({ ok: false, error: String(e) }));
    return res ?? { ok: false, error: 'sem_resposta' };
  }
  return { ok: false, error: 'tipo_desconhecido' };
}

async function mainLoop() {
  if (looping) return;
  looping = true;
  const id = await ensureIdentity();
  console.log('[CdA] identidade pronta. deviceId=', id.deviceId);
  while (true) {
    try {
      const binding = await getBinding();
      const hint = await getHint();
      broadcast('searching', hint.manual ? `varrendo (manual ${hint.manual})…` : 'varrendo a rede…');

      const phones = await scanForPhones([hint.manual, hint.last]);
      console.log('[CdA] varredura: achei', phones.length, 'celular(es)', phones.map((p) => p.ip));
      const phone = pickPhone(phones, binding);
      if (!phone) {
        broadcast(
          'searching',
          phones.length > 0
            ? 'achei um celular, mas de outro professor (vínculo fixo)'
            : 'nenhum celular achado nas faixas comuns — informe o IP no popup',
        );
        await sleep(4000);
        continue;
      }

      if (!binding) {
        await storeSet(STORAGE_BINDING, { teacherPub: phone.teacherPub });
      }

      broadcast('searching', `vinculando a ${phone.ip}…`);
      const teacherPubKey = await importPublicRaw(pubFromB64url(phone.teacherPub));
      const sessionKey = await deriveSessionKey(id.privKey, teacherPubKey);

      const boundPub = await doBind(phone.ip, id);
      if (boundPub !== phone.teacherPub) {
        broadcast('searching', `falha no /bind com ${phone.ip}`);
        await sleep(3000);
        continue;
      }
      console.log('[CdA] bind ok com', phone.ip);
      await rememberIp(phone.ip);

      currentClient = new CommandClient({
        ip: phone.ip,
        port: FIXED_PORT,
        deviceId: id.deviceId,
        sessionKey,
        onState: (c, d) => broadcast(c ? 'connected' : 'searching', d, phone.name),
        onCommand: executarComando,
      });
      await currentClient.run();
      currentClient = null;
      broadcast('searching');
    } catch (e) {
      broadcast('searching', String(e?.message ?? e));
      await sleep(3000);
    }
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== TARGET_OFFSCREEN) return false;
  (async () => {
    if (msg.cmd === IPC.OFF_RESTART) {
      currentClient?.stop(); // faz o run() retornar -> o loop redescobre
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, error: 'cmd_desconhecido' });
    }
  })();
  return true;
});

mainLoop();
