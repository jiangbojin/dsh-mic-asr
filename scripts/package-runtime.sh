#!/usr/bin/env bash
# Assemble the binary runtime of dsh-mic-asr (worker, closed-source speech libraries and models) into
# dist/dsh-mic-asr-runtime-<version>-linux-x64.tar.gz for a GitHub Release.
#
# Usage: scripts/package-runtime.sh <version> <asr-library> <denoise-library> <asr-models> <vad-models> <speaker-models>
#   version          runtime version, e.g. v1; the release tag is runtime-<version>
#   asr-library      libbase_asr.so
#   denoise-library  the denoise library; it is renamed to libbase_denoise.so
#   *-models         model directories; their files are copied without checksum lists
set -euo pipefail

if [ "$#" -ne 6 ]; then
  sed -n '2,10p' "$0" >&2
  exit 64
fi
version=$1 asr=$2 denoise=$3 asr_models=$4 vad_models=$5 speaker_models=$6
root=$(cd "$(dirname "$0")/.." && pwd)
name="dsh-mic-asr-runtime-${version}-linux-x64"
stage="$root/dist/$name"

cmake -S "$root/native" -B "$root/native/build" -DCMAKE_BUILD_TYPE=Release >/dev/null
cmake --build "$root/native/build" >/dev/null

rm -rf "$stage"
mkdir -p "$stage/bin" "$stage/lib" "$stage/models/asr" "$stage/models/vad" "$stage/models/speaker"
install -m 0755 "$root/native/build/dsh-mic-asr-worker" "$stage/bin/"
strip "$stage/bin/dsh-mic-asr-worker"
install -m 0644 "$asr" "$stage/lib/libbase_asr.so"
install -m 0644 "$denoise" "$stage/lib/libbase_denoise.so"
copy_models() {
  find "$1" -maxdepth 1 -type f ! -name 'MD5SUMS' ! -name 'SHA256SUMS' -exec install -m 0644 {} "$2/" \;
}
copy_models "$asr_models" "$stage/models/asr"
copy_models "$vad_models" "$stage/models/vad"
copy_models "$speaker_models" "$stage/models/speaker"
echo "$version" > "$stage/VERSION"
(cd "$stage" && find . -type f ! -name SHA256SUMS -printf '%P\n' | LC_ALL=C sort | xargs sha256sum > SHA256SUMS)

tar -C "$root/dist" -czf "$root/dist/$name.tar.gz" "$name"
(cd "$root/dist" && sha256sum "$name.tar.gz" > "$name.tar.gz.sha256")
echo "$root/dist/$name.tar.gz"
cat "$root/dist/$name.tar.gz.sha256"
