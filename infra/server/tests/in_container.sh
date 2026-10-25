#!/usr/bin/env bash
# Runs inside a throwaway ubuntu:24.04 container (started by run.sh): sets up what the
# Droplet had before bootstrap.sh (Yacine's sudo user, /opt/focus/*/.env, a cloud-init
# sshd drop-in enabling passwords), runs bootstrap.sh several times and checks the result,
# then checks that a failing write stops it (#80).
set -euo pipefail

BOOTSTRAP=/src/server/bootstrap.sh
SSH_PORT=2222
# shellcheck source=/dev/null # lib.sh: check, eq, contains, not_contains, mode_owner, finish
. /src/server/tests/lib.sh

sshd_setting() { sshd -T -C "user=$1,host=client.example,addr=127.0.0.1" | grep -i "^$2 " || true; }
groups_of() { id -nG "$1" | tr ' ' '\n'; }

run_bootstrap() {
  local log=$1 rc=0
  bash "$BOOTSTRAP" >"$log" 2>&1 || rc=$?
  sed 's/^/     | /' "$log"
  return "$rc"
}

echo "--- Droplet state before bootstrap"
export DEBIAN_FRONTEND=noninteractive
useradd --create-home --shell /bin/bash --groups sudo yacine
for env in prod dev; do
  install -d -m 0755 "/opt/focus/$env"
  printf 'POSTGRES_PASSWORD=%s-test-value\n' "$env" >"/opt/focus/$env/.env"
  chmod 0644 "/opt/focus/$env/.env"
done
install -d -m 0755 /etc/ssh/sshd_config.d
printf 'PasswordAuthentication yes\n' >/etc/ssh/sshd_config.d/50-cloud-init.conf

echo "--- Refuses to run as a regular user"
rc=0
out=$(su -s /bin/bash nobody -c "bash $BOOTSTRAP" 2>&1) || rc=$?
check "non-root run exits non-zero" [ "$rc" -ne 0 ]
check "non-root run says to use sudo" contains "$out" "run as root"

echo "--- First run"
check "first run succeeds" run_bootstrap /tmp/run1.log

echo "--- Deploy user"
check "deploy user exists with bash" eq "$(getent passwd deploy | cut -d: -f7)" /bin/bash
check "deploy has no usable password" eq "$(getent shadow deploy | cut -d: -f2)" "*"
check "deploy is in the docker group" contains "$(groups_of deploy)" docker
check "deploy is not in the sudo group" not_contains "$(groups_of deploy)" sudo
check "no sudoers rule for deploy" bash -c '! grep -rqsw deploy /etc/sudoers /etc/sudoers.d'
check "deploy keys file is root:deploy 640" eq "$(mode_owner /etc/ssh/authorized_keys/deploy)" "640 root:deploy"
check "deploy keys file holds no key yet" bash -c '! grep -qv "^#" /etc/ssh/authorized_keys/deploy'

echo "--- Docker Engine and Compose plugin"
check "docker CLI installed" docker --version
check "compose plugin installed" docker compose version
check "buildx plugin installed" docker buildx version
check "Docker apt repo configured" contains "$(cat /etc/apt/sources.list.d/docker.sources)" "https://download.docker.com/linux/ubuntu"
check "container logs rotate" contains "$(cat /etc/docker/daemon.json)" '"max-size": "10m"'
check "live-restore on" contains "$(cat /etc/docker/daemon.json)" '"live-restore": true'

echo "--- Unattended security upgrades"
apt_config=$(apt-config dump)
check "unattended-upgrades installed" dpkg-query -W unattended-upgrades
check "package lists refresh daily" contains "$apt_config" 'APT::Periodic::Update-Package-Lists "1";'
check "unattended upgrade runs daily" contains "$apt_config" 'APT::Periodic::Unattended-Upgrade "1";'
# shellcheck disable=SC2016 # literal apt-config variables, not shell ones
check "security pocket allowed" contains "$apt_config" '"${distro_id}:${distro_codename}-security";'
check "no automatic reboot" contains "$apt_config" 'Unattended-Upgrade::Automatic-Reboot "false";'

