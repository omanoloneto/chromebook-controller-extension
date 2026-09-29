// Mostra o domínio (?d=) e o motivo (?m=). Script em arquivo — CSP do MV3 proíbe inline.
const MOTIVOS = {
  shorts: ['Shorts bloqueados', 'Os vídeos curtos do YouTube não estão liberados. O resto do YouTube continua disponível.'],
  reels: ['Reels bloqueados', 'Os vídeos curtos do Instagram não estão liberados.'],
  tiktok: ['TikTok bloqueado', 'O TikTok não está liberado.'],
  ia: ['Inteligência artificial bloqueada', 'As ferramentas de IA não estão liberadas neste computador.'],
  canal: ['Canal bloqueado', 'Este canal do YouTube foi bloqueado pelo professor.'],
};
const params = new URLSearchParams(location.search);
const dominio = params.get('d');
if (dominio) document.getElementById('dominio').textContent = dominio;
const motivo = MOTIVOS[params.get('m')];
if (motivo) {
  document.getElementById('titulo').textContent = motivo[0];
  document.getElementById('texto').textContent = motivo[1];
  document.title = motivo[0];
}
