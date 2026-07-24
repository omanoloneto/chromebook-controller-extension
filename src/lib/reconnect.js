// Decisão da auto-reconexão (offscreen tica a cada 5s) — pura, testável.
// Reinicia a conexão Firebase do zero quando o cliente fica PRESO em
// 'connecting'. Nunca em 'connected' (óbvio) nem 'pairing' (mataria o
// waitForBind à toa).
//
// NÃO gateia mais em navigator.onLine: dentro do offscreen esse flag fica
// PRESO em false (não recebe os eventos online/offline direito) e travava a
// reconexão pra sempre — era a causa do "conectando… e não volta". Sem rede,
// reiniciar só refaz o signIn que falha rápido e reagenda; sem churn danoso.

export const AUTO_RECONNECT_MS = 5000;

export function deveAutoReconectar({ estado, presoMs, desdeUltimoRestartMs }) {
  return (
    estado === 'connecting' &&
    presoMs >= AUTO_RECONNECT_MS &&
    desdeUltimoRestartMs >= AUTO_RECONNECT_MS
  );
}
