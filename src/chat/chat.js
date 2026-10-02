// Janela de chat do aluno (ChromeOS). É só uma vista: o histórico vive no
// service worker (chrome.storage.session `chat`) e todo envio passa por ele
// (rate-limit, fila `up`). Texto vindo da rede só por textContent.

import { IPC, SESSAO_CHAT, STORAGE_TRAVA } from '../lib/ipc.js';
import { monograma, novoId } from '../lib/up.js';

const AVISO_MS = 4000; // aviso de limite no rodapé
const ENVIO_PRESO_MS = 30000; // "Enviando…" que não terminou (SW reiniciou)
const PERTO_DO_FIM_PX = 48;
const GRUPO_MS = 5 * 60 * 1000;

const TEXTO = Object.freeze({
  semConexao: 'Sem conexão agora — tente daqui a pouco.',
  travada: 'A tela está travada pelo professor.',
  falhaEnvio: 'Não foi possível enviar agora. Tente de novo.',
  maoLevantar: '✋ Levantar a mão',
  maoLevantada: 'Mão levantada ✋',
  enviando: 'Enviando…',
  naoEnviada: 'Não enviada · Tentar de novo',
});

const el = (id) => document.getElementById(id);
const ui = {
  avatar: el('avatar'),
  nome: el('nome'),
  corpo: el('corpo'),
  lista: el('lista'),
  vazio: el('vazio'),
  aviso: el('aviso'),
  form: el('form'),
  texto: el('texto'),
  btnEnviar: el('btn-enviar'),
  btnMao: el('btn-mao'),
  btnMinimizar: el('btn-minimizar'),
  btnFechar: el('btn-fechar'),
};

let chat = { de: null, itens: [], naoLidas: 0, maoAte: 0 };
let professor = null; // binding.teacherName
let conectado = null; // null = ainda não sabido (trata como conectado)
let trava = null;
let aviso = null; // {texto, ate}
let timerAviso = null;
let timerMao = null;
let timerTrava = null;
let timerPreso = null;
let primeiraVez = true;

const enviar = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);

const horaMin = (ts) =>
  new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

const travada = () =>
  !!trava && trava.on === true && typeof trava.prazo === 'number' && Date.now() < trava.prazo;

const envioPreso = (i) => i.estado === 'enviando' && Date.now() - (i.desde ?? i.ts ?? 0) > ENVIO_PRESO_MS;

// ---- Cabeçalho ----

function nomeExibido() {
  return chat.de || professor || 'Professor';
}

function renderCabecalho() {
  const nome = nomeExibido();
  ui.nome.textContent = nome;
  ui.avatar.textContent = monograma(nome);
  const n = chat.naoLidas ?? 0;
  document.title = n > 0 ? `(${n}) ${nome}` : nome;
}

// ---- Conversa ----

function svgRelogio() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('class', 'relogio');
  svg.setAttribute('aria-hidden', 'true');
  const c = document.createElementNS(ns, 'circle');
  c.setAttribute('cx', '6');
  c.setAttribute('cy', '6');
  c.setAttribute('r', '4.8');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', 'M6 3.4V6l1.8 1.1');
  svg.append(c, p);
  return svg;
}

function metaDoAluno(item, meta) {
  if (item.estado === 'falhou' || envioPreso(item)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tentar';
    b.textContent = TEXTO.naoEnviada;
    b.addEventListener('click', () => reenviar(item.id, b));
    meta.append(b);
    return 'falhou';
  }
  if (item.estado === 'enviando') {
    const s = document.createElement('span');
    s.textContent = TEXTO.enviando;
    meta.append(svgRelogio(), s);
    return 'enviando';
  }
  if (item.estado === 'enviada') {
    const s = document.createElement('span');
    s.className = 'enviada';
    s.textContent = '✓';
    s.title = 'Enviada';
    meta.append(s);
  }
  return null;
}

function renderLista() {
  const pertoDoFim =
    ui.corpo.scrollHeight - ui.corpo.scrollTop - ui.corpo.clientHeight < PERTO_DO_FIM_PX;
  const itens = Array.isArray(chat.itens) ? chat.itens : [];
  const frag = document.createDocumentFragment();
  let anterior = null;
  let algumPreso = false;
  for (const item of itens) {
    const li = document.createElement('li');
    if (item.autor === 'sistema') {
      li.className = 'sistema';
      li.textContent = item.texto;
      frag.append(li);
      anterior = item;
      continue;
    }
    const autor = item.autor === 'aluno' ? 'aluno' : 'professor';
    li.className = `item ${autor}`;
    const novoGrupo = !anterior || anterior.autor !== item.autor || (item.ts ?? 0) - (anterior.ts ?? 0) > GRUPO_MS;
    if (novoGrupo) li.classList.add('novo-grupo');
    const balao = document.createElement('p');
    balao.className = 'balao';
    balao.textContent = item.texto;
    const meta = document.createElement('div');
    meta.className = 'meta';
    const hora = document.createElement('time');
    hora.textContent = horaMin(item.ts);
    meta.append(hora);
    if (autor === 'aluno') {
      const estado = metaDoAluno(item, meta);
      if (estado === 'falhou') li.classList.add('falhou');
      if (estado === 'enviando') algumPreso = true;
    }
    li.append(balao, meta);
    frag.append(li);
    anterior = item;
  }
  ui.lista.replaceChildren(frag);
  ui.vazio.hidden = itens.length > 0;
  if (primeiraVez || pertoDoFim) ui.corpo.scrollTop = ui.corpo.scrollHeight;
  primeiraVez = false;
  // Um "Enviando…" vira "Tentar de novo" se o envio não terminar.
  clearTimeout(timerPreso);
  if (algumPreso) timerPreso = setTimeout(renderLista, ENVIO_PRESO_MS / 3);
}