echo "--- sshd configuration"
check "sshd config is valid" sshd -t
check "root login off" eq "$(sshd_setting root permitrootlogin)" "permitrootlogin no"
check "password auth off despite cloud-init's drop-in" eq "$(sshd_setting yacine passwordauthentication)" "passwordauthentication no"
check "keyboard-interactive off" eq "$(sshd_setting yacine kbdinteractiveauthentication)" "kbdinteractiveauthentication no"
check "deploy keys read from /etc/ssh/authorized_keys" eq "$(sshd_setting deploy authorizedkeysfile)" "authorizedkeysfile /etc/ssh/authorized_keys/%u"
check "deploy gets no PTY" eq "$(sshd_setting deploy permittty)" "permittty no"
check "deploy gets no forwarding" eq "$(sshd_setting deploy disableforwarding)" "disableforwarding yes"
check "Match block doesn't leak: yacine keeps a PTY" eq "$(sshd_setting yacine permittty)" "permittty yes"
check "Match block doesn't leak: yacine keeps ~/.ssh keys" contains "$(sshd_setting yacine authorizedkeysfile)" ".ssh/authorized_keys"
check "Match block doesn't leak: sftp subsystem still set" contains "$(sshd_setting yacine subsystem)" "sftp"

echo "--- /opt/focus layout"
check "/opt/focus is root 755" eq "$(mode_owner /opt/focus)" "755 root:root"
check "/opt/focus/bin is root 755" eq "$(mode_owner /opt/focus/bin)" "755 root:root"
for env in prod dev; do
  check "/opt/focus/$env is deploy 750" eq "$(mode_owner "/opt/focus/$env")" "750 deploy:deploy"
  check "/opt/focus/$env/.env is deploy 600" eq "$(mode_owner "/opt/focus/$env/.env")" "600 deploy:deploy"
  check "/opt/focus/$env/.env content untouched" eq "$(cat "/opt/focus/$env/.env")" "POSTGRES_PASSWORD=$env-test-value"
done

echo "--- Real SSH logins against the hardened sshd"
ssh_opts=(-p "$SSH_PORT" -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=5)
mkdir -p /tmp/keys
for who in ci ci2 root yacine; do
  ssh-keygen -q -t ed25519 -N '' -C "test-$who" -f "/tmp/keys/$who"
done
# The two option orders sshd accepts; bootstrap.sh must flag neither (#80).
printf 'restrict,command="echo forced-command-ran" %s\n' "$(cat /tmp/keys/ci.pub)" >>/etc/ssh/authorized_keys/deploy
printf 'command="echo forced-command-ran-2",restrict %s\n' "$(cat /tmp/keys/ci2.pub)" >>/etc/ssh/authorized_keys/deploy
install -d -m 0700 -o deploy -g deploy /home/deploy/.ssh
install -m 0600 -o deploy -g deploy /tmp/keys/root.pub /home/deploy/.ssh/authorized_keys
install -d -m 0700 /root/.ssh
install -m 0600 /tmp/keys/root.pub /root/.ssh/authorized_keys
install -d -m 0700 -o yacine -g yacine /home/yacine/.ssh
install -m 0600 -o yacine -g yacine /tmp/keys/yacine.pub /home/yacine/.ssh/authorized_keys
/usr/sbin/sshd -p "$SSH_PORT" -o ListenAddress=127.0.0.1
sleep 1
rc=0
out=$(ssh "${ssh_opts[@]}" -i /tmp/keys/ci deploy@127.0.0.1 'echo arbitrary-command-ran' 2>&1) || rc=$?
check "CI key runs only its forced command" eq "$out" "forced-command-ran"
rc=0
out=$(ssh "${ssh_opts[@]}" -i /tmp/keys/ci2 deploy@127.0.0.1 'echo arbitrary-command-ran' 2>&1) || rc=$?
check "CI key with command=…,restrict runs only its forced command" eq "$out" "forced-command-ran-2"
rc=0
ssh "${ssh_opts[@]}" -i /tmp/keys/root deploy@127.0.0.1 true >/dev/null 2>&1 || rc=$?
check "keys in ~deploy/.ssh are ignored" [ "$rc" -ne 0 ]
rc=0
ssh "${ssh_opts[@]}" -i /tmp/keys/root root@127.0.0.1 true >/dev/null 2>&1 || rc=$?
check "root can't log in, even with a key" [ "$rc" -ne 0 ]
rc=0
out=$(ssh "${ssh_opts[@]}" -i /tmp/keys/yacine yacine@127.0.0.1 'echo admin-login-ok' 2>&1) || rc=$?
check "yacine still logs in with his key" eq "$out" "admin-login-ok"
pkill -f "sshd -p $SSH_PORT" || true

