#!/usr/bin/env bash
# Assemble the screenshot-only preview into preview/dist/.
#   HOST_DIST  a built dashboard (static/dist) to borrow compiled CSS and fonts from
#   REPO       the KiroCrew checkout whose website/public/vendor stubs to use
# Serve it with: python3 -m http.server 4793 --bind 127.0.0.1 --directory preview/dist
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ui_src="$(dirname "$here")"
repo="${REPO:?set REPO to a KiroCrew checkout}"
host_dist="${HOST_DIST:?set HOST_DIST to a built dashboard static/dist directory}"
out="$here/dist"

mkdir -p "$out/vendor" "$out/ui" "$out/assets"
(cd "$ui_src" && npx vite build --config preview/vite.preview.config.js >/dev/null)
cp "$repo"/website/public/vendor/{react,react-dom,react-dom-client,react-jsx-runtime,kirocrew-app-sdk,kirocrew-ui,lucide-react}.mjs "$out/vendor/"
cp "$ui_src/../ui/index.mjs" "$out/ui/index.mjs"
cp -r "$host_dist/fonts" "$out/"
cp "$host_dist"/assets/*.woff2 "$out/assets/" 2>/dev/null || true
links=""
for css in $(grep -o 'href="/assets/[^"]*\.css"' "$host_dist/index.html" | sed 's/href="\/assets\///; s/"$//'); do
  cp "$host_dist/assets/$css" "$out/assets/$css"
  links="$links<link rel=\"stylesheet\" href=\"/assets/$css\" />"
done
sed "s#<!-- HOST_CSS -->#$links#" "$here/index.html" > "$out/index.html"
echo "preview ready in $out"
