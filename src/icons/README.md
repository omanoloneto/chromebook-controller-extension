# Ícones da extensão

`icon.svg` é o desenho-fonte. O Manifest V3 referencia versões **PNG** nos
tamanhos abaixo (ainda **não geradas** — tarefa em aberto):

| Arquivo | Tamanho |
|---------|---------|
| `icon-16.png` | 16×16 |
| `icon-48.png` | 48×48 |
| `icon-128.png` | 128×128 |

## Como gerar (exemplo)

Com o [Inkscape](https://inkscape.org/) instalado:

```bash
for s in 16 48 128; do
  inkscape icon.svg --export-type=png -w $s -h $s -o icon-$s.png
done
```

Ou use qualquer editor/ferramenta de exportação de SVG para PNG.
