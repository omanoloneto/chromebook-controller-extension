# Instalação — Extensão (desenvolvimento)

> Ainda **não está na Chrome Web Store**. Instala-se como *unpacked*.

## Pré-requisitos

- **Chrome ≥ 144** (ChromeOS ou desktop).
- Chromebook e celular na **mesma Wi-Fi**, **sem client/AP isolation**.

## Instalar

1. `chrome://extensions` → ative o **Modo do desenvolvedor**.
2. **Carregar sem compactação** → selecione a pasta **`src/`**.
3. Aceite o aviso de permissão (a extensão precisa de `http://*/*` para varrer a
   rede local e achar o celular do professor).

## Como funciona (sem QR)

1. O professor abre o app no celular (ele vira servidor e mostra o IP).
2. A extensão, sozinha, **varre a rede**, acha o celular e se **vincula** ao
   **primeiro** professor encontrado (TOFU). O PC passa a aparecer na lista do app.
3. O professor digita uma URL no app → abre no Chromebook.

O ícone fica verde quando conectado. **Não há pareamento manual** no caso comum.

## Se não achar automaticamente

- Abra o popup → digite o **IP do celular** (mostrado no app) em "Usar este IP".
- Confira: mesma Wi-Fi; rede **sem isolamento de cliente**; Chrome **≥ 144**.
- Teste cru: abra `http://<ip-do-celular>:47615/` numa aba → deve responder um JSON
  com `"app":"controle-de-aula"`.

## Trocar de professor / reinstalar o app

O PC fica vinculado a um professor. Para vincular a outro (ou se o app foi
reinstalado), abra o popup → **"Desvincular professor"**.

## Local Network Access (LNA)

Chrome 142+ exige permissão de rede local; extensões com `host_permissions` são
isentas do prompt (corrigido para extensões no **Chrome 144**). Em **Chromebook
gerenciado**, o admin pode liberar com a política `LocalNetworkAccessAllowedForUrls`.
