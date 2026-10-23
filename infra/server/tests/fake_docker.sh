#!/usr/bin/env bash
# Fake docker CLI for focus_ci.sh (#28): installed as /usr/bin/docker in the throwaway
# test container. It records every call, with the names of the environment variables
# it got, and imitates just enough of docker and docker compose for focus-ci and
# install.sh. Its state lives in /tmp/fake-docker (fixed: callers run with env -i):
#
#   calls.log            one line per call: <epoch> uid=<uid> env=<names> app_tag=<APP_TAG> :: <args>
#   labels/<digest>      the registry: that digest exists, built from the commit in the file
#   local/<digest>       pulled to this host
#   tags/<tag>           the digest a local :<tag> points at
#   running              the tag the app container was last started with
#   fail/<what>          make a call fail: pull, migrate, up, exec, verify (wrong image)
#   sleep-up             seconds `compose up` takes
set -euo pipefail

state=/tmp/fake-docker
# Variables bash adds to its own environment; everything else came from the caller.
names=$(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' |
  grep -vxE 'PWD|SHLVL|_|OLDPWD' | sort | paste -sd, -)
printf '%s uid=%s env=%s app_tag=%s :: %s\n' "$(date +%s.%N)" "$(id -u)" "$names" \
  "${APP_TAG:--}" "$*" >>"$state/calls.log"

image_id() { printf 'sha256:img%s\n' "${1#sha256:}"; }
digest_of() { if [[ $1 == *@* ]]; then printf '%s' "${1#*@}"; fi; }

case ${1:-} in
  pull)
    ref=${*: -1}
    digest=$(digest_of "$ref")
    [[ ! -e $state/fail/pull ]] || exit 1
    [[ -n $digest && -f $state/labels/$digest ]] || {
      echo "Error response from daemon: manifest unknown" >&2
      exit 1
    }
    : >"$state/local/$digest"
    echo "$ref"
    ;;
  image)
    [[ $2 == inspect ]] || exit 1
    if [[ $3 == --format ]]; then
      format=$4 ref=$5
    else
      format="" ref=$3
    fi
    digest=$(digest_of "$ref")
    [[ -n $digest && -f $state/local/$digest ]] || {
      echo "Error: No such image: $ref" >&2
      exit 1
    }
    case $format in
      "") echo '[{}]' ;;
      *image.revision*) cat "$state/labels/$digest" ;;
      '{{.Id}}') image_id "$digest" ;;
      *) exit 1 ;;
    esac
    ;;
  tag)
    digest=$(digest_of "$2")
    printf '%s\n' "$digest" >"$state/tags/${3##*:}"
    ;;
  inspect) # docker inspect --format '{{.Image}}' <container>
    if [[ -e $state/fail/verify ]]; then
      image_id sha256:0000000000000000000000000000000000000000000000000000000000000000
    else
      image_id "$(cat "$state/tags/$(cat "$state/running")")"
    fi
    ;;
  compose)
    shift
    edge=0
    while (($#)); do
      case $1 in
        -f | --env-file | -p)
          [[ $2 == */compose.edge.yml ]] && edge=1
          shift 2
          ;;
        *) break ;;
      esac
    done
    case ${1:-} in
      run) [[ " $* " != *" alembic "* || ! -e $state/fail/migrate ]] || exit 1 ;;
      up)
        [[ ! -e $state/fail/up ]] || exit 1
        [[ ! -f $state/sleep-up ]] || sleep "$(cat "$state/sleep-up")"
        if ((!edge)) && [[ " $* " != *" otel-collector "* ]]; then
          printf '%s\n' "$APP_TAG" >"$state/running"
        fi
        ;;
      ps) echo container-app ;;
      exec) [[ ! -e $state/fail/exec ]] || exit 1 ;;
      *) ;;
    esac
    ;;
  *)
    echo "fake docker: unexpected call: $*" >&2
    exit 1
    ;;
esac
