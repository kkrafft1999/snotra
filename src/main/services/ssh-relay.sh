#!/bin/sh
# Git's SSH inside the Linux sandbox (#1155) — the launcher, the half that
# runs outside the seccomp filter.
#
# The relay that scripts/patch-sandbox-runtime.js starts in the runtime's
# inner script hands every connection from the run to this script. It still
# runs inside bubblewrap — same files, same network namespace, the private
# key files as unreadable as for the run — but without the filter, so the ssh
# it starts can reach the ssh-agent. That is exactly what the run must not
# get on its own, so everything read here comes from the run and is checked
# before it is used: one request in the form ssh-relay-client.sh writes it,
# a host and a port, and one of git's three commands — never an ssh option,
# never anything to execute here. ssh goes out through the runtime's proxy,
# with its GIT_SSH_COMMAND, so the run's network rules apply unchanged.
#
# The request, one line each:
#   SNOTRA-SSH 1 / the client's folder / -4, -6 or empty / port or empty /
#   host / GIT_PROTOCOL or empty / the command git wants run on the host
# then git's stream. `read` takes the lines a byte at a time, so the stream
# stays where ssh reads it.
#
# However it ends, it ends the same way: output closed first, then the rest
# of the client's stream read away until the client closes. socat (EXEC
# with `pipes`) sees the end of the output as such and passes it on, and git
# sees its connection close. Were this script simply to exit, socat would
# take it for a dead child and hold the connection open for its whole
# timeout, while git — its own end still open — waits for more.

# Programs by absolute PATH entries only, from /: the run's folder is where
# the relay starts, and a relative entry would find what the run put there.
cd / || exit 2
set -f
paths=
IFS=:
for entry in $PATH; do
  case $entry in /*) paths=${paths:+$paths:}$entry ;; esac
done
unset IFS
PATH=$paths
export PATH

finish() {
  exec >&-
  cat >/dev/null
  exit "$1"
}

IFS= read -r magic || finish 2
[ "$magic" = 'SNOTRA-SSH 1' ] || finish 2
IFS= read -r dir || finish 2
# The client's own folder from mktemp: errors and the exit status go there.
# Nothing written there could not be written by the run itself.
case $dir in /*/snotra-ssh.??????) ;; *) finish 2 ;; esac
[ -d "$dir" ] && [ ! -L "$dir" ] || finish 2

fail() {
  printf 'snotra-ssh-relay: %s\n' "$1" >>"$dir/stderr"
  printf '255\n' >"$dir/status"
  finish 255
}

IFS= read -r family && IFS= read -r port && IFS= read -r host \
  && IFS= read -r protocol && IFS= read -r command || fail 'incomplete request'
case $family in '' | -4 | -6) ;; *) fail 'invalid address family' ;; esac
case $port in '') ;; *[!0-9]* | ??????*) fail 'invalid port' ;; esac
case $host in '' | -* | *[!A-Za-z0-9._@:-]*) fail "invalid host: $host" ;; esac
case $protocol in *[!A-Za-z0-9=:._-]*) fail 'invalid GIT_PROTOCOL' ;; esac
case $command in
  "git-upload-pack '"* | "git-receive-pack '"* | "git-upload-archive '"*) ;;
  *) fail 'only git commands are relayed' ;;
esac

set --
[ -z "$family" ] || set -- "$@" "$family"
[ -z "$port" ] || set -- "$@" -p "$port"
if [ -n "$protocol" ]; then
  GIT_PROTOCOL=$protocol
  export GIT_PROTOCOL
  set -- "$@" -o SendEnv=GIT_PROTOCOL
else
  unset GIT_PROTOCOL
fi

# The runtime's GIT_SSH_COMMAND comes from bubblewrap's environment, not from
# the run: ssh through the proxy with its credentials, connection sharing
# off. The checked values reach it as parameters, never as code.
eval "${GIT_SSH_COMMAND:-ssh -o ControlMaster=no -o ControlPath=none}"' "$@" -- "$host" "$command"' 2>>"$dir/stderr"
printf '%s\n' "$?" >"$dir/status"
finish 0
