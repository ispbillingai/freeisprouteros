#!/bin/sh
# Configuration and account setup for OpenWrt's maintained vsftpd package.
# Source this file after /lib/functions.sh. No passwords are generated or copied.

freeisp_ftp_error() {
	printf '%s\n' "FreeISP FTP: $*" >&2
	logger -t freeisp-ftp "$*"
}

freeisp_ftp_port() {
	case "$1" in ''|*[!0-9]*|0*) return 1;; esac
	[ "${#1}" -le 5 ] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

freeisp_ftp_ipv4() {
	# Canonical dotted IPv4 only: no hostnames, config newlines or octal forms.
	printf '%s\n' "$1" | awk -F. '
		NF != 4 { exit 1 }
		{ for (i = 1; i <= 4; i++)
			if ($i !~ /^[0-9]+$/ || length($i) > 3 || $i > 255 || (length($i) > 1 && substr($i, 1, 1) == "0")) exit 1 }
		END { if (NR != 1) exit 1 }
	'
}

freeisp_ftp_validate() {
	freeisp_ftp_port "$1" || { freeisp_ftp_error 'Control port must be 1-65535'; return 1; }
	freeisp_ftp_ipv4 "$2" || { freeisp_ftp_error 'Listen address must be an IPv4 address'; return 1; }
	freeisp_ftp_port "$3" && freeisp_ftp_port "$4" && [ "$3" -ge 1024 ] && [ "$4" -ge "$3" ] || {
		freeisp_ftp_error 'Passive ports must be an ordered range from 1024-65535'; return 1;
	}
	[ "$1" -lt "$3" ] || [ "$1" -gt "$4" ] || { freeisp_ftp_error 'Control port overlaps the passive range'; return 1; }
	[ -z "$5" ] || freeisp_ftp_ipv4 "$5" || { freeisp_ftp_error 'Passive address must be an IPv4 address'; return 1; }
}

freeisp_ftp_root_password_ready() {
	# Empty, locked and placeholder accounts cannot authorize a network service.
	awk -F: '$1 == "root" && $2 != "" && $2 != "x" && $2 !~ /^[!*]/ { ok = 1 } END { exit !ok }' "$1"
}

freeisp_ftp_account() {
	local name="$1" home="$2" gid
	if ! user_exists "$name"; then
		gid="$(group_add_next "$name")" || return 1
		user_add "$name" '' "$gid" 'FreeISP FTP service' "$home" /bin/false || return 1
	fi
	# An existing account is never silently repurposed or given new privileges.
	awk -F: -v name="$name" -v home="$home" '
		$1 == name && $2 == "x" && $3 >= 1000 && $4 >= 1000 && $6 == home && $7 == "/bin/false" { ok = 1 }
		END { exit !ok }
	' /etc/passwd || { freeisp_ftp_error "Unexpected $name account; refusing to start"; return 1; }
	awk -F: -v name="$name" '$1 == name && ($2 == "x" || $2 ~ /^[!*]/) { ok = 1 } END { exit !ok }' /etc/shadow || {
		freeisp_ftp_error "$name must remain a locked service account"; return 1;
	}
}

freeisp_ftp_prepare() {
	local directory
	freeisp_ftp_account freeisp-ftp /srv/freeisp || return 1
	freeisp_ftp_account freeisp-ftpd /var/run/freeisp-ftp/empty || return 1
	for directory in /srv /srv/freeisp /srv/freeisp/files /var/run/freeisp-ftp /var/run/freeisp-ftp/empty; do
		[ ! -L "$directory" ] || { freeisp_ftp_error "Refusing symlink directory $directory"; return 1; }
	done
	mkdir -p /srv/freeisp/files /var/run/freeisp-ftp/empty || return 1
	chown root:root /srv/freeisp /var/run/freeisp-ftp /var/run/freeisp-ftp/empty || return 1
	chmod 755 /srv/freeisp /var/run/freeisp-ftp /var/run/freeisp-ftp/empty || return 1
	chown freeisp-ftp:freeisp-ftp /srv/freeisp/files || return 1
	chmod 700 /srv/freeisp/files || return 1
	# Only the real router account can authenticate; session file operations are
	# then mapped to freeisp-ftp inside the unwriteable /srv/freeisp jail.
	printf 'root\n' > /var/run/freeisp-ftp/users || return 1
	chmod 600 /var/run/freeisp-ftp/users
}

freeisp_ftp_render() {
	freeisp_ftp_validate "$@" || return 1
	# OpenWrt 25.12 x86_64 vsftpd 3.0.5-r6's built-in syscall filter
	# allows alarm(), but musl implements it with setitimer(). The filter kills
	# every login worker with SIGSYS. Disable only this incompatible filter;
	# retain the daemon's separate unprivileged users and chroot confinement.
	cat <<EOF
background=NO
seccomp_sandbox=NO
listen=YES
listen_ipv6=NO
listen_address=$2
listen_port=$1
anonymous_enable=NO
local_enable=YES
write_enable=YES
local_umask=077
check_shell=NO
session_support=NO
userlist_enable=YES
userlist_deny=NO
userlist_file=/var/run/freeisp-ftp/users
guest_enable=YES
guest_username=freeisp-ftp
virtual_use_local_privs=YES
nopriv_user=freeisp-ftpd
chroot_local_user=YES
allow_writeable_chroot=NO
local_root=/srv/freeisp
secure_chroot_dir=/var/run/freeisp-ftp/empty
pasv_enable=YES
pasv_min_port=$3
pasv_max_port=$4
pasv_promiscuous=NO
port_enable=YES
port_promiscuous=NO
connect_from_port_20=YES
max_clients=10
max_per_ip=5
idle_session_timeout=300
data_connection_timeout=120
syslog_enable=YES
xferlog_enable=YES
ftpd_banner=FreeISP FTP
EOF
	[ -z "$5" ] || printf 'pasv_address=%s\n' "$5"
	return 0
}
