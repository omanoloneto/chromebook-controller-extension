// Decisão da auto-reconexão (offscreen tica a cada 5s) — pura, testável.
// Reinicia a conexão Firebase do zero quando o cliente fica PRESO em
// 'connecting'. Nunca em 'connected' (óbvio) nem 'pairing' (mataria o
// waitForBind à toa); nunca sem rede (churn — os retries internos seguem).

export const AUTO_RECONNECT_MS = 5000;

export function deveAutoReconectar({ estado, presoMs, desdeUltimoRestartMs, online }) {
  return (
    estado === 'connecting' &&
    online !== false &&
    presoMs >= AUTO_RECONNECT_MS &&
    desdeUltimoRestartMs >= AUTO_RECONNECT_MS
  );
}
