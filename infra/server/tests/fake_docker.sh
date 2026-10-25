#!/usr/bin/env bash
# Fake docker CLI for focus_ci.sh (#28-#30): installed as /usr/bin/docker in the throwaway
# test container. It records every call, with the names of the environment variables
# it got, and imitates just enough of docker and docker compose for focus-ci and
# install.sh. Its state lives in /tmp/fake-docker (fixed: callers run with env -i):
#
#   calls.log            one line per call: <epoch> uid=<uid> env=<names> app_tag=<APP_TAG> :: <args>
#   labels/<digest>      the registry: that digest exists, built from the commit in the file
#                        (empty for the dependency images: Postgres, the collector, Caddy)
#   local/<digest>       pulled to this host. Starts empty, like a fresh host: the
#                        dependency images are missing too (#170)
#   tags/<tag>           the digest a local :<tag> points at (one image store for the
#                        host, shared by every environment, like the real one)
#   running-<env>        the digest <env>'s app container was created from: what
#                        tags/<APP_TAG> pointed at when `compose up` ran
#   fail/<what>          make a call fail: pull, migrate, up, exec, verify (wrong image)
#   broken/<digest>      a deliberately broken build (#30): the image itself fails, so
#                        only containers created from it do. The file holds what fails,
#                        and optionally the one environment it fails in:
#                          up [<env>]       never turns healthy (/healthz): `up --wait` fails
#                          readyz [<env>]   healthy, but /readyz doesn't answer
#   sleep-up             seconds `compose up` takes
#   drop-on-up           a digest: that image leaves the host when a start of a broken
#                        build fails (to test that the revert pulls it again)
#   probe-lock           while it exists, every `compose up` appends to lock-probe.log
#                        whether /opt/focus/deploy.lock was held (by its caller), and
#                        every `pull` to pull-lock-probe.log
#
# Compose reads the images from the -f file (the real, installed compose files):
# `config --images` lists them, and `run` and `up` fail like the real thing (#28) when
# one of them other than the app's isn't on the host. With --pull never that's
# "No such image"; without it, Compose pulls what's missing first.
set -euo pipefail

state=/tmp/fake-docker
# Variables bash adds to its own environment; everything else came from the caller.
names=$(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' |
  grep -vxE 'PWD|SHLVL|_|OLDPWD' | sort | paste -sd, -)
printf '%s uid=%s env=%s app_tag=%s :: %s\n' "$(date +%s.%N)" "$(id -u)" "$names" \
  "${APP_TAG:--}" "$*" >>"$state/calls.log"

image_id() { printf 'sha256:img%s\n' "${1#sha256:}"; }
# broken <digest> <env> <what>: that image is broken that way in that environment.
broken() {
  local how where
  [[ -f $state/broken/$1 ]] || return 1
  read -r how where <"$state/broken/$1" || true
  [[ $how == "$3" && (-z $where || $where == "$2") ]]
}
digest_of() { if [[ $1 == *@* ]]; then printf '%s' "${1#*@}"; fi; }
# images_of <compose file>: each service's image, ${APP_TAG...} filled in.
images_of() {
  local line ref
  while IFS= read -r line; do
    [[ $line =~ ^[[:space:]]+image:[[:space:]]*([^[:space:]#]+) ]] || continue
    ref=${BASH_REMATCH[1]}
    # shellcheck disable=SC2016 # a literal ${APP_TAG...} from the compose file
    if [[ $ref == *'${APP_TAG'* ]]; then ref=${ref%%\$\{APP_TAG*}${APP_TAG:-}; fi
    printf '%s\n' "$ref"
  done <"$1"
}
# dependencies_present <compose file> <pull policy>: every image but the app's is on
# the host. With policy never, a missing one fails as it did on #28; otherwise it's
# pulled from the registry first, if it's there.
dependencies_present() {
  local ref digest
  while IFS= read -r ref; do
    [[ $ref != ghcr.io/ybenzine/ineedtofocus:* ]] || continue
    digest=$(digest_of "$ref")
    [[ -z $digest || ! -f $state/local/$digest ]] || continue
    if [[ $2 != never && -n $digest && -f $state/labels/$digest && ! -e $state/fail/pull ]]; then
      : >"$state/local/$digest"
      continue
    fi
    echo "Error response from daemon: No such image: $ref" >&2
    return 1
  done < <(images_of "$1")
}

case ${1:-} in
  pull)
    ref=${*: -1}
    digest=$(digest_of "$ref")
    if [[ -e $state/probe-lock ]]; then
      if flock -n /opt/focus/deploy.lock true; then held=free; else held=held; fi
      echo "pull $ref lock=$held" >>"$state/pull-lock-probe.log"
    fi
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
  inspect) # docker inspect --format '{{.Image}}' container-<env>-app
    container=${*: -1}
    env_name=${container#container-}
    env_name=${env_name%-app}
    if [[ -e $state/fail/verify ]]; then
      image_id sha256:0000000000000000000000000000000000000000000000000000000000000000
    else
      image_id "$(cat "$state/running-$env_name")"
    fi
    ;;
  compose)
    shift
    edge=0 env_name="" file=""
    while (($#)); do
      case $1 in
        -f | --env-file | -p)
          [[ $1 != -f ]] || file=$2
          [[ $2 == */compose.edge.yml ]] && edge=1
          if [[ $2 =~ ^/opt/focus/(prod|dev)/\.env$ ]]; then env_name=${BASH_REMATCH[1]}; fi
          shift 2
          ;;
        *) break ;;
      esac
    done
    policy=missing
    [[ " $* " != *" --pull never "* ]] || policy=never
    case ${1:-} in
      config)
        [[ $2 == --images ]] || exit 1
        images_of "$file"
        ;;
      run)
        dependencies_present "$file" "$policy" || exit 1
        [[ " $* " != *" alembic "* || ! -e $state/fail/migrate ]] || exit 1
        ;;
      up)
        dependencies_present "$file" "$policy" || exit 1
        [[ ! -e $state/fail/up ]] || exit 1
        [[ ! -f $state/sleep-up ]] || sleep "$(cat "$state/sleep-up")"
        if [[ -e $state/probe-lock ]]; then
          if flock -n /opt/focus/deploy.lock true; then held=free; else held=held; fi
          echo "app_tag=${APP_TAG:--} lock=$held" >>"$state/lock-probe.log"
        fi
        if ((!edge)) && [[ " $* " != *" otel-collector "* ]]; then
          # --pull never: the image must be on the host under :<APP_TAG>.
          [[ -n $env_name && -f $state/tags/$APP_TAG ]] || exit 1
          cp "$state/tags/$APP_TAG" "$state/running-$env_name"
          # The container is created from a broken image, but never turns healthy.
          if broken "$(cat "$state/running-$env_name")" "$env_name" up; then
            [[ ! -f $state/drop-on-up ]] || rm -f "$state/local/$(cat "$state/drop-on-up")"
            exit 1
          fi
        fi
        ;;
      ps) echo "container-$env_name-app" ;;
      exec)
        [[ ! -e $state/fail/exec ]] || exit 1
        if [[ " $* " == *"/readyz"* ]] && broken "$(cat "$state/running-$env_name")" "$env_name" readyz; then
          exit 1
        fi
        ;;
      *) ;;
    esac
    ;;
  *)
    echo "fake docker: unexpected call: $*" >&2
    exit 1
    ;;
esac
