#!/bin/bash
# Invoked by the weles-worker systemd unit. Wraps the node worker in xvfb-run
# so headful Chromium has a virtual display on a headless VM.
exec /usr/bin/xvfb-run -a --server-args="-screen 0 1920x1080x24" /usr/bin/node /home/lukaszbartoszcze/weles/scripts/worker/run.mjs
