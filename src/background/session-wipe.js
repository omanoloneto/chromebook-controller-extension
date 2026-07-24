// Desloga os sites na virada de sessão (default: TODOS menos os da allowlist,
// que vem vazia — ou seja, limpa tudo; a conta @escolacelita re-injeta sozinha).
// Importado por efeito colateral no service-worker.js — registra os listeners
// de forma SÍNCRONA no load para o MV3 acordar o worker no evento.
//
// TIMING (ler antes de mexer): o MV3 NÃO tem evento confiável de "Chrome
// fechando" que garanta rodar limpeza async — runtime.onSuspend não dispara
// para service worker. O gatilho confiável é onStartup (próximo login). Logo, a
// GARANTIA é "limpo antes do aluno usar no próximo login", não no instante do
// logout. Ver src/lib/session-wipe.js para os limites (por-site, não por-conta;
// google.com é jar único).

import { STORAGE_SCHOOL_ORIGINS, STORAGE_WIPE_PENDING } from '../lib/ipc.js';
import { montarOpcoesLimpeza, DEFAULT_SCHOOL_ORIGINS } from '../lib/session-wipe.js';

// Allowlist configurável via storage (o app/admin pode atualizar sem mexer no
// código — igual às regras/binding). Chave ausente => DEFAULT; array vazio =>
// limpa tudo (respeita a config explícita).
async function origensDaEscola() {
  try {
    const o = await chrome.storage.local.get(STORAGE_SCHOOL_ORIGINS);
    const salvo = o[STORAGE_SCHOOL_ORIGINS];
    return salvo === undefined ? DEFAULT_SCHOOL_ORIGINS : salvo;
  } catch {
    return DEFAULT_SCHOOL_ORIGINS;
  }
}

// Idempotente. Marca WIPE_PENDING antes e só limpa a marca ao concluir: se o
// worker MV3 morrer no meio (provável no caminho da última janela), a marca
// sobrevive e o próximo onStartup repete — limpar de novo é inofensivo.
async function limparSessoesForaDaEscola(motivo) {
  if (chrome.browsingData === undefined) return; // sem a permissão / não suportado
  const { options, dataToRemove } = montarOpcoesLimpeza(await origensDaEscola());
  try {
    await chrome.storage.local.set({ [STORAGE_WIPE_PENDING]: true });
    await chrome.browsingData.remove(options, dataToRemove);
    await chrome.storage.local.remove(STORAGE_WIPE_PENDING);
  } catch (e) {
    // Mantém WIPE_PENDING marcado — o próximo onStartup tenta de novo.
    console.warn('[session-wipe] limpeza falhou (' + motivo + '):', e?.message ?? e);
  }
}

// Fonte da verdade: início de perfil = logout -> login no Chromebook. Único
// gatilho confiável; garante a sessão anterior limpa antes do aluno usar.
chrome.runtime.onStartup.addListener(() => {
  limparSessoesForaDaEscola('startup');
});

// Best-effort: última janela normal fechada (aproxima "Chrome fechado"). No
// ChromeOS isto NÃO é logout — a extensão sobrevive sem janela (offscreen
// mantém o Firebase) — e o worker pode morrer antes de concluir; por isso é só
// tentativa adiantada, com o onStartup como garantia.
//
// ATENÇÃO (acoplamento com "encerrar aula"): execFecharTudo({closeWindows:true})
// também zera as janelas e VAI disparar esta limpeza — ou seja, encerrar a aula
// desloga os sites pessoais na hora. Se NÃO quiser esse comportamento, remova
// este listener e confie só no onStartup.
chrome.windows.onRemoved.addListener(async () => {
  try {
    const janelas = await chrome.windows.getAll({ windowTypes: ['normal'] });
    if (janelas.length === 0) await limparSessoesForaDaEscola('ultima-janela');
  } catch {
    // best-effort
  }
});
