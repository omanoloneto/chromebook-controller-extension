// Sinalização: codificação do conteúdo dos QR codes (ver docs/protocolo.md).
//
// v1: payload = base64url( JSON ). SEM compressão, para garantir que a extensão
// (JS) e o app (Dart) produzam/leiam exatamente o mesmo formato.
//
// Forma do objeto antes de codificar:
//   { v: 1, role: 'offer' | 'answer', sdp: '<sdp>', name: '<nome do aparelho>' }

export const SIGNAL_VERSION = 1;

function bytesToB64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/// Codifica um objeto de sinalização para o texto que vai dentro do QR.
export function encodeSignal(obj) {
  const json = JSON.stringify(obj);
  return bytesToB64url(new TextEncoder().encode(json));
}

/// Decodifica o texto lido de um QR de volta para o objeto de sinalização.
export function decodeSignal(text) {
  const json = new TextDecoder().decode(b64urlToBytes(text.trim()));
  return JSON.parse(json);
}

/// Monta o payload do offer (lado Chromebook).
export function makeOfferSignal(sdp, name) {
  return encodeSignal({ v: SIGNAL_VERSION, role: 'offer', sdp, name });
}

/// Monta o payload do answer (lado celular). (Usado pelo app; aqui por simetria.)
export function makeAnswerSignal(sdp, name) {
  return encodeSignal({ v: SIGNAL_VERSION, role: 'answer', sdp, name });
}