echo "--- Second run changes nothing"
managed=(
  /etc/apt/keyrings/docker.asc /etc/apt/sources.list.d/docker.sources /etc/docker/daemon.json
  /etc/apt/apt.conf.d/20auto-upgrades /etc/apt/apt.conf.d/52focus-unattended-upgrades
  /etc/ssh/sshd_config.d/00-focus-hardening.conf /etc/ssh/authorized_keys/deploy
  /opt/focus/prod/.env /opt/focus/dev/.env
)
snapshot() {
  sha256sum "${managed[@]}"
  stat -c '%n %a %U:%G' "${managed[@]}" /opt/focus /opt/focus/bin /opt/focus/prod /opt/focus/dev
  getent passwd deploy
  id deploy
}
before=$(snapshot)
check "second run succeeds" run_bootstrap /tmp/run2.log
log2=$(cat /tmp/run2.log)
check "second run writes no file" not_contains "$log2" "==> wrote"
check "second run installs nothing" not_contains "$log2" "==> installing"
check "second run creates nothing" not_contains "$log2" "==> created"
check "second run doesn't touch sshd" not_contains "$log2" "reloaded sshd"
check "second run prints no warning" not_contains "$log2" "WARNING"
check "files, permissions and user unchanged" eq "$(snapshot)" "$before"
check "CI keys kept" eq "$(grep -c ' test-ci' /etc/ssh/authorized_keys/deploy)" 2

echo "--- Deploy keys missing restrict or command=… are flagged, in either option order"
keys=/etc/ssh/authorized_keys/deploy
add_key() {
  printf '%s\n' "$1" >>"$keys"
  wc -l <"$keys"
}
pub=$(cut -d' ' -f1,2 /tmp/keys/root.pub)
order1=$(grep -n '^restrict,command=' "$keys" | cut -d: -f1)
order2=$(grep -n '^command=.*,restrict ' "$keys" | cut -d: -f1)
command_only=$(add_key "command=\"/opt/focus/bin/focus-ci dev\" $pub command-only")
no_options=$(add_key "$pub no-options")
# Commas, spaces, "restrict" and \" inside the quoted command aren't options.
quoted=$(add_key "command=\"echo \\\"a\\\", restrict b\",no-pty $pub quoted-restrict")
restrict_only=$(add_key "  Restrict,no-pty $pub restrict-only")
check "third run succeeds" run_bootstrap /tmp/run3.log
log3=$(cat /tmp/run3.log)
check "restrict,command=… isn't flagged" not_contains "$log3" "deploy line $order1:"
check "command=…,restrict isn't flagged" not_contains "$log3" "deploy line $order2:"
check "command= without restrict is flagged, naming restrict" \
  contains "$log3" "deploy line $command_only: deploy key without restrict;"
check "a key with no options is flagged, naming both" \
  contains "$log3" "deploy line $no_options: deploy key without restrict and without command=\"…\";"
check "restrict inside a quoted command doesn't count" \
  contains "$log3" "deploy line $quoted: deploy key without restrict;"
check "restrict without command= is flagged, naming command=" \
  contains "$log3" "deploy line $restrict_only: deploy key without command=\"…\";"
check "exactly four keys flagged" eq "$(grep -c 'WARNING: .* deploy key without' /tmp/run3.log)" 4

echo "--- A failing write stops bootstrap.sh"
# Root ignores file modes, so the failing target is on a read-only mount: point
# apt.conf.d at the read-only /src, where 20auto-upgrades can't be created.
mv /etc/apt/apt.conf.d /etc/apt/apt.conf.d.saved
ln -s /src/server/tests /etc/apt/apt.conf.d
rc=0
run_bootstrap /tmp/run4.log || rc=$?
rm /etc/apt/apt.conf.d
mv /etc/apt/apt.conf.d.saved /etc/apt/apt.conf.d
log4=$(cat /tmp/run4.log)
check "a read-only target makes it exit non-zero" [ "$rc" -ne 0 ]
check "it says which file failed" \
  contains "$log4" "ERROR: writing /etc/apt/apt.conf.d/20auto-upgrades: install failed"
check "it stops there (nothing after unattended-upgrades runs)" not_contains "$log4" "==> done"
check "nothing leaked into the source tree" [ ! -e /src/server/tests/20auto-upgrades ]

# A directory where a managed file belongs: install would put a file inside it.
mv /etc/docker/daemon.json /tmp/daemon.json.saved
mkdir /etc/docker/daemon.json
rc=0
run_bootstrap /tmp/run5.log || rc=$?
rmdir /etc/docker/daemon.json
mv /tmp/daemon.json.saved /etc/docker/daemon.json
check "a directory in place of a managed file makes it exit non-zero" [ "$rc" -ne 0 ]
check "it says the target isn't a regular file" \
  contains "$(cat /tmp/run5.log)" "ERROR: writing /etc/docker/daemon.json: it exists but isn't a regular file"

check "it runs cleanly again once the target is fixed" run_bootstrap /tmp/run6.log
check "and writes nothing" not_contains "$(cat /tmp/run6.log)" "==> wrote"

finish
