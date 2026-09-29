import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FILTROS_PADRAO,
  limparFiltros,
  motivoFiltro,
  normalizarCanal,
  canalBloqueado,
} from '../src/lib/filtros.js';

const casos = JSON.parse(readFileSync(new URL('./fixtures/filtros-canais.json', import.meta.url))).casos;
const todos = { ...FILTROS_PADRAO, canais: ['@canaldejogos', 'UCabcdefghijklmnopqrstuv'] };
const nenhum = { shorts: false, reels: false, tiktok: false, ias: false, canais: [] };

test('normalizarCanal segue o vetor compartilhado com o app', () => {
  for (const c of casos) assert.equal(normalizarCanal(c.entrada), c.saida, c.entrada);
});

test('limparFiltros: ausente = tudo ligado; chave ausente = padrão; canais normalizados e sem repetição', () => {
  assert.deepEqual(limparFiltros(undefined), { ...FILTROS_PADRAO, canais: [] });
  assert.deepEqual(limparFiltros({ ias: false }), { ...FILTROS_PADRAO, ias: false, canais: [] });
  assert.deepEqual(limparFiltros({ shorts: 'sim' }).shorts, true);
  assert.deepEqual(limparFiltros({ canais: ['@A.b1', 'a.b1', 'lixo com espaço', 42] }).canais, ['@a.b1']);
});

test('motivoFiltro: cada filtro bloqueia só o que é dele', () => {
  const t = (url) => motivoFiltro(todos, url);
  assert.equal(t('https://www.tiktok.com/@x/video/1'), 'tiktok');
  assert.equal(t('https://www.youtube.com/shorts/abc'), 'shorts');
  assert.equal(t('https://m.youtube.com/shorts'), 'shorts');
  assert.equal(t('https://www.youtube.com/watch?v=abc'), null);
  assert.equal(t('https://www.youtube.com/results?search_query=shorts'), null);
  assert.equal(t('https://www.instagram.com/reels/'), 'reels');
  assert.equal(t('https://www.instagram.com/reel/Cxyz/'), 'reels');
  assert.equal(t('https://www.instagram.com/p/Cxyz/'), null);
  assert.equal(t('https://www.instagram.com/escola/reels/'), 'reels');
  assert.equal(t('https://www.instagram.com/escola/'), null);
  assert.equal(t('https://gemini.google.com/app'), 'ia');
  assert.equal(t('https://chatgpt.com/'), 'ia');
  assert.equal(t('https://www.google.com/search?q=x&udm=50'), 'ia');
  assert.equal(t('https://www.google.com.br/search?q=x&udm=50'), 'ia');
  assert.equal(t('https://www.google.com/search?q=x'), null);
  assert.equal(t('https://www.bing.com/chat'), 'ia');
  assert.equal(t('https://huggingface.co/chat/'), 'ia');
  assert.equal(t('https://huggingface.co/datasets'), null);
  assert.equal(t('https://docs.google.com/document/d/1'), null);
  assert.equal(t('https://www.youtube.com/@CanalDeJogos/videos'), 'canal');
  assert.equal(t('https://www.youtube.com/@canaldejogos2'), null);
  assert.equal(t('https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv'), 'canal');
  assert.equal(t('https://notyoutube.com/shorts/x'), null);
  assert.equal(t('chrome://newtab/'), null);
});

test('motivoFiltro: com tudo desligado nada bloqueia', () => {
  for (const url of ['https://tiktok.com/', 'https://youtube.com/shorts/a', 'https://instagram.com/reels/', 'https://chatgpt.com/']) {
    assert.equal(motivoFiltro(nenhum, url), null, url);
  }
});

test('canalBloqueado reconhece handle e id do dono do vídeo', () => {
  assert.equal(canalBloqueado(todos, { handle: '@CanalDeJogos' }), true);
  assert.equal(canalBloqueado(todos, { id: 'UCabcdefghijklmnopqrstuv' }), true);
  assert.equal(canalBloqueado(todos, { handle: '@outro' }), false);
  assert.equal(canalBloqueado(nenhum, { handle: '@canaldejogos' }), false);
});
