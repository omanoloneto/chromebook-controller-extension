// Descoberta do celular do professor na LAN — ver docs/protocolo.md.
// A extensão NÃO sabe a própria sub-rede (MV3), então varre faixas privadas
// comuns na porta fixa, procurando o banner do servidor (GET /).

export const FIXED_PORT = 47615;

const COMMON_PREFIXES = [
  '192.168.0',
  '192.168.1',
  '192.168.2',
  '192.168.3',
  '10.0.0',
  '10.0.1',
  '172.16.0',
];
const PROBE_TIMEOUT_MS = 600;
const BATCH = 40;

function prefixOf(ip) {
  const parts = String(ip).split('.');
  return parts.length === 4 ? parts.slice(0, 3).join('.') : null;
}

async function probe(ip) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    const res = await fetch(`http://${ip}:${FIXED_PORT}/`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.app !== 'controle-de-aula') return null;
    return { ip, teacherPub: data.teacherPub, name: data.name, v: data.v };
  } catch {
    return null;
  }
}

// Varre IPs candidatos. `hintIps` (último IP / IP manual) são testados primeiro.
// Para na primeira leva que achar algum servidor (descoberta rápida).
export async function scanForPhones(hintIps = []) {
  const ips = [];
  const prefixes = [...COMMON_PREFIXES];
  // IPs informados primeiro (descoberta instantânea) + o /24 deles.
  for (const h of hintIps) {
    if (!h) continue;
    ips.push(h);
    const pref = prefixOf(h);
    if (pref && !prefixes.includes(pref)) prefixes.unshift(pref);
  }
  for (const p of prefixes) {
    for (let i = 1; i <= 254; i++) ips.push(`${p}.${i}`);
  }

  const found = [];
  for (let i = 0; i < ips.length; i += BATCH) {
    const results = await Promise.all(ips.slice(i, i + BATCH).map(probe));
    for (const r of results) if (r) found.push(r);
    if (found.length > 0) break;
  }
  return found;
}
