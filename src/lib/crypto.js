// Criptografia ponta-a-ponta dos comandos — ver docs/protocolo.md.
// Precisa casar EXATAMENTE com o app (lib/src/secure/crypto.dart).
//
// Formato no fio (base64 padrão): nonce(12) || ciphertext || tag(16)
// Cifra: AES-256-GCM (Web Crypto). Texto em claro: JSON UTF-8.
// SEM AAD — seq/ts viajam dentro do JSON (já autenticado pelo GCM).
//
// Observação de interop: o Web Crypto ANEXA o tag ao final do ciphertext, que é
// exatamente o layout que montamos no Dart (cipherText || mac).

const _enc = new TextEncoder();
const _dec = new TextDecoder();

export async function importKey(raw32) {
  return crypto.subtle.importKey('raw', raw32, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

export function keyFromBase64url(s) {
  const b64 = s.trim().replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  return _binToBytes(atob(b64 + pad));
}

function _binToBytes(bin) {
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function _bytesToB64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

// Cifra um objeto. `nonce` opcional só para testes determinísticos.
export async function seal(key, obj, nonce) {
  const n = nonce ?? crypto.getRandomValues(new Uint8Array(12));
  const plaintext = _enc.encode(JSON.stringify(obj));
  const ctTag = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: n, tagLength: 128 }, key, plaintext),
  );
  const out = new Uint8Array(n.length + ctTag.length);
  out.set(n, 0);
  out.set(ctTag, n.length);
  return _bytesToB64(out);
}

// Decifra um envelope (base64). Lança em caso de falha de autenticação.
export async function open(key, envelopeB64) {
  const bytes = _binToBytes(atob(envelopeB64.trim()));
  if (bytes.length < 12 + 16) throw new Error('envelope_curto');
  const nonce = bytes.slice(0, 12);
  const ctTag = bytes.slice(12);
  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, key, ctTag),
  );
  return JSON.parse(_dec.decode(plaintext));
}
