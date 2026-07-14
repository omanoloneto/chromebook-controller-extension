// Visão da turma (telão) — renderiza o snapshot que o APP empurra cifrado
// para state/classview (ver docs/protocolo.md, set_class_view). A página é
// "burra": não fala com o Firebase; só lê o storage e re-renderiza.

import { STORAGE_CLASSVIEW } from '../lib/ipc.js';

// O app re-empurra a cada 60s (heartbeat); sem nada em 90s = app sumiu.
const STALE_MS = 90000;
// rev é epoch-ms do celular: snapshot re-hidratado com rev muito antigo é
// dado velho mesmo que o recebidoEm (relógio local) seja fresco.
const REV_VELHO_MS = 10 * 60000;

const el = {
  titulo: document.getElementById('titulo'),
  resumo: document.getElementById('resumo'),
  atualizado: document.getElementById('atualizado'),
  banner: document.getElementById('banner-stale'),
  lista: document.getElementById('lista'),
  vazio: document.getElementById('vazio'),
};

let snapshot = null;

function mostrarVazio(msg) {
  el.lista.replaceChildren();
  el.vazio.textContent = msg;
  el.vazio.hidden = false;
}

function itemPc(pc) {
  const li = document.createElement('li');
  li.className = `pc ${pc.online ? 'online' : 'offline'}${pc.alerta ? ' com-alerta' : ''}`;

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = pc.alerta ? '⚠' : '💻';

  const info = document.createElement('div');
  info.className = 'info';

  const nome = document.createElement('div');
  nome.className = 'nome';
  if (pc.aluno) {
    nome.textContent = pc.aluno;
    const label = document.createElement('span');
    label.className = 'pc-label';
    label.textContent = ` — ${pc.nome}`;
    nome.appendChild(label);
  } else {
    nome.textContent = pc.nome;
  }

  const aba = document.createElement('div');
  aba.className = 'aba';
  if (pc.aba) {
    aba.textContent = pc.aba.titulo ? `${pc.aba.titulo} · ` : '';
    const dom = document.createElement('span');
    dom.className = 'dominio';
    dom.textContent = pc.aba.dominio;
    aba.appendChild(dom);
  } else {
    aba.textContent = pc.online ? 'Sem aba aberta' : 'Offline';
  }

  info.append(nome, aba);
  li.append(avatar, info);

  if (pc.alerta) {
    const badge = document.createElement('span');
    badge.className = 'badge-alerta';
    badge.textContent = `⚠ ${pc.alerta}`;
    li.appendChild(badge);
  }

  const dot = document.createElement('span');
  dot.className = 'dot';
  li.appendChild(dot);
  return li;
}

function render() {
  if (!snapshot) {
    el.titulo.textContent = 'Visão da turma';
    el.resumo.textContent = '';
    el.atualizado.textContent = '';
    el.banner.hidden = true;
    document.body.classList.remove('stale');
    mostrarVazio(
      'Este PC não está marcado como PC do professor.\n' +
        'No app, toque no menu do PC e escolha "Usar como PC do professor".',
    );
    return;
  }

  const emAula = snapshot.aula?.ativa === true;
  el.titulo.textContent = emAula
    ? `Aula: ${snapshot.aula.turma ?? ''}`.trim()
    : 'Fora de aula';

  const pcs = snapshot.pcs ?? [];
  const online = pcs.filter((p) => p.online).length;
  el.resumo.textContent = emAula
    ? `${online} online / ${pcs.length} PC(s) vinculados`
    : `${online} online / ${pcs.length} PC(s) pareados`;

  if (pcs.length === 0) {
    mostrarVazio(emAula ? 'Nenhum aluno vinculado a um PC ainda.' : 'Nenhum PC pareado.');
  } else {
    el.vazio.hidden = true;
    el.lista.replaceChildren(...pcs.map(itemPc));
  }
  tick();
}

// Atualiza o "há Xs" e o banner de staleness (1x/s, barato).
function tick() {
  if (!snapshot) return;
  const idade = Date.now() - (snapshot.recebidoEm ?? 0);
  const revVelho = Date.now() - (snapshot.rev ?? 0) > REV_VELHO_MS;
  const stale = idade > STALE_MS || revVelho;
  el.banner.hidden = !stale;
  document.body.classList.toggle('stale', stale);
  el.atualizado.textContent = revVelho
    ? 'dados antigos'
    : idade < 5000
      ? 'agora'
      : `há ${Math.round(idade / 1000)}s`;
}

async function carregar() {
  const o = await chrome.storage.local.get(STORAGE_CLASSVIEW).catch(() => ({}));
  snapshot = o[STORAGE_CLASSVIEW] ?? null;
  render();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && STORAGE_CLASSVIEW in changes) {
    snapshot = changes[STORAGE_CLASSVIEW].newValue ?? null;
    render();
  }
});

setInterval(tick, 1000);
carregar();
