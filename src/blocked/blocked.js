// Página de bloqueio: diz por que o site não abriu e, quando é bloqueio do
// professor (regra ou prova), deixa o aluno pedir liberação com um motivo.
// O domínio (?d=) e o motivo (?m=) servem só para exibir: o pedido é montado
// pelo service worker a partir do registro do bloqueio desta aba (URL real).
// Script em arquivo — a CSP do MV3 proíbe inline.

import { siteValido } from '../lib/up.js';

const FILTROS = {
  shorts: ['Shorts bloqueados', 'Os vídeos curtos do YouTube não estão liberados. O resto do YouTube continua disponível.'],
  reels: ['Reels bloqueados', 'Os vídeos curtos do Instagram não estão liberados.'],
  tiktok: ['TikTok bloqueado', 'O TikTok não está liberado.'],
  ia: ['Inteligência artificial bloqueada', 'As ferramentas de IA não estão liberadas neste computador.'],
  canal: ['Canal bloqueado', 'Este canal do YouTube foi bloqueado pelo professor.'],
};
const PROFESSOR = {
  regra: ['Site bloqueado pelo professor', 'Este site não está liberado durante a aula.'],
  prova: ['Modo prova', 'Durante a prova, só os sites liberados pelo professor abrem.'],
};

const SEM_RESPOSTA_MS = 10 * 60 * 1000;
const LIMITE_VISIVEL_MS = 5000;
const MAX_MOTIVO = 200;

const el = (id) => document.getElementById(id);
const ui = {
  titulo: el('titulo'),
  texto: el('texto'),
  dominio: el('dominio'),
  avisoEscola: el('aviso-escola'),
  pedido: el('pedido'),
  status: el('status'),
  spinner: el('spinner'),
  statusIcone: el('status-icone'),
  statusTexto: el('status-texto'),
  motivoRecusa: el('motivo-recusa'),
  form: el('form'),
  motivo: el('motivo'),
  contador: el('contador'),
  btnCancelar: el('btn-cancelar'),
  btnEnviar: el('btn-enviar'),
  btnAcao: el('btn-acao'),
};

const params = new URLSearchParams(location.search);
const dominio = params.get('d');
const m = params.get('m');
if (dominio) {
  ui.dominio.textContent = dominio;
  ui.dominio.hidden = false;
}

// ---- Cabeçalho (motivo do bloqueio) ----

const filtro = FILTROS[m];
const tipo = filtro ? 'filtro' : m === 'prova' ? 'prova' : 'regra';
const [titulo, texto] = filtro ?? PROFESSOR[tipo];
ui.titulo.textContent = titulo;
ui.texto.textContent = texto;
document.title = titulo;
document.body.classList.toggle('prova', tipo === 'prova');
if (tipo === 'filtro') ui.avisoEscola.hidden = false;
// Sem site de verdade (data:, file:, chrome://… na prova; IP; localhost) não
// há o que pedir: a página só explica.
const podePedir = tipo !== 'filtro' && siteValido(dominio ?? '');

// ---- Pedido de liberação (máquina de estados) ----
// Estado persistido no SW (storage.session `pedidos`), então recarregar ou
// reabrir a página mostra o certo. Estados só desta página: form, enviando,
// erro e limite — somem quando o professor responde.

let pedido = null; // {mid, ts, estado, motivoRecusa?} do site desta aba
let local = null; // 'form' | 'enviando' | 'erro' | 'limite' | null
let ultimoMotivo = '';
let timerLocal = null;
let timerSemResposta = null;

function telaDerivada() {
  if (!pedido) return 'inicial';
  if (pedido.estado === 'aprovado') return 'aprovado';
  if (pedido.estado === 'recusado') return 'recusado';
  if (pedido.estado === 'enviado') {
    return Date.now() - pedido.ts >= SEM_RESPOSTA_MS ? 'sem_resposta' : 'aguardando';
  }
  return 'inicial';
}

function mostrarStatus(texto, { spinner = false, icone = '', classe = '' } = {}) {
  ui.status.hidden = false;
  ui.status.className = `status ${classe}`.trim();
  ui.spinner.hidden = !spinner;
  ui.statusIcone.textContent = icone;
  ui.statusTexto.textContent = texto;
  ui.motivoRecusa.hidden = true;
}

function botao(texto, { desabilitado = false } = {}) {
  ui.btnAcao.hidden = false;
  ui.btnAcao.textContent = texto;
  ui.btnAcao.disabled = desabilitado;
}

