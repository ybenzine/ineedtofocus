#!/usr/bin/env bash
# Fake docker CLI for focus_ci.sh (#28-#30): installed as /usr/bin/docker in the throwaway
# test container. It records every call, with the names of the environment variables
# it got, and imitates just enough of docker and docker compose for focus-ci and
# install.sh. Its state lives in /tmp/fake-docker (fixed: callers run with env -i):
#
#   calls.log            one line per call: <epoch> uid=<uid> env=<names> app_tag=<APP_TAG> :: <args>
#   labels/<digest>      the registry: that digest exists, built from the commit in the file
#                        (empty for the dependency images: Postgres, the collector, Caddy)
#   local/<digest>       pulled to this host; the file holds the name it was pulled as
#                        (name:tag for the pinned images, the repository for the app's).
#                        Starts empty, like a fresh host: the dependency images are
#                        missing too (#170). `image ls` lists them, `image rm` of its
#                        <repo>@<digest> reference removes one (#117)
#   tags/<tag>           the digest a local :<tag> points at (one image store for the
#                        host, shared by every environment, like the real one). Only
#                        the app's repository has these; `image rm` of <repo>:<tag>
#                        removes one
#   running-<env>        the digest <env>'s app container was created from: what
#                        tags/<APP_TAG> pointed at when `compose up` ran
#   fail/<what>          make a call fail: pull, migrate, up, exec, verify (wrong image),
#                        rm (`image rm`), refs (`image inspect` of an image's references),
#                        schema (the `run … python -` that reads a release's schema)
#   schema/<digest>      what that release's migration_info.py prints (#165): its schema=
#                        and contracts= lines. Without it: schema=0002, contracts=-
#   run-stdin            what the last `run … python -` got on stdin
#   broken/<digest>      a deliberately broken build (#30): the image itself fails, so
#                        only containers created from it do. The file holds what fails,
#                        and optionally the one environment it fails in:
#                          up [<env>]       never turns healthy (/healthz): `up --wait` fails
#                          readyz [<env>]   healthy, but /readyz doesn't answer
#   sleep-up             seconds `compose up` takes
#   drop-on-up           a digest: that image leaves the host when a start of a broken
#                        build fails (to test that the revert pulls it again)
#   probe-lock           while it exists, every `compose up` appends to lock-probe.log
#                        whether /opt/focus/deploy.lock was held (by its caller), every
#                        `pull` to pull-lock-probe.log and every `image rm` to
#                        rm-lock-probe.log
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

