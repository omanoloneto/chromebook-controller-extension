# Como contribuir

Obrigado pelo interesse em ajudar o **Controle de Aula**! Este projeto é
educacional e de código aberto. Toda a documentação e as discussões são em
**português**.

## Antes de começar

- Leia [`docs/arquitetura.md`](docs/arquitetura.md) e
  [`docs/protocolo.md`](docs/protocolo.md). O protocolo de mensagens é
  **compartilhado** com o app de controle
  ([`chromebook-controller-app`](https://github.com/omanoloneto/chromebook-controller-app)).
  Qualquer mudança no protocolo precisa ser feita **nos dois repositórios**.

## Fluxo de trabalho

1. Faça um fork e crie um branch a partir de `main`:
   `git checkout -b minha-melhoria`
2. Faça commits pequenos e descritivos, em português.
3. Abra um Pull Request explicando **o quê** e **por quê**.

## Padrões

- **Commits:** mensagem no imperativo (ex.: `adiciona leitura de QR no popup`).
- **Código:** comentários em português; nomes de variáveis/funções podem ficar
  em inglês para seguir convenções da API do Chrome.
- **Sem dependências desnecessárias.** A extensão deve rodar como
  *unpacked* sem etapa de build sempre que possível.

## Reportando problemas

Abra uma *issue* descrevendo o passo a passo para reproduzir, o Chromebook /
versão do Chrome e o que era esperado.
