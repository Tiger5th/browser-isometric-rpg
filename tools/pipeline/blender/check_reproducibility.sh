#!/usr/bin/env bash
# 连续两次 headless Blender 导出并比对 SHA-256，验证管线可重复性。
# 用法：bash tools/pipeline/blender/check_reproducibility.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT="$ROOT/tools/pipeline/blender/export_test_asset.py"
OUT_DIR="${TMPDIR:-/tmp}/p0-blender-repro"
REPORT="$ROOT/reports/blender-determinism.json"
mkdir -p "$OUT_DIR" "$ROOT/reports"

if ! command -v blender >/dev/null 2>&1; then
  cat >"$REPORT" <<EOF
{
  "schemaVersion": 1,
  "status": "blocked",
  "reason": "本机 PATH 中无 blender 可执行文件",
  "script": "tools/pipeline/blender/export_test_asset.py"
}
EOF
  echo "blocked: blender not found (report: $REPORT)" >&2
  exit 2
fi

BLENDER_VERSION="$(blender --version | head -n 1)"
blender --background --factory-startup --python "$SCRIPT" -- "$OUT_DIR/a.glb" >/dev/null
blender --background --factory-startup --python "$SCRIPT" -- "$OUT_DIR/b.glb" >/dev/null

if command -v sha256sum >/dev/null 2>&1; then
  HASH_A="$(sha256sum "$OUT_DIR/a.glb" | cut -d' ' -f1)"
  HASH_B="$(sha256sum "$OUT_DIR/b.glb" | cut -d' ' -f1)"
else
  HASH_A="$(shasum -a 256 "$OUT_DIR/a.glb" | cut -d' ' -f1)"
  HASH_B="$(shasum -a 256 "$OUT_DIR/b.glb" | cut -d' ' -f1)"
fi

if cmp -s "$OUT_DIR/a.glb" "$OUT_DIR/b.glb"; then
  STATUS="passed"
else
  STATUS="failed"
fi

cat >"$REPORT" <<EOF
{
  "schemaVersion": 1,
  "status": "$STATUS",
  "blenderVersion": "$BLENDER_VERSION",
  "runs": 2,
  "sha256": ["$HASH_A", "$HASH_B"],
  "byteIdentical": $([ "$STATUS" = "passed" ] && echo true || echo false),
  "bytes": $(wc -c <"$OUT_DIR/a.glb" | tr -d ' ')
}
EOF

echo "$STATUS: $HASH_A / $HASH_B (report: $REPORT)"
[ "$STATUS" = "passed" ]
