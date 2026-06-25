// Parser do QR mostrado pelo celular — ver docs/protocolo.md (QR v2).
// Casa com o app (lib/src/pairing/pairing_payload.dart): base64url( JSON ).
//
// { v: 2, ip, port, key(base64url 32 bytes), name }

export const PAIRING_VERSION = 2;

function b64urlToString(s) {
  const b64 = s.trim().replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  return new TextDecoder().decode(
    Uint8Array.from(atob(b64 + pad), (c) => c.charCodeAt(0)),
  );
}

// Lê e valida o QR. Lança Error com código curto se inválido.
export function parsePairingQr(text) {
  let obj;
  try {
    obj = JSON.parse(b64urlToString(text));
  } catch {
    throw new Error('qr_ilegivel');
  }
  if (obj.v !== PAIRING_VERSION) throw new Error('versao_incompativel');
  if (typeof obj.ip !== 'string' || !obj.ip) throw new Error('ip_ausente');
  if (typeof obj.port !== 'number') throw new Error('porta_ausente');
  if (typeof obj.key !== 'string' || obj.key.length < 40) {
    throw new Error('chave_ausente');
  }
  return {
    ip: obj.ip,
    port: obj.port,
    key: obj.key, // base64url; convertida em bytes pelo crypto.js
    name: typeof obj.name === 'string' ? obj.name : 'Celular',
  };
}
