#!/usr/bin/env bash
# master-д АЛЬ ХЭДИЙН нийлсэн локал feature branch-уудыг л устгана.
# Нийлээгүй (ажил үлдсэн) branch-д ХҮРЭХГҮЙ — аюулгүй.
# Ажиллуулах: bash scripts/cleanup-merged-branches.sh
set -euo pipefail

git checkout master
git pull origin master

echo "=== master-д нийлсэн (устгахад аюулгүй) локал branch-ууд ==="
merged=$(git branch --merged master | grep -vE '^\*|master|develop' || true)

if [ -z "$merged" ]; then
  echo "Цэвэрлэх branch алга."
  exit 0
fi

echo "$merged"
echo ""
read -r -p "Дээрх branch-уудыг устгах уу? [y/N] " ans
if [ "$ans" = "y" ] || [ "$ans" = "Y" ]; then
  echo "$merged" | xargs -n1 git branch -d
  echo "✅ Нийлсэн branch-ууд устлаа."
else
  echo "Цуцлав."
fi

echo ""
echo "ℹ️  Нийлээгүй (ажил үлдсэн) branch-уудыг ШАЛГА — эдгээрт хүрээгүй:"
git branch --no-merged master | grep -vE 'master|develop' || echo "  (байхгүй)"
