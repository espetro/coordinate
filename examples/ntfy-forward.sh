#!/bin/sh
# Send every job event to an ntfy topic. Needs NTFY_TOPIC.
# coordinate forward calls the command once per event, with the event as JSON on stdin
# and {message} replaced by a one-line summary.
set -eu
exec coordinate forward --exec 'curl -s -m 3 -d "{message}" "https://ntfy.sh/$NTFY_TOPIC"'
