#!/usr/bin/env bash
# Solta uma release: bump da versão no manifest -> commit -> tag -> push.
# A GitHub Action (release.yml) zipa e publica na Chrome Web Store.
# Uso: scripts/release.sh 0.5.0
set -euo pipefail

MANIFEST="src/manifest.json"

if [[ $# -ne 1 || ! "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "uso: scripts/release.sh X.Y.Z" >&2
  exit 1
fi
NEW="$1"

cd "$(git rev-parse --show-toplevel)"

[[ -z "$(git status --porcelain)" ]] || { echo "erro: working tree sujo — commite ou stash antes." >&2; exit 1; }
[[ "$(git branch --show-current)" == "main" ]] || { echo "erro: rode na branch main." >&2; exit 1; }
git pull --ff-only

# A Web Store exige versão estritamente crescente (versão enviada "queima",
# mesmo se a review rejeitar).
CUR="$(jq -r .version "$MANIFEST")"
if [[ "$(printf '%s\n%s\n' "$CUR" "$NEW" | sort -V | tail -1)" != "$NEW" || "$NEW" == "$CUR" ]]; then
  echo "erro: $NEW precisa ser maior que a versão atual ($CUR)." >&2
  exit 1
fi

jq --arg v "$NEW" '.version = $v' "$MANIFEST" > "$MANIFEST.tmp" && mv "$MANIFEST.tmp" "$MANIFEST"

git add "$MANIFEST"
git commit -m "release: v$NEW"
# Tag ANOTADA: --follow-tags só empurra anotadas (lightweight ficaria local
# e a Action nunca dispararia).
git tag -a "v$NEW" -m "release v$NEW"
git push origin main --follow-tags

echo "OK: v$NEW enviado. Acompanhe: https://github.com/omanoloneto/chromebook-controller-extension/actions"
