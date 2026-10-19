#!/bin/sh
# Git's SSH command inside the Linux sandbox (#1155) — the half that runs in
# the run, under the seccomp filter.
#
# The filter refuses every Unix socket, so ssh in here can never reach the
# ssh-agent. This does not try: it hands git's request to the relay that
# scripts/patch-sandbox-runtime.js starts before the filter, over a TCP
# connection on the run's own loopback, and copies the bytes both ways. The
# relay's launcher (ssh-relay.sh) checks the request and runs ssh with the
# agent. The private key files stay unreadable on both sides.
#
# ssh's error output and its exit status come back through a folder in the
# run's TMPDIR, which both sides can write: the connection itself carries
# only git's protocol.
#
# Called by git as GIT_SSH_COMMAND, with GIT_SSH_VARIANT=ssh:
#   ssh-relay-client.sh [-4|-6] [-p <port>] [-o SendEnv=GIT_PROTOCOL] <host> <command>

fail() {
  printf 'snotra-ssh-relay: %s\n' "$1" >&2
  exit 255
}

family=
port=
sendenv=
while [ $# -gt 0 ]; do
  case $1 in
    -4 | -6) family=$1 ;;
    -p)
      [ $# -ge 2 ] || fail 'the option -p needs a port'
      port=$2
      shift
      ;;
    -o)
      [ "${2-}" = SendEnv=GIT_PROTOCOL ] || fail "only Git's own options are relayed, not -o ${2-}"
      sendenv=1
      shift
      ;;
    --) shift; break ;;
    -*) fail "only Git's own options are relayed, not $1" ;;
    *) break ;;
  esac
  shift
done
[ $# -eq 2 ] || fail 'expected a host and a command, as git passes them'
host=$1
command=$2
protocol=
[ -z "$sendenv" ] || protocol=${GIT_PROTOCOL-}
nl='
'
case $host$command$protocol in *"$nl"*) fail 'a line break in an argument' ;; esac

dir=$(mktemp -d "${TMPDIR:-/tmp}/snotra-ssh.XXXXXX") || fail 'no temporary folder for the relay'

# git's stdin goes to the relay after the request; fd 3, because an
# asynchronous list starts with stdin on /dev/null. -t: after git's last
# byte, the answer may still take its time.
#
# The answer reaches git through one last `cat`, which ends when the relay
# closes (`shut-close` on the writing half: a pipe cannot be shut down
# half-way, and socat 1.8 ignores the option on STDIO as a whole). Before
# git's stream ends with it, ssh's error output goes to git's stderr: once
# git sees the end, it gives up, and the run — and this script with it — may
# be gone before anything printed later arrived. The shell lets go of git's
# stdout before it waits, so nothing else holds the stream open. None of
# these hold the run's stderr longer than they must.
exec 3<&0
{
  printf 'SNOTRA-SSH 1\n%s\n%s\n%s\n%s\n%s\n%s\n' "$dir" "$family" "$port" "$host" "$protocol" "$command"
  exec cat <&3
} 2>/dev/null | socat -t 3600 STDIN!!STDOUT,shut-close TCP:127.0.0.1:2222,retry=50,interval=0.1 2>"$dir/relay" | {
  cat
  # socat's own complaints only where the relay gave no answer: after one, a
  # connection the launcher closed while git still wrote is no news.
  if [ -s "$dir/status" ]; then cat "$dir/stderr"; else cat "$dir/relay"; fi >&2 2>/dev/null
} &
exec >&- 3<&-
# git ends its SSH command with SIGTERM once it gives up; the exit status
# still goes back if there is time.
trap : TERM
wait
wait

status=$(cat "$dir/status" 2>/dev/null)
rm -rf "$dir"
case $status in
  '' | *[!0-9]*) fail 'the SSH relay of the sandbox did not answer' ;;
esac
exit "$status"
