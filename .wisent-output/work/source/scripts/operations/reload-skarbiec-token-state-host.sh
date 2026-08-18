#!/bin/sh
set -eu
exec /bin/launchctl kickstart -k system/com.wisent.always-on.skarbiec