// ---- Rodapé ----

function renderRodape() {
  const agora = Date.now();
  const bloqueado = travada() || conectado === false;
  ui.texto.disabled = bloqueado;
  ui.btnEnviar.disabled = bloqueado || !ui.texto.value.trim();

  let texto = null;
  if (travada()) texto = TEXTO.travada;
  else if (conectado === false) texto = TEXTO.semConexao;
  else if (aviso && agora < aviso.ate) texto = aviso.texto;
  ui.aviso.textContent = texto ?? '';
  ui.aviso.hidden = !texto;

  const levantada = agora < (chat.maoAte ?? 0);
  ui.btnMao.textContent = levantada ? TEXTO.maoLevantada : TEXTO.maoLevantar;
  ui.btnMao.classList.toggle('levantada', levantada);
  ui.btnMao.disabled = levantada || bloqueado;
  clearTimeout(timerMao);
  if (levantada) timerMao = setTimeout(renderRodape, chat.maoAte - agora + 50);
}

function mostrarAviso(texto) {
  aviso = { texto, ate: Date.now() + AVISO_MS };
  clearTimeout(timerAviso);
  timerAviso = setTimeout(() => {
    aviso = null;
    renderRodape();
  }, AVISO_MS);
  renderRodape();
}

function agendarTrava() {
  clearTimeout(timerTrava);
  if (travada()) timerTrava = setTimeout(render, trava.prazo - Date.now() + 50);
}

function render() {
  renderCabecalho();
  renderLista();
  renderRodape();
  agendarTrava();
}

// ---- Ações ----

ui.texto.addEventListener('input', renderRodape);

ui.form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const texto = ui.texto.value.trim();
  if (!texto || ui.texto.disabled) return;
  ui.texto.value = '';
  renderRodape();
  ui.corpo.scrollTop = ui.corpo.scrollHeight;
  const r = await enviar({ cmd: IPC.CHAT_ENVIAR, id: novoId(), texto });
  if (!r || r.anexada === false) {
    // Não entrou na conversa (limite ou SW fora): o texto volta ao campo.
    if (!ui.texto.value) ui.texto.value = texto;
    renderRodape();
  }
  if (r?.aviso) mostrarAviso(r.aviso);
  else if (!r) mostrarAviso(TEXTO.falhaEnvio);
});

async function reenviar(id, botao) {
  botao.disabled = true;
  const r = await enviar({ cmd: IPC.CHAT_REENVIAR, id });
  if (r?.aviso) mostrarAviso(r.aviso);
  if (!r?.ok) botao.disabled = false;
}

ui.btnMao.addEventListener('click', async () => {
  ui.btnMao.disabled = true;
  const r = await enviar({ cmd: IPC.CHAT_MAO });
  if (typeof r?.maoAte === 'number' && r.maoAte > (chat.maoAte ?? 0)) chat.maoAte = r.maoAte;
  if (r?.aviso) mostrarAviso(r.aviso);
  else if (!r) mostrarAviso(TEXTO.falhaEnvio);
  renderRodape();
});

// A janela popup do ChromeOS tem moldura do sistema: minimizar é o nativo.
ui.btnMinimizar.addEventListener('click', async () => {
  const w = await chrome.windows.getCurrent().catch(() => null);
  if (w) chrome.windows.update(w.id, { state: 'minimized' }).catch(() => {});
});

ui.btnFechar.addEventListener('click', async () => {
  const w = await chrome.windows.getCurrent().catch(() => null);
  if (w) chrome.windows.remove(w.id).catch(() => window.close());
  else window.close();
});

// ---- Lidas ----

function marcarLidas() {
  if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
  if ((chat.naoLidas ?? 0) > 0) {
    chat.naoLidas = 0;
    renderCabecalho();
  }
  enviar({ cmd: IPC.CHAT_LIDAS });
}

window.addEventListener('focus', () => {
  marcarLidas();
  if (!ui.texto.disabled) ui.texto.focus();
});
document.addEventListener('visibilitychange', marcarLidas);

// ---- Atualizações ----

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes[SESSAO_CHAT]) {
    const novo = changes[SESSAO_CHAT].newValue;
    chat = novo && typeof novo === 'object' ? novo : { de: null, itens: [], naoLidas: 0, maoAte: 0 };
    render();
    if ((chat.naoLidas ?? 0) > 0) marcarLidas();
  }
  if (area === 'local' && changes[STORAGE_TRAVA]) {
    trava = changes[STORAGE_TRAVA].newValue ?? null;
    render();
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.cmd === IPC.STATE_CHANGED) {
    conectado = msg.state === 'connected';
    renderRodape();
  } else if (msg?.cmd === IPC.CHAT_EVENTO && msg.tipo === 'mao' && typeof msg.maoAte === 'number') {
    chat.maoAte = Math.max(chat.maoAte ?? 0, msg.maoAte);
    renderRodape();
  }
});

async function carregar() {
  const [h, o] = await Promise.all([
    enviar({ cmd: IPC.CHAT_HISTORICO }),
    chrome.storage.local.get(STORAGE_TRAVA).catch(() => ({})),
  ]);
  if (h) {
    chat = { de: h.de ?? null, itens: h.itens ?? [], naoLidas: h.naoLidas ?? 0, maoAte: h.maoAte ?? 0 };
    professor = h.professor ?? null;
    if (typeof h.conectado === 'boolean') conectado = h.conectado;
  }
  trava = o?.[STORAGE_TRAVA] ?? null;
  render();
  marcarLidas();
  if (!ui.texto.disabled && document.hasFocus()) ui.texto.focus();
}

carregar();