function render() {
  if (!podePedir) return;
  ui.pedido.hidden = false;
  ui.status.hidden = true;
  ui.form.hidden = true;
  ui.btnAcao.hidden = true;
  ui.btnAcao.disabled = false;
  ui.motivo.readOnly = false;
  const tela = local ?? telaDerivada();
  switch (tela) {
    case 'inicial':
      botao('Pedir liberação ao professor');
      break;
    case 'form':
      ui.form.hidden = false;
      ui.btnEnviar.disabled = false;
      ui.btnCancelar.disabled = false;
      break;
    case 'enviando':
      // O formulário fica à vista, travado, até o SW responder.
      mostrarStatus('Enviando pedido…', { spinner: true });
      ui.form.hidden = false;
      ui.motivo.readOnly = true;
      ui.btnEnviar.disabled = true;
      ui.btnCancelar.disabled = true;
      break;
    case 'aguardando':
      mostrarStatus('Pedido enviado. Aguarde o professor responder.');
      botao('Pedido enviado ✓', { desabilitado: true });
      agendarSemResposta();
      break;
    case 'sem_resposta':
      mostrarStatus('O professor ainda não respondeu. Você pode pedir de novo.');
      botao('Pedir de novo');
      break;
    case 'aprovado':
      mostrarStatus('Liberado! Abrindo o site…', { icone: '✓', classe: 'ok' });
      break;
    case 'recusado':
      mostrarStatus('O professor não liberou agora.', { icone: '✕', classe: 'erro' });
      if (pedido?.motivoRecusa) {
        ui.motivoRecusa.textContent = `Motivo: ${pedido.motivoRecusa}`;
        ui.motivoRecusa.hidden = false;
      }
      botao('Pedir de novo');
      break;
    case 'limite':
      mostrarStatus('Você já pediu. Aguarde o professor responder.');
      break;
    case 'erro':
      mostrarStatus('Não foi possível enviar agora. Tente de novo.', { icone: '!', classe: 'erro' });
      botao('Tentar de novo');
      break;
    default:
      break;
  }
}

function agendarSemResposta() {
  clearTimeout(timerSemResposta);
  if (!pedido || pedido.estado !== 'enviado') return;
  const falta = pedido.ts + SEM_RESPOSTA_MS - Date.now();
  timerSemResposta = setTimeout(render, Math.max(0, falta) + 50);
}

function irPara(estado) {
  clearTimeout(timerLocal);
  local = estado;
  render();
}

function abrirForm() {
  irPara('form');
  ui.motivo.value = ultimoMotivo;
  atualizarContador();
  ui.motivo.focus();
}

function atualizarContador() {
  ui.contador.textContent = `${Array.from(ui.motivo.value).length}/${MAX_MOTIVO}`;
}

async function enviar(motivo) {
  ultimoMotivo = motivo;
  irPara('enviando');
  let r = null;
  try {
    r = await chrome.runtime.sendMessage({ t: 'cda-pedido', acao: 'enviar', motivo });
  } catch {
    r = null;
  }
  if (r?.ok) {
    local = null;
    await carregar();
    return;
  }
  if (r?.erro === 'limite') {
    irPara('limite');
    timerLocal = setTimeout(() => irPara(null), LIMITE_VISIVEL_MS);
    return;
  }
  irPara('erro');
}

ui.btnAcao.addEventListener('click', () => {
  const tela = local ?? telaDerivada();
  if (tela === 'erro') enviar(ultimoMotivo);
  else abrirForm();
});

ui.btnCancelar.addEventListener('click', () => {
  ultimoMotivo = ui.motivo.value;
  irPara(null);
});

ui.motivo.addEventListener('input', atualizarContador);

ui.form.addEventListener('submit', (ev) => {
  ev.preventDefault();
  if (local === 'enviando') return;
  enviar(Array.from(ui.motivo.value.trim()).slice(0, MAX_MOTIVO).join(''));
});

async function carregar() {
  let r = null;
  try {
    r = await chrome.runtime.sendMessage({ t: 'cda-pedido', acao: 'estado' });
  } catch {
    r = null;
  }
  site = r?.site ?? null;
  pedido = r?.pedido ?? null;
  render();
}

let site = null;

// O professor respondeu (ou outra aba do mesmo site pediu): atualiza na hora.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session' || !changes.pedidos || !site) return;
  const novo = changes.pedidos.newValue?.[site] ?? null;
  const mudou = JSON.stringify(novo) !== JSON.stringify(pedido);
  pedido = novo;
  if (mudou && local !== 'enviando') local = null; // a resposta vence o estado local
  render();
});

if (podePedir) carregar();
