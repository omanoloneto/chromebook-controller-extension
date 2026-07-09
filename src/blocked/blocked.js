// Mostra o domínio bloqueado (?d=). Script em arquivo — CSP do MV3 proíbe inline.
const dominio = new URLSearchParams(location.search).get('d');
if (dominio) document.getElementById('dominio').textContent = dominio;
