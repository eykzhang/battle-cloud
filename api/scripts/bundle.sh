#!/usr/bin/env sh
# Builds the Lambda artifact: one ESM file plus a zip of it.
#
# A bundle rather than the container image the Dockerfile builds. Lambda's Node base image
# resolves a handler through its runtime client, which looks for .mjs, .js, or .cjs and
# will not load the .ts entry this project runs everywhere else, and betting on
# --experimental-strip-types inside a runtime AWS controls is a bet with no upside.
# esbuild strips the types at build time instead, and the artifact cold-starts in about a
# third of the time a container image does.
#
# The image is still what compose runs, so both packagings come from the same src/.
set -eu

cd "$(dirname "$0")/.."
rm -rf dist
mkdir -p dist

# --external:pg-native: pg requires it lazily for the libpq-backed client, which is not
# installed and not wanted. Left in, esbuild fails the build on a module that never loads
# at runtime.
#
# The banner shim exists because the output is ESM while several dependencies are CommonJS
# and call require() at runtime. ESM has no require, so one is created from import.meta.
./node_modules/.bin/esbuild src/lambda.ts \
  --bundle \
  --platform=node \
  --target=node22 \
  --format=esm \
  --outfile=dist/index.mjs \
  --external:pg-native \
  --banner:js="import{createRequire as __cr}from'module';const require=__cr(import.meta.url);" \
  --log-level=warning

# The same check the Dockerfile runs on the image: a bundle that cannot be imported is a
# cold start that fails in production rather than here.
DATABASE_URL='postgres://bundle-check@example.invalid/none' node -e "import('./dist/index.mjs').then(m => { if (typeof m.handler !== 'function') { throw new Error('no handler export'); } })"

cd dist && zip -q -X lambda.zip index.mjs
echo "dist/lambda.zip $(du -h lambda.zip | cut -f1), index.mjs $(du -h index.mjs | cut -f1)"
