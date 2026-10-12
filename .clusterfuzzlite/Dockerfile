# ClusterFuzzLite build image — OpenSSF Scorecard detects fuzzing via this file.
# Uses the OSS-Fuzz JavaScript base builder (Jazzer.js), which provides
# `compile_javascript_fuzzer`. See build.sh for the fuzz targets.
# Digest-pinned (Scorecard Pinned-Dependencies); dependabot's docker ecosystem
# refreshes the pin so it tracks upstream instead of rotting.
FROM gcr.io/oss-fuzz-base/base-builder-javascript@sha256:c3f81884ebc6232a4c9d74bd3848f160dfda9baee6059195aeabe823f96dad79
COPY . $SRC/browser-bridge
WORKDIR $SRC/browser-bridge
COPY .clusterfuzzlite/build.sh $SRC/build.sh