app_repo=ghcr.io/ybenzine/ineedtofocus
image_id() { printf 'sha256:img%s\n' "${1#sha256:}"; }
# repository <name[:tag]>: the name without its tag.
repository() { if [[ ${1##*/} == *:* ]]; then printf '%s' "${1%:*}"; else printf '%s' "$1"; fi; }
# lock_probe <log> <line>: append whether /opt/focus/deploy.lock is held, while probe-lock exists.
lock_probe() {
  local held
  [[ -e $state/probe-lock ]] || return 0
  if flock -n /opt/focus/deploy.lock true; then held=free; else held=held; fi
  echo "$2 lock=$held" >>"$state/$1"
}
# arrive <name@digest>: that image is on the host now, under that name.
arrive() { printf '%s\n' "${1%@*}" >"$state/local/${1#*@}"; }
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
      arrive "$ref"
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
    lock_probe pull-lock-probe.log "pull $ref"
    [[ ! -e $state/fail/pull ]] || exit 1
    [[ -n $digest && -f $state/labels/$digest ]] || {
      echo "Error response from daemon: manifest unknown" >&2
      exit 1
    }
    arrive "$ref"
    echo "$ref"
    ;;
  image) # inspect, ls, rm
    case $2 in
      inspect)
        if [[ $3 == --format ]]; then
          format=$4 ref=$5
        else
          format="" ref=$3
        fi
        if [[ $ref == sha256:img* ]]; then # by image ID (#117)
          digest=sha256:${ref#sha256:img}
        else
          digest=$(digest_of "$ref")
        fi
        [[ -n $digest && -f $state/local/$digest ]] || {
          echo "Error: No such image: $ref" >&2
          exit 1
        }
        case $format in
          "") echo '[{}]' ;;
          *image.revision*) cat "$state/labels/$digest" ;;
          '{{.Id}}') image_id "$digest" ;;
          *RepoTags*RepoDigests*) # its references: tags, then <repo>@<digest>
            [[ ! -e $state/fail/refs ]] || exit 1
            name=$(cat "$state/local/$digest")
            repo=$(repository "$name")
            if [[ $repo == "$app_repo" ]]; then
              for path in "$state"/tags/*; do
                [[ -f $path && $(cat "$path") == "$digest" ]] || continue
                printf '%s:%s\n' "$app_repo" "${path##*/}"
              done
            elif [[ $name != "$repo" ]]; then
              printf '%s\n' "$name"
            fi
            printf '%s@%s\n' "$repo" "$digest"
            ;;
          *) exit 1 ;;
        esac
        ;;
      ls) # image ls --no-trunc --format '{{.Repository}} {{.ID}}': a line per name
        for path in "$state"/local/sha256:*; do
          [[ -f $path ]] || continue
          digest=${path##*/}
          repo=$(repository "$(cat "$path")")
          echo "$repo $(image_id "$digest")"
          if [[ $repo == "$app_repo" ]]; then
            for tag_path in "$state"/tags/*; do
              if [[ -f $tag_path && $(cat "$tag_path") == "$digest" ]]; then
                echo "$repo $(image_id "$digest")"
              fi
            done
          fi
        done
        ;;
      rm) # image rm <reference...>, unforced, like Docker's classic image store: each
        # reference in turn, then status 1 if any failed. Removing an image's last tag
        # deletes the image, digest references included (so a later <repo>@<digest>
        # is "No such image"). An image a container runs can't lose its last reference.
        shift 2
        lock_probe rm-lock-probe.log "rm $*"
        [[ ! -e $state/fail/rm ]] || exit 1
        tags_of() { # <digest>: the app tags pointing at it
          local path
          for path in "$state"/tags/*; do
            if [[ -f $path && $(cat "$path") == "$1" ]]; then echo "${path##*/}"; fi
          done
        }
        in_use() { # <digest>
          local path
          for path in "$state"/running-*; do
            [[ -f $path && $(cat "$path") == "$1" ]] && return 0
          done
          return 1
        }
        status=0
        for ref in "$@"; do
          if [[ $ref == *@sha256:* ]]; then
            digest=${ref#*@}
            if [[ ! -f $state/local/$digest ]]; then
              echo "Error response from daemon: No such image: $ref" >&2
              status=1
            elif [[ -n $(tags_of "$digest") ]]; then
              echo "Untagged: $ref" # the tags keep the image
            elif in_use "$digest"; then
              echo "Error response from daemon: conflict: unable to delete $ref (cannot be forced) - image is being used by running container" >&2
              status=1
            else
              rm -f "$state/local/$digest"
              echo "Untagged: $ref"
              echo "Deleted: $(image_id "$digest")"
            fi
          elif [[ $ref == "$app_repo":* && -f $state/tags/${ref##*:} ]]; then
            digest=$(cat "$state/tags/${ref##*:}")
            if [[ $(tags_of "$digest" | wc -l) -gt 1 ]]; then
              rm -f "$state/tags/${ref##*:}"
              echo "Untagged: $ref"
            elif in_use "$digest"; then
              echo "Error response from daemon: conflict: unable to remove repository reference \"$ref\" - container is using its referenced image" >&2
              status=1
            else
              rm -f "$state/tags/${ref##*:}" "$state/local/$digest"
              echo "Untagged: $ref"
              echo "Deleted: $(image_id "$digest")"
            fi
          else
            echo "Error response from daemon: No such image: $ref" >&2
            status=1
          fi
        done
        exit "$status"
        ;;
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
        if [[ " $* " == *" python - "* ]]; then # focus-ci's schema step (#165)
          cat >"$state/run-stdin"
          [[ ! -e $state/fail/schema ]] || exit 1
          digest=$(cat "$state/tags/$APP_TAG")
          if [[ -f $state/schema/$digest ]]; then
            cat "$state/schema/$digest"
          else
            printf 'schema=0002\ncontracts=-\n'
          fi
        fi
        ;;
      up)
        dependencies_present "$file" "$policy" || exit 1
        [[ ! -e $state/fail/up ]] || exit 1
        [[ ! -f $state/sleep-up ]] || sleep "$(cat "$state/sleep-up")"
        lock_probe lock-probe.log "app_tag=${APP_TAG:--}"
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
