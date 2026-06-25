// Handshake de chaves (TOFU) — ver docs/protocolo.md.
// X25519 (ECDH) + HKDF-SHA256 -> chave de sessão de 32 bytes para o AES-256-GCM.
// Precisa casar EXATAMENTE com o app (lib/src/secure/keypair.dart).

const SALT = new TextEncoder().encode('controle-de-aula');
const INFO = new TextEncoder().encode('session-key-v3');

function bytesToB64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function pubToB64url(bytes) {
  return bytesToB64url(bytes);
}

export function pubFromB64url(s) {
  const b64 = s.trim().replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  return Uint8Array.from(atob(b64 + pad), (c) => c.charCodeAt(0));
}

export async function generateKeyPair() {
  return crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
}

export async function exportPublicRaw(keyPair) {
  return new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
}

export async function exportPrivateJwk(keyPair) {
  return crypto.subtle.exportKey('jwk', keyPair.privateKey);
}

export async function importPrivateJwk(jwk) {
  return crypto.subtle.importKey('jwk', jwk, { name: 'X25519' }, true, ['deriveBits']);
}

export async function importPublicRaw(bytes) {
  return crypto.subtle.importKey('raw', bytes, { name: 'X25519' }, true, []);
}

// Deriva a chave de sessão AES (32 bytes) com a pubkey (CryptoKey) do par remoto.
export async function deriveSessionKey(privateKey, peerPublicKey) {
  const bits = await crypto.subtle.deriveBits(
    { name: 'X25519', public: peerPublicKey },
    privateKey,
    256,
  );
  const ikm = await crypto.subtle.importKey('raw', new Uint8Array(bits), 'HKDF', false, [
    'deriveBits',
  ]);
  const out = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: SALT, info: INFO },
    ikm,
    256,
  );
  return new Uint8Array(out);
}
