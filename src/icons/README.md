# Ícones da extensão

`icon.svg` é o desenho-fonte. O Manifest V3 usa as versões **PNG** abaixo
(já geradas e versionadas):

| Arquivo | Tamanho |
|---------|---------|
| `icon-16.png` | 16×16 |
| `icon-48.png` | 48×48 |
| `icon-128.png` | 128×128 |

## Como regenerar

Com o [Inkscape](https://inkscape.org/):

```bash
for s in 16 48 128; do
  inkscape icon.svg --export-type=png -w $s -h $s -o icon-$s.png
done
```

> As PNGs atuais foram desenhadas via script (Pillow) a partir do mesmo traçado
> do `icon.svg`. São ícones provisórios; troque pelo design definitivo quando
> houver.
