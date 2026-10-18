#!/usr/bin/env python3# -*- coding: utf-8 -*-
"""
╔══════════════════════════════════════════════════════════════════════════════╗
║ ║
║ 🧠 NEXUS MENTAL TERMINAL v2.0.0 — Ubuntu/Unix Edition ║
║ ║
║ Terminal virtuel en mémoire pour agents IA. ║
║ Simule : bash + Python + apt + snap + systemd + noyaux Ubuntu + PPA ║
║ AUCUN accès au système réel. ║
║ ║
║ NEW v2.0.0 : ║
║ • Ubuntu Package APIs (apt, dpkg, snap, flatpak) ║
║ • Kernel PPA (canonical-kernel-team, hwe-team, liquorix) ║
║ • Systemd simulation (systemctl, journalctl) ║
║ • Unix syscalls (uname, getpid, getuid, getenv) ║
║ • Filesystem hierarchy standard (FHS) ║
║ ║
║ Auteur : Aissa Mohammedi (DGK) ║
║ Version : 2.0.0 ║
║ Licence : NEXUS-OPEN-2.0 ║
║ ║
╚══════════════════════════════════════════════════════════════════════════════╝
"""

import os
import sys
import re
import io
import ast
import json
import math
import time
import uuid
import shlex
import random
import string
import hashlib
import base64
import sqlite3
import datetime
import operator
import textwrap
import statistics
import subprocess
from pathlib import Path
from contextlib import redirect_stdout, redirect_stderr
from typing import Any, Dict, List, Optional, Tuple, Callable
from collections import Counter, defaultdict, OrderedDict
from dataclasses import dataclass, field
from enum import Enum


# ══════════════════════════════════════════════════════════════════════════════
# VERSION
# ══════════════════════════════════════════════════════════════════════════════
VERSION = "2.0.0"
AUTHOR = "Aissa Mohammedi (DGK)"
LICENCE = "NEXUS-OPEN-2.0"


# ══════════════════════════════════════════════════════════════════════════════
# BASE DE DONNÉES UBUNTU/UNIX
# ══════════════════════════════════════════════════════════════════════════════

UBUNTU_PPA_DATABASE = {
"canonical-kernel-team/unstable": {
"description": "Noyaux linux-unstable (base des futures versions Ubuntu)",
"url": "https://launchpad.net/~canonical-kernel-team/+archive/ubuntu/unstable",
"command": "sudo add-apt-repository ppa:canonical-kernel-team/unstable",
"category": "kernel",
"risk": "high"
},
"canonical-hwe-team/experimental-unstable": {
"description": "Noyaux expérimentaux instables (staging)",
"url": "https://launchpad.net/~canonical-hwe-team/+archive/ubuntu/experimental-unstable",
"command": "sudo add-apt-repository ppa:canonical-hwe-team/experimental-unstable",
"category": "kernel",
"risk": "high"
},
"canonical-hwe-team/experimental-next": {
"description": "Noyaux basés sur linux-next (upstream)",
"url": "https://launchpad.net/~canonical-hwe-team/+archive/ubuntu/experimental-next",
"command": "sudo add-apt-repository ppa:canonical-hwe-team/experimental-next",
"category": "kernel",
"risk": "high"
},
"canonical-kernel-team/bootstrap": {
"description": "Bootstrap kernel PPA",
"url": "https://launchpad.net/~canonical-kernel-team/+archive/ubuntu/bootstrap",
"command": "sudo add-apt-repository ppa:canonical-kernel-team/bootstrap",
"category": "kernel",
"risk": "high"
},
"damentz/liquorix": {
"description": "Kernel Liquorix (desktop, gaming, multimedia)",
"url": "https://launchpad.net/~damentz/+archive/ubuntu/liquorix",
"command": "sudo add-apt-repository ppa:damentz/liquorix",
"category": "kernel",
"risk": "medium"
},
"ubuntu-tegra/kernel-daily": {
"description": "NVIDIA Tegra IGX (ARM) daily builds",
"url": "https://launchpad.net/~ubuntu-tegra/+archive/ubuntu/kernel-daily",
"command": "sudo add-apt-repository ppa:ubuntu-tegra/kernel-daily",
"category": "kernel",
"risk": "high"
},
"arighi/sched-ext": {
"description": "Support sched_ext (BPF scheduler)",
"url": "https://launchpad.net/~arighi/+archive/ubuntu/sched-ext",
"command": "sudo add-apt-repository ppa:arighi/sched-ext",
"category": "scheduler",
"risk": "high"
},
"graphics-drivers/ppa": {
"description": "NVIDIA graphics drivers",
"url": "https://launchpad.net/~graphics-drivers/+archive/ubuntu/ppa",
"command": "sudo add-apt-repository ppa:graphics-drivers/ppa",
"category": "graphics",
"risk": "medium"
},
"ubuntu-toolchain-r/test": {
"description": "GCC/G++ bleeding edge toolchain",
"url": "https://launchpad.net/~ubuntu-toolchain-r/+archive/ubuntu/test",
"command": "sudo add-apt-repository ppa:ubuntu-toolchain-r/test",
"category": "toolchain",
"risk": "medium"
},
"deadsnakes/ppa": {
"description": "Versions Python additionnelles",
"url": "https://launchpad.net/~deadsnakes/+archive/ubuntu/ppa",
"command": "sudo add-apt-repository ppa:deadsnakes/ppa",
"category": "python",
"risk": "low"
},
"git-core/ppa": {
"description": "Dernières versions de Git",
"url": "https://launchpad.net/~git-core/+archive/ubuntu/ppa",
"command": "sudo add-apt-repository ppa:git-core/ppa",
"category": "vcs",
"risk": "low"
},
"ondrej/php": {
"description": "PHP versions récentes",
"url": "https://launchpad.net/~ondrej/+archive/ubuntu/php",
"command": "sudo add-apt-repository ppa:ondrej/php",
"category": "php",
"risk": "low"
},
"ondrej/nginx": {
"description": "Nginx mainline",
"url": "https://launchpad.net/~ondrej/+archive/ubuntu/nginx",
"command": "sudo add-apt-repository ppa:ondrej/nginx",
"category": "web",
"risk": "low"
},
"neovim-ppa/unstable": {
"description": "Neovim unstable",
"url": "https://launchpad.net/~neovim-ppa/+archive/ubuntu/unstable",
"command": "sudo add-apt-repository ppa:neovim-ppa/unstable",
"category": "editor",
"risk": "low"
},
}

UBUNTU_KERNELS = {
"generic": "linux-image-generic",
"lowlatency": "linux-image-lowlatency",
"kvm": "linux-image-kvm",
"aws": "linux-image-aws",
"azure": "linux-image-azure",
"gcp": "linux-image-gcp",
"oracle": "linux-image-oracle",
"oem": "linux-image-oem-22.04",
"hwe": "linux-image-generic-hwe-22.04",
"raspi": "linux-image-raspi",
"liquorix": "linux-image-liquorix-amd64",
}

SNAP_PACKAGES = {
"firefox": "Mozilla Firefox (snap)",
"chromium": "Chromium (snap)",
"code": "Visual Studio Code",
"slack": "Slack",
"discord": "Discord",
"spotify": "Spotify",
"docker": "Docker",
"kubectl": "Kubernetes kubectl",
"helm": "Helm",
"terraform": "Terraform",
"go": "Go language",
"node": "Node.js",
"vlc": "VLC",
"gimp": "GIMP",
"blender": "Blender",
}

FLATPAK_APPS = {
"org.mozilla.firefox": "Firefox (Flatpak)",
"com.visualstudio.code": "VS Code (Flatpak)",
"com.spotify.Client": "Spotify (Flatpak)",
"org.gimp.GIMP": "GIMP (Flatpak)",
"org.blender.Blender": "Blender (Flatpak)",
"com.discordapp.Discord": "Discord (Flatpak)",
"org.videolan.VLC": "VLC (Flatpak)",
"org.libreoffice.LibreOffice": "LibreOffice (Flatpak)",
}

SYSTEMD_SERVICES = {
"systemd-networkd": {"state": "active", "enabled": True, "description": "Network Manager"},
"systemd-resolved": {"state": "active", "enabled": True, "description": "DNS Resolver"},
"NetworkManager": {"state": "active", "enabled": True, "description": "Network Manager"},
"ssh": {"state": "inactive", "enabled": False, "description": "OpenSSH Server"},
"apache2": {"state": "inactive", "enabled": False, "description": "Apache Web Server"},
"nginx": {"state": "inactive", "enabled": False, "description": "Nginx Web Server"},
"docker": {"state": "inactive", "enabled": False, "description": "Docker Engine"},
"cron": {"state": "active", "enabled": True, "description": "Cron Scheduler"},
"bluetooth": {"state": "active", "enabled": True, "description": "Bluetooth"},
"cups": {"state": "active", "enabled": True, "description": "Print Server"},
"ufw": {"state": "active", "enabled": True, "description": "Uncomplicated Firewall"},
"snapd": {"state": "active", "enabled": True, "description": "Snap Daemon"},
"flatpak": {"state": "active", "enabled": True, "description": "Flatpak"},
}


# ══════════════════════════════════════════════════════════════════════════════
# TYPES DE BASE
# ══════════════════════════════════════════════════════════════════════════════

class FileType(Enum):
FILE = "file"
DIRECTORY = "directory"
SYMLINK = "symlink"
DEVICE = "device"


@dataclass
class VirtualFile:
name: str
content: bytes = b""
file_type: FileType = FileType.FILE
permissions: int = 0o644
owner: str = "user"
group: str = "user"
created_at: float = field(default_factory=time.time)
modified_at: float = field(default_factory=time.time)
accessed_at: float = field(default_factory=time.time)
target: str = ""
children: Optional[Dict[str, "VirtualFile"]] = None

def __post_init__(self):
if self.file_type == FileType.DIRECTORY:
self.children = {}

@property
def size(self) -> int:
if self.file_type == FileType.DIRECTORY:
return 4096
return len(self.content)

@property
def is_directory(self) -> bool:
return self.file_type == FileType.DIRECTORY

@property
def is_file(self) -> bool:
return self.file_type == FileType.FILE

def read(self) -> bytes:
self.accessed_at = time.time()
return self.content

def write(self, data: bytes):
self.content = data
self.modified_at = time.time()


@dataclass
class CommandResult:
stdout: str = ""
stderr: str = ""
exit_code: int = 0
duration_ms: float = 0.0
command: str = ""

def to_dict(self) -> Dict[str, Any]:
return {
"command": self.command,
"stdout": self.stdout,
"stderr": self.stderr,
"exit_code": self.exit_code,
"duration_ms": round(self.duration_ms, 2),
"success": self.exit_code == 0,
}

def to_json(self) -> str:
return json.dumps(self.to_dict(), ensure_ascii=False, indent=2)

def __str__(self) -> str:
parts = []
if self.stdout:
parts.append(self.stdout)
if self.stderr:
parts.append(f"[stderr] {self.stderr}")
if self.exit_code != 0:
parts.append(f"[exit code: {self.exit_code}]")
return "\n".join(parts)


# ══════════════════════════════════════════════════════════════════════════════
# SYSTÈME DE FICHIERS VIRTUEL (FHS)
# ══════════════════════════════════════════════════════════════════════════════

class VirtualFileSystem:
def __init__(self):
self.root = VirtualFile("/", file_type=FileType.DIRECTORY, permissions=0o755)
self.current_dir = "/"
self._init_fhs()
self._init_standard_files()

def _init_fhs(self):
"""Filesystem Hierarchy Standard complet"""
standard = [
"/home", "/home/user",
"/tmp", "/var", "/var/log", "/var/cache", "/var/lib",
"/etc", "/etc/apt", "/etc/apt/sources.list.d",
"/etc/systemd", "/etc/network",
"/usr", "/usr/bin", "/usr/lib", "/usr/share", "/usr/local",
"/opt", "/root", "/dev", "/proc", "/sys", "/bin", "/sbin",
"/lib", "/lib64", "/mnt", "/media", "/srv", "/boot",
"/etc/ssl", "/etc/ssl/certs", "/etc/security",
]
for path in standard:
self.mkdir_p(path)

def _init_standard_files(self):
self.write_file("/etc/hostname", b"nexus-mental\n")
self.write_file("/etc/os-release", b"""NAME="Nexus Mental OS"
VERSION="2.0.0"
ID=nexus
ID_LIKE=ubuntu debian
VERSION_CODENAME=mental
HOME_URL="https://github.com/Aissamohammedi88"
AUTHOR="Aissa Mohammedi (DGK)"
""")
self.write_file("/etc/lsb-release", b"""DISTRIB_ID=Nexus
DISTRIB_RELEASE=2.0.0
DISTRIB_CODENAME=mental
DISTRIB_DESCRIPTION="Nexus Mental OS 2.0.0"
""")
self.write_file("/etc/passwd", b"""root:x:0:0:root:/root:/bin/bash
daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin
user:x:1000:1000:user:/home/user:/bin/bash
""")
self.write_file("/etc/group", b"""root:x:0:
sudo:x:27:user
user:x:1000:
docker:x:999:user
""")
self.write_file("/etc/apt/sources.list", b"""deb http://archive.ubuntu.com/ubuntu/ jammy main restricted
deb http://archive.ubuntu.com/ubuntu/ jammy-updates main restricted
deb http://archive.ubuntu.com/ubuntu/ jammy universe
deb http://security.ubuntu.com/ubuntu jammy-security main restricted
""")
self.write_file("/etc/apt/sources.list.d/nexus-ppa.list", b"# Nexus custom PPAs\n")
self.write_file("/proc/version", b"Linux version 6.8.0-nexus (gcc 13.2.0) #1 SMP PREEMPT_DYNAMIC\n")
self.write_file("/proc/cpuinfo", b"""processor : 0
vendor_id : GenuineIntel
cpu family : 6
model : 142
model name : Intel(R) Core(TM) i7-8550U CPU @ 1.80GHz
cpu MHz : 1800.000
cache size : 8192 KB
""")
self.write_file("/proc/meminfo", b"""MemTotal: 7864320 kB
MemFree: 2097152 kB
MemAvailable: 3145728 kB
Buffers: 262144 kB
Cached: 1572864 kB
SwapTotal: 2097152 kB
SwapFree: 2097152 kB
""")
self.write_file("/home/user/README.md", b"""# NEXUS MENTAL TERMINAL v2.0.0

Bienvenue dans le terminal mental NEXUS.

Ce terminal VIRTUEL simule :
- Un shell bash complet (60+ commandes)
- Un système de fichiers en RAM (FHS complet)
- Un interpréteur Python (REPL persistant)
- Un gestionnaire de paquets apt
- Un gestionnaire de paquets snap
- Un gestionnaire de paquets flatpak
- Un gestionnaire systemd (systemctl)
- Les PPAs Ubuntu (kernel, drivers, tools)
- Les noyaux Linux virtuels

## Aucun accès au système réel.

Tape 'help' pour la liste complète.
""")
self.write_file("/home/user/.bashrc", b"""# ~/.bashrc - NEXUS MENTAL
export PS1='\\u@\\h:\\w\\$ '
alias ll='ls -la'
alias la='ls -a'
alias l='ls -CF'
alias ..='cd ..'
alias ...='cd ../..'
alias grep='grep --color=auto'
""")
self.write_file("/etc/security/limits.conf", b"""# NEXUS limits
* soft nofile 65536
* hard nofile 65536
""")

# ─── Utilitaires ───
def normalize_path(self, path: str) -> str:
if not path:
return self.current_dir
if path == "~" or path.startswith("~/"):
path = "/home/user" + path[1:]
if path.startswith("/"):
full = path
else:
full = os.path.join(self.current_dir, path)
parts = []
for part in full.split("/"):
if part == "" or part == ".":
continue
elif part == "..":
if parts:
parts.pop()
else:
parts.append(part)
return "/" + "/".join(parts)

def get_file(self, path: str) -> Optional[VirtualFile]:
path = self.normalize_path(path)
if path == "/":
return self.root
parts = [p for p in path.split("/") if p]
current = self.root
for part in parts:
if not current.is_directory:
return None
if part not in current.children:
return None
current = current.children[part]
return current

def exists(self, path: str) -> bool:
return self.get_file(path) is not None

def is_dir(self, path: str) -> bool:
f = self.get_file(path)
return f is not None and f.is_directory

def is_file(self, path: str) -> bool:
f = self.get_file(path)
return f is not None and f.is_file

def mkdir(self, path: str) -> bool:
path = self.normalize_path(path)
if path == "/" or self.exists(path):
return False
parent = self.get_file(os.path.dirname(path))
if not parent or not parent.is_directory:
return False
name = os.path.basename(path)
parent.children[name] = VirtualFile(name=name, file_type=FileType.DIRECTORY, permissions=0o755)
return True

def mkdir_p(self, path: str) -> bool:
path = self.normalize_path(path)
parts = [p for p in path.split("/") if p]
current = self.root
for part in parts:
if part not in current.children:
current.children[part] = VirtualFile(name=part, file_type=FileType.DIRECTORY, permissions=0o755)
current = current.children[part]
return True

def write_file(self, path: str, content: bytes) -> bool:
path = self.normalize_path(path)
parent = self.get_file(os.path.dirname(path))
if not parent or not parent.is_directory:
return False
name = os.path.basename(path)
if name in parent.children and parent.children[name].is_directory:
return False
if name not in parent.children:
parent.children[name] = VirtualFile(name=name)
parent.children[name].write(content)
return True

def read_file(self, path: str) -> Optional[bytes]:
f = self.get_file(path)
if f and f.is_file:
return f.read()
return None

def rm(self, path: str) -> bool:
path = self.normalize_path(path)
if path == "/":
return False
parent = self.get_file(os.path.dirname(path))
if not parent:
return False
name = os.path.basename(path)
if name in parent.children:
del parent.children[name]
return True
return False

def rmdir(self, path: str) -> bool:
f = self.get_file(path)
if f and f.is_directory and not f.children:
return self.rm(path)
return False

def list_dir(self, path: str) -> Optional[List[str]]:
f = self.get_file(path)
if f and f.is_directory:
return sorted(f.children.keys())
return None

def mv(self, src: str, dst: str) -> bool:
f = self.get_file(src)
if not f:
return False
src_norm = self.normalize_path(src)
dst_norm = self.normalize_path(dst)
parent = self.get_file(os.path.dirname(dst_norm))
if not parent:
return False
dst_name = os.path.basename(dst_norm)
parent.children[dst_name] = f
f.name = dst_name
if src_norm != dst_norm:
self.rm(src_norm)
return True

def cp(self, src: str, dst: str) -> bool:
f = self.get_file(src)
if not f:
return False
content = f.read() if f.is_file else b""
return self.write_file(dst, content)


# ══════════════════════════════════════════════════════════════════════════════
# APT SIMULÉ (Ubuntu Package Manager)
# ══════════════════════════════════════════════════════════════════════════════

class MentalApt:
"""Gestionnaire de paquets apt simulé"""

def __init__(self, vfs: VirtualFileSystem):
self.vfs = vfs
self.installed: Dict[str, str] = {
"bash": "5.2.21-2ubuntu4",
"coreutils": "9.4-3ubuntu6",
"python3": "3.12.3-0ubuntu2",
"python3-pip": "24.0+dfsg-1ubuntu1",
"curl": "8.5.0-2ubuntu10",
"wget": "1.21.4-1ubuntu4",
"git": "1:2.43.0-1ubuntu7",
"vim": "2:9.1.0016-1ubuntu7",
"nano": "7.2-2ubuntu0.1",
"htop": "3.3.0-4build1",
"ripgrep": "14.1.0-1build1",
"fd-find": "9.0.0-1build1",
"bat": "0.24.0-1build1",
"exa": "0.10.1-1",
}
self.available: Dict[str, str] = {
"linux-image-generic": "6.8.0-31.31",
"linux-headers-generic": "6.8.0-31.31",
"linux-image-lowlatency": "6.8.0-31.31",
"linux-image-liquorix-amd64": "6.8-7",
"linux-headers-liquorix-amd64": "6.8-7",
"docker.io": "24.0.7-0ubuntu4",
"docker-compose": "1.29.2-3",
"nginx": "1.24.0-2ubuntu2",
"apache2": "2.4.58-1ubuntu8",
"postgresql": "16+257build1",
"mysql-server": "8.0.36-2ubuntu3",
"redis-server": "5:7.0.15-1build2",
"nodejs": "18.19.1+dfsg-6ubuntu5",
"npm": "9.2.0~ds1-3",
"golang": "2:1.22~2build1",
"rustc": "1.75.0+dfsg0ubuntu1",
"cargo": "1.75.0+dfsg0ubuntu1",
"build-essential": "12.10ubuntu1",
"gcc": "4:13.2.0-7ubuntu1",
"g++": "4:13.2.0-7ubuntu1",
"clang": "1:17.0-3",
"llvm": "1:17.0-3",
"cmake": "3.28.3-1build2",
"make": "4.3-4.1build2",
"jq": "1.7.1-3build1",
"tree": "2.1.1-2",
"neofetch": "7.1.0-4",
"fastfetch": "2.4.0-1",
"openssh-server": "1:9.6p1-3ubuntu13",
"openssh-client": "1:9.6p1-3ubuntu13",
"ufw": "0.36.2-6",
"fail2ban": "1.0.2-3",
"wireguard": "1.0.20210914-1ubuntu4",
"tor": "0.4.8.10-1",
"obs-studio": "30.0.2-1",
"gimp": "2.10.36-3ubuntu1",
"blender": "4.0.2+dfsg-1ubuntu1",
"ffmpeg": "7:6.1.1-3ubuntu1",
"vlc": "3.0.20-3build1",
"neovim": "0.9.5-6",
"emacs": "1:29.3+1-2",
"code": "1.88.1-1712771838",
}
self.available_ppas = UBUNTU_PPA_DATABASE.copy()
self.installed_ppas: List[str] = []

def install(self, packages: List[str]) -> CommandResult:
r = CommandResult()
r.stdout = "Reading package lists... Done\n"
r.stdout += "Building dependency tree... Done\n"
r.stdout += "Reading state information... Done\n"
r.stdout += "\n"

for pkg in packages:
if pkg in self.installed:
r.stdout += f"{pkg} is already the newest version.\n"
elif pkg in self.available:
version = self.available[pkg]
self.installed[pkg] = version
r.stdout += f"The following NEW packages will be installed:\n"
r.stdout += f" {pkg}\n"
r.stdout += f"\nSetting up {pkg} ({version}) ...\n"
else:
r.stderr += f"E: Unable to locate package {pkg}\n"
r.exit_code = 100

if r.exit_code == 0:
r.stdout += "\nDone.\n"

return r

def remove(self, packages: List[str]) -> CommandResult:
r = CommandResult()
for pkg in packages:
if pkg in self.installed:
del self.installed[pkg]
r.stdout += f"Removing {pkg} ...\n"
else:
r.stderr += f"E: Package '{pkg}' is not installed\n"
r.exit_code = 100
r.stdout += "Done.\n"
return r

def update(self) -> CommandResult:
r = CommandResult()
r.stdout = "Hit:1 http://archive.ubuntu.com/ubuntu jammy InRelease\n"
r.stdout += "Get:2 http://security.ubuntu.com/ubuntu jammy-security InRelease\n"
r.stdout += "Reading package lists... Done\n"
return r

def upgrade(self) -> CommandResult:
r = CommandResult()
r.stdout = "Reading package lists... Done\n"
r.stdout += "Calculating upgrade... Done\n"
r.stdout += "0 upgraded, 0 newly installed, 0 to remove.\n"
return r

def search(self, pattern: str) -> CommandResult:
r = CommandResult()
matches = []
for pkg, ver in sorted(self.available.items()):
if pattern.lower() in pkg.lower():
matches.append(pkg)
if matches:
for pkg in matches[:30]:
r.stdout += f"{pkg}/jammy {self.available[pkg]} amd64\n"
else:
r.stdout = "No packages found.\n"
return r

def show(self, pkg: str) -> CommandResult:
r = CommandResult()
if pkg in self.installed or pkg in self.available:
version = self.installed.get(pkg) or self.available.get(pkg)
r.stdout = f"Package: {pkg}\n"
r.stdout += f"Version: {version}\n"
r.stdout += f"Architecture: amd64\n"
r.stdout += f"Description: Virtual package from NEXUS mental apt\n"
else:
r.stderr = f"E: No packages found\n"
r.exit_code = 1
return r

def list_installed(self) -> CommandResult:
r = CommandResult()
r.stdout = "Listing installed packages...\n\n"
for pkg, ver in sorted(self.installed.items()):
r.stdout += f"{pkg}/jammy,now {ver} amd64 [installed]\n"
return r

def add_ppa(self, ppa: str) -> CommandResult:
r = CommandResult()
ppa_clean = ppa.replace("ppa:", "")
if ppa_clean in self.available_ppas:
self.installed_ppas.append(ppa_clean)
info = self.available_ppas[ppa_clean]
r.stdout = f"Adding PPA: {ppa_clean}\n"
r.stdout += f"Description: {info['description']}\n"
r.stdout += f"URL: {info['url']}\n"
r.stdout += f"Risk: {info['risk']}\n"
r.stdout += "More info: " + info["url"] + "\n"
r.stdout += "\nPress [ENTER] to continue or Ctrl-C to cancel.\n"
r.stdout += f"Executing: add-apt-repository {ppa_clean}\n"
r.stdout += "\n"
# Écrire dans sources.list.d
path = f"/etc/apt/sources.list.d/{ppa_clean.replace('/', '-')}.list"
content = f"deb https://ppa.launchpadcontent.net/{ppa_clean}/ubuntu jammy main\n"
self.vfs.write_file(path, content.encode())
r.stdout += f"OK\n"
else:
r.stderr = f"Error: PPA '{ppa_clean}' not found in NEXUS database\n"
r.exit_code = 1
return r

def list_ppas(self) -> CommandResult:
r = CommandResult()
r.stdout = "Available PPAs in NEXUS database:\n\n"
by_cat = defaultdict(list)
for ppa, info in self.available_ppas.items():
by_cat[info["category"]].append(ppa)

for cat in sorted(by_cat.keys()):
r.stdout += f"[{cat.upper()}]\n"
for ppa in sorted(by_cat[cat]):
info = self.available_ppas[ppa]
r.stdout += f" {ppa}\n"
r.stdout += f" → {info['description']}\n"
r.stdout += "\n"
return r


# ══════════════════════════════════════════════════════════════════════════════
# SNAP SIMULÉ
# ══════════════════════════════════════════════════════════════════════════════

class MentalSnap:
def __init__(self, vfs: VirtualFileSystem):
self.vfs = vfs
self.installed: Dict[str, str] = {
"core22": "20240528",
"snapd": "2.62",
"firefox": "126.0",
"code": "1.88.1",
}

def install(self, packages: List[str]) -> CommandResult:
r = CommandResult()
for pkg in packages:
if pkg in SNAP_PACKAGES:
self.installed[pkg] = "latest"
r.stdout += f"{pkg} installed\n"
else:
r.stderr += f"error: snap \"{pkg}\" not found\n"
r.exit_code = 1
return r

def remove(self, packages: List[str]) -> CommandResult:
r = CommandResult()
for pkg in packages:
if pkg in self.installed:
del self.installed[pkg]
r.stdout += f"{pkg} removed\n"
else:
r.stderr += f"error: snap \"{pkg}\" is not installed\n"
r.exit_code = 1
return r

def list_installed(self) -> CommandResult:
r = CommandResult()
r.stdout = "Name Version Rev Tracking Publisher Notes\n"
for pkg, ver in sorted(self.installed.items()):
r.stdout += f"{pkg:<10}{ver:<11}latest stable canonical✓ -\n"
return r

def find(self, pattern: str) -> CommandResult:
r = CommandResult()
matches = [k for k in SNAP_PACKAGES.keys() if pattern.lower() in k.lower()]
if matches:
r.stdout = "Name Version Publisher Notes Summary\n"
for m in matches:
r.stdout += f"{m:<10}latest canonical✓ - {SNAP_PACKAGES[m]}\n"
else:
r.stdout = "No matching snaps found.\n"
return r


# ══════════════════════════════════════════════════════════════════════════════
# FLATPAK SIMULÉ
# ══════════════════════════════════════════════════════════════════════════════

class MentalFlatpak:
def __init__(self, vfs: VirtualFileSystem):
self.vfs = vfs
self.installed: Dict[str, str] = {}
self.remotes: Dict[str, str] = {"flathub": "https://dl.flathub.org/repo/"}

def install(self, apps: List[str]) -> CommandResult:
r = CommandResult()
for app in apps:
if app in FLATPAK_APPS:
self.installed[app] = "latest"
r.stdout += f"Installing {app}...\n"
r.stdout += f" {FLATPAK_APPS[app]}\n"
r.stdout += f" Done.\n"
else:
r.stderr += f"error: {app} not found\n"
r.exit_code = 1
return r

def remove(self, apps: List[str]) -> CommandResult:
r = CommandResult()
for app in apps:
if app in self.installed:
del self.installed[app]
r.stdout += f"Uninstalled {app}\n"
else:
r.stderr += f"error: {app} not installed\n"
r.exit_code = 1
return r

def list_installed(self) -> CommandResult:
r = CommandResult()
if not self.installed:
r.stdout = "No flatpak applications installed.\n"
return r
r.stdout = "Ref Options\n"
for app in sorted(self.installed.keys()):
r.stdout += f"{app:<48}system,current\n"
return r

def list_remotes(self) -> CommandResult:
r = CommandResult()
r.stdout = "Name Title URL\n"
for name, url in self.remotes.items():
r.stdout += f"{name:<7} {name:<7} {url}\n"
return r


# ══════════════════════════════════════════════════════════════════════════════
# SYSTEMD SIMULÉ
# ══════════════════════════════════════════════════════════════════════════════

class MentalSystemd:
def __init__(self, vfs: VirtualFileSystem):
self.vfs = vfs
self.services = {k: v.copy() for k, v in SYSTEMD_SERVICES.items()}

def start(self, service: str) -> CommandResult:
r = CommandResult()
if service in self.services:
self.services[service]["state"] = "active"
r.stdout = f"Started {service}.\n"
else:
r.stderr = f"Failed to start {service}.service: Unit {service}.service not found.\n"
r.exit_code = 5
return r

def stop(self, service: str) -> CommandResult:
r = CommandResult()
if service in self.services:
self.services[service]["state"] = "inactive"
r.stdout = f"Stopped {service}.\n"
else:
r.stderr = f"Failed to stop {service}.service: Unit {service}.service not found.\n"
r.exit_code = 5
return r

def restart(self, service: str) -> CommandResult:
self.stop(service)
return self.start(service)

def enable(self, service: str) -> CommandResult:
r = CommandResult()
if service in self.services:
self.services[service]["enabled"] = True
r.stdout = f"Created symlink /etc/systemd/system/multi-user.target.wants/{service}.service\n"
else:
r.stderr = f"Failed to enable {service}.service: Unit not found.\n"
r.exit_code = 5
return r

def disable(self, service: str) -> CommandResult:
r = CommandResult()
if service in self.services:
self.services[service]["enabled"] = False
r.stdout = f"Removed /etc/systemd/system/multi-user.target.wants/{service}.service\n"
else:
r.exit_code = 5
return r

def status(self, service: str) -> CommandResult:
r = CommandResult()
if service in self.services:
s = self.services[service]
r.stdout = f"● {service}.service - {s['description']}\n"
r.stdout += f" Loaded: loaded (/lib/systemd/system/{service}.service; "
r.stdout += f"{'enabled' if s['enabled'] else 'disabled'}; preset: enabled)\n"
r.stdout += f" Active: {s['state']} (running)\n"
r.stdout += f" Docs: man:{service}(8)\n"
r.stdout += f" Process: 1234 ExecStart=/usr/sbin/{service} (code=exited, status=0/SUCCESS)\n"
r.stdout += f" Main PID: 1234 ({service})\n"
r.stdout += f" Tasks: 4 (limit: 4915)\n"
r.stdout += f" Memory: 12.4M\n"
r.stdout += f" CPU: 234ms\n"
else:
r.stderr = f"Unit {service}.service could not be found.\n"
r.exit_code = 4
return r

def list_units(self, type_filter: str = "service") -> CommandResult:
r = CommandResult()
r.stdout = f"UNIT LOAD ACTIVE SUB DESCRIPTION\n"
for name, info in sorted(self.services.items()):
state = "active" if info["state"] == "active" else "inactive"
sub = "running" if state == "active" else "dead"
r.stdout += f"{name + '.service':<30}loaded {state:<7}{sub:<8} {info['description']}\n"
return r

def journalctl(self, args: List[str]) -> CommandResult:
r = CommandResult()
now = datetime.datetime.now()
r.stdout = f"-- Logs begin at {now.strftime('%Y-%m-%d %H:%M:%S')} --\n"
for i in range(10):
ts = now - datetime.timedelta(seconds=i * 30)
r.stdout += f"{ts.strftime('%b %d %H:%M:%S')} nexus-mental systemd[1]: Sample log entry #{i+1}\n"
return r


# ══════════════════════════════════════════════════════════════════════════════
# UNIX SYSCALLS SIMULÉS
# ══════════════════════════════════════════════════════════════════════════════

class MentalSyscalls:
def __init__(self, vfs: VirtualFileSystem):
self.vfs = vfs
self.pid = random.randint(1000, 9999)
self.uid = 1000
self.gid = 1000

def uname(self, args: List[str]) -> CommandResult:
r = CommandResult()
if "-a" in args:
r.stdout = "Nexus Mental OS 2.0.0 nexus-mental 6.8.0-nexus #1 SMP x86_64 x86_64 x86_64 GNU/Linux\n"
elif "-r" in args:
r.stdout = "6.8.0-nexus\n"
elif "-m" in args:
r.stdout = "x86_64\n"
elif "-n" in args:
r.stdout = "nexus-mental\n"
elif "-s" in args:
r.stdout = "Nexus\n"
else:
r.stdout = "Nexus\n"
return r

def getpid(self) -> CommandResult:
r = CommandResult()
r.stdout = f"{self.pid}\n"
return r

def getuid(self) -> CommandResult:
r = CommandResult()
r.stdout = f"{self.uid}\n"
return r

def getgid(self) -> CommandResult:
r = CommandResult()
r.stdout = f"{self.gid}\n"
return r


# ══════════════════════════════════════════════════════════════════════════════
# SHELL BASH SIMULÉ (extrait)
# ══════════════════════════════════════════════════════════════════════════════

class MentalBash:
def __init__(self, vfs: VirtualFileSystem):
self.vfs = vfs
self.apt = MentalApt(vfs)
self.snap = MentalSnap(vfs)
self.flatpak = MentalFlatpak(vfs)
self.systemd = MentalSystemd(vfs)
self.syscalls = MentalSyscalls(vfs)

self.env: Dict[str, str] = {
"HOME": "/home/user",
"USER": "user",
"SHELL": "/bin/bash",
"PWD": "/home/user",
"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
"LANG": "fr_FR.UTF-8",
"TERM": "xterm-256color",
"HOSTNAME": "nexus-mental",
"SHELL_VERSION": VERSION,
}
self.history: List[str] = []
self.aliases: Dict[str, str] = {}

# Commandes
self.commands: Dict[str, Callable] = {
# Fichiers
"ls": self._cmd_ls,
"cd": self._cmd_cd,
"pwd": self._cmd_pwd,
"mkdir": self._cmd_mkdir,
"rmdir": self._cmd_rmdir,
"rm": self._cmd_rm,
"cp": self._cmd_cp,
"mv": self._cmd_mv,
"cat": self._cmd_cat,
"touch": self._cmd_touch,
"tree": self._cmd_tree,
"stat": self._cmd_stat,
"file": self._cmd_file,
"du": self._cmd_du,
"find": self._cmd_find,
# Texte
"echo": self._cmd_echo,
"printf": self._cmd_printf,
"head": self._cmd_head,
"tail": self._cmd_tail,
"wc": self._cmd_wc,
"grep": self._cmd_grep,
"sort": self._cmd_sort,
"uniq": self._cmd_uniq,
"rev": self._cmd_rev,
"tac": self._cmd_tac,
"nl": self._cmd_nl,
# Système
"whoami": self._cmd_whoami,
"hostname": self._cmd_hostname,
"uname": self.syscalls.uname,
"date": self._cmd_date,
"uptime": self._cmd_uptime,
"id": self._cmd_id,
"getpid": self.syscalls.getpid,
"getuid": self.syscalls.getuid,
"getgid": self.syscalls.getgid,
# Env
"env": self._cmd_env,
"export": self._cmd_export,
"set": self._cmd_set,
"unset": self._cmd_unset,
"alias": self._cmd_alias,
"history": self._cmd_history,
"clear": self._cmd_clear,
# Helpers
"which": self._cmd_which,
"type": self._cmd_type,
"true": self._cmd_true,
"false": self._cmd_false,
"sleep": self._cmd_sleep,
"seq": self._cmd_seq,
"yes": self._cmd_yes,
"exit": self._cmd_exit,
"help": self._cmd_help,
# Python
"python3": self._cmd_python3,
"python": self._cmd_python3,
"pip": self._cmd_pip,
# Network
"curl": self._cmd_curl,
"wget": self._cmd_wget,
"ping": self._cmd_ping,
# Process
"ps": self._cmd_ps,
"top": self._cmd_top,
"df": self._cmd_df,
"free": self._cmd_free,
# Hash / Crypto
"md5sum": self._cmd_md5sum,
"sha256sum": self._cmd_sha256sum,
"base64": self._cmd_base64,
# Math
"expr": self._cmd_expr,
"bc": self._cmd_bc,
"factor": self._cmd_factor,
# Divers
"uuidgen": self._cmd_uuidgen,
"cal": self._cmd_cal,
"basename": self._cmd_basename,
"dirname": self._cmd_dirname,
"readlink": self._cmd_readlink,
# ═══ NOUVEAU : APT ═══
"apt": self._cmd_apt,
"apt-get": self._cmd_apt,
"apt-cache": self._cmd_apt_cache,
"dpkg": self._cmd_dpkg,
"add-apt-repository": self._cmd_add_ppa,
# ═══ NOUVEAU : SNAP ═══
"snap": self._cmd_snap,
# ═══ NOUVEAU : FLATPAK ═══
"flatpak": self._cmd_flatpak,
# ═══ NOUVEAU : SYSTEMD ═══
"systemctl": self._cmd_systemctl,
"journalctl": self._cmd_journalctl,
"service": self._cmd_service,
}

def execute(self, command: str) -> CommandResult:
start = time.time()
result = CommandResult(command=command)
command = command.strip()
if not command or command.startswith("#"):
result.duration_ms = (time.time() - start) * 1000
return result
self.history.append(command)
try:
if "|" in command:
return self._execute_pipeline(command, start)
if ">" in command or "<" in command:
return self._execute_redirect(command, start)
if ";" in command:
for cmd in command.split(";"):
sub = self.execute(cmd.strip())
result.stdout += sub.stdout
result.stderr += sub.stderr
if sub.exit_code != 0:
result.exit_code = sub.exit_code
result.duration_ms = (time.time() - start) * 1000
return result
if "&&" in command:
for cmd in command.split("&&"):
sub = self.execute(cmd.strip())
result.stdout += sub.stdout
result.stderr += sub.stderr
if sub.exit_code != 0:
result.exit_code = sub.exit_code
break
result.duration_ms = (time.time() - start) * 1000
return result
parts = self._parse_command(command)
if not parts:
result.duration_ms = (time.time() - start) * 1000
return result
cmd_name = parts[0]
if cmd_name in self.aliases:
return self.execute(self.aliases[cmd_name] + " " + " ".join(parts[1:]))
if cmd_name in self.commands:
result = self.commands[cmd_name](parts[1:])
result.command = command
result.duration_ms = (time.time() - start) * 1000
return result
result.stderr = f"bash: {cmd_name}: command not found\n"
result.exit_code = 127
result.duration_ms = (time.time() - start) * 1000
return result
except Exception as e:
result.stderr = f"bash: error: {e}\n"
result.exit_code = 1
result.duration_ms = (time.time() - start) * 1000
return result

def _parse_command(self, command: str) -> List[str]:
try:
return shlex.split(command)
except ValueError:
return command.split()

def _execute_pipeline(self, command: str, start: float) -> CommandResult:
result = CommandResult(command=command)
parts = [p.strip() for p in command.split("|")]
input_data = ""
for part in parts:
sub = self.execute(part)
if sub.exit_code != 0:
result.exit_code = sub.exit_code
result.stderr = sub.stderr
break
input_data = sub.stdout
result.stdout = input_data
result.duration_ms = (time.time() - start) * 1000
return result

def _execute_redirect(self, command: str, start: float) -> CommandResult:
result = CommandResult(command=command)
if ">" in command:
parts = command.split(">", 1)
cmd = parts[0].strip()
target = parts[1].strip()
append = target.startswith(">")
if append:
target = target[1:].strip()
sub = self.execute(cmd)
content = sub.stdout
if append:
existing = self.vfs.read_file(target) or b""
content = existing.decode("utf-8", errors="ignore") + content
if self.vfs.write_file(target, content.encode()):
result.stdout = ""
else:
result.stderr = f"bash: {target}: cannot write\n"
result.exit_code = 1
elif "<" in command:
parts = command.split("<", 1)
cmd = parts[0].strip()
source = parts[1].strip()
content = self.vfs.read_file(source)
if content:
result.stdout = content.decode("utf-8", errors="replace")
else:
result.stderr = f"bash: {source}: no such file\n"
result.exit_code = 1
result.duration_ms = (time.time() - start) * 1000
return result

# ─── Commandes de base ───
def _cmd_ls(self, args):
r = CommandResult()
show_all = "-a" in args or "-la" in args or "-al" in args
show_long = "-l" in args or "-la" in args or "-al" in args
paths = [a for a in args if not a.startswith("-")] or ["."]
for path in paths:
listing = self.vfs.list_dir(path)
if listing is None:
f = self.vfs.get_file(path)
if f:
r.stdout += f"{f.name}\n"
else:
r.stderr += f"ls: cannot access '{path}': No such file or directory\n"
r.exit_code = 2
continue
for name in listing:
if not show_all and name.startswith("."):
continue
if show_long:
full = os.path.join(path, name)
f = self.vfs.get_file(full)
if f:
perm = "-"
for shift in (6, 3, 0):
bits = (f.permissions >> shift) & 0o7
perm += "r" if bits & 4 else "-"
perm += "w" if bits & 2 else "-"
perm += "x" if bits & 1 else "-"
date = datetime.datetime.fromtimestamp(f.modified_at).strftime("%b %d %H:%M")
r.stdout += f"{perm} 1 user user {f.size:>8} {date} {name}\n"
else:
r.stdout += f"{name}\n"
return r

def _cmd_cd(self, args):
r = CommandResult()
target = args[0] if args else "/home/user"
target = self.vfs.normalize_path(target)
if self.vfs.is_dir(target):
self.vfs.current_dir = target
self.env["PWD"] = target
else:
r.stderr = f"bash: cd: {target}: Not a directory\n"
r.exit_code = 1
return r

def _cmd_pwd(self, args):
r = CommandResult()
r.stdout = self.vfs.current_dir + "\n"
return r

def _cmd_mkdir(self, args):
r = CommandResult()
parents = "-p" in args
dirs = [a for a in args if not a.startswith("-")]
for d in dirs:
success = self.vfs.mkdir_p(d) if parents else self.vfs.mkdir(d)
if not success:
r.stderr += f"mkdir: cannot create directory '{d}': File exists\n"
r.exit_code = 1
return r

def _cmd_rmdir(self, args):
r = CommandResult()
for d in args:
if not self.vfs.rmdir(d):
r.stderr += f"rmdir: failed to remove '{d}'\n"
r.exit_code = 1
return r

def _cmd_rm(self, args):
r = CommandResult()
recursive = any("-r" in a or "-R" in a or "-rf" in a or "-fr" in a for a in args)
force = any("f" in a for a in args if a.startswith("-"))
paths = [a for a in args if not a.startswith("-")]
for p in paths:
f = self.vfs.get_file(p)
if not f:
if not force:
r.stderr += f"rm: cannot remove '{p}': No such file or directory\n"
r.exit_code = 1
continue
if f.is_directory and not recursive:
r.stderr += f"rm: cannot remove '{p}': Is a directory\n"
r.exit_code = 1
continue
self.vfs.rm(p)
return r

def _cmd_cp(self, args):
r = CommandResult()
paths = [a for a in args if not a.startswith("-")]
if len(paths) < 2:
r.stderr = "cp: missing file operand\n"
r.exit_code = 1
return r
if not self.vfs.cp(paths[0], paths[1]):
r.stderr = f"cp: cannot copy '{paths[0]}'\n"
r.exit_code = 1
return r

def _cmd_mv(self, args):
r = CommandResult()
paths = [a for a in args if not a.startswith("-")]
if len(paths) < 2:
r.stderr = "mv: missing file operand\n"
r.exit_code = 1
return r
if not self.vfs.mv(paths[0], paths[1]):
r.stderr = f"mv: cannot move '{paths[0]}'\n"
r.exit_code = 1
return r

def _cmd_cat(self, args):
r = CommandResult()
paths = [a for a in args if not a.startswith("-")]
if not paths:
r.stderr = "cat: missing file operand\n"
r.exit_code = 1
return r
for p in paths:
content = self.vfs.read_file(p)
if content is None:
r.stderr += f"cat: {p}: No such file or directory\n"
r.exit_code = 1
continue
r.stdout += content.decode("utf-8", errors="replace")
return r

def _cmd_echo(self, args):
r = CommandResult()
no_newline = "-n" in args
interpret = "-e" in args
filtered = [a for a in args if a not in ("-n", "-e")]
text = " ".join(filtered)
# Expand vars
for k, v in self.env.items():
text = text.replace(f"${k}", v)
text = text.replace(f"${{{k}}}", v)
if interpret:
text = text.replace("\\n", "\n").replace("\\t", "\t")
r.stdout = text + ("" if no_newline else "\n")
return r

def _cmd_printf(self, args):
r = CommandResult()
if not args:
return r
fmt = args[0]
values = args[1:]
try:
r.stdout = fmt % tuple(values) if values else fmt
except Exception:
r.stdout = fmt
return r

def _cmd_head(self, args):
r = CommandResult()
n = 10
paths = []
i = 0
while i < len(args):
if args[i] == "-n" and i + 1 < len(args):
try: n = int(args[i + 1])
except: pass
i += 2
else:
paths.append(args[i])
i += 1
for p in paths:
content = self.vfs.read_file(p)
if content is None:
continue
lines = content.decode("utf-8", errors="replace").split("\n")
r.stdout += "\n".join(lines[:n]) + "\n"
return r

def _cmd_tail(self, args):
r = CommandResult()
n = 10
paths = []
for a in args:
if a.startswith("-n"):
try: n = int(a[2:])
except: pass
else:
paths.append(a)
for p in paths:
content = self.vfs.read_file(p)
if content is None:
continue
lines = content.decode("utf-8", errors="replace").split("\n")
r.stdout += "\n".join(lines[-n:]) + "\n"
return r

def _cmd_wc(self, args):
r = CommandResult()
show_l = "-l" in args
show_w = "-w" in args
show_c = "-c" in args
if not (show_l or show_w or show_c):
show_l = show_w = show_c = True
paths = [a for a in args if not a.startswith("-")]
for p in paths:
content = self.vfs.read_file(p)
if content is None:
continue
text = content.decode("utf-8", errors="replace")
parts = []
if show_l: parts.append(str(len(text.split("\n"))))
if show_w: parts.append(str(len(text.split())))
if show_c: parts.append(str(len(text)))
r.stdout += " ".join(parts) + f" {p}\n"
return r

def _cmd_grep(self, args):
r = CommandResult()
ignore_case = "-i" in args
invert = "-v" in args
show_num = "-n" in args
count = "-c" in args
non_flags = [a for a in args if not a.startswith("-")]
if len(non_flags) < 2:
r.stderr = "grep: pattern and file required\n"
r.exit_code = 1
return r
pattern = non_flags[0]
paths = non_flags[1:]
flags = re.IGNORECASE if ignore_case else 0
for p in paths:
content = self.vfs.read_file(p)
if content is None:
continue
text = content.decode("utf-8", errors="replace")
matches = []
for i, line in enumerate(text.split("\n"), 1):
found = bool(re.search(pattern, line, flags))
if invert:
found = not found
if found:
matches.append(f"{i}:{line}" if show_num else line)
if count:
r.stdout += f"{len(matches)}\n"
else:
r.stdout += "\n".join(matches) + ("\n" if matches else "")
return r

def _cmd_sort(self, args):
r = CommandResult()
reverse = "-r" in args
paths = [a for a in args if not a.startswith("-")]
for p in paths:
content = self.vfs.read_file(p)
if content is None:
continue
lines = content.decode("utf-8", errors="replace").split("\n")
lines.sort(reverse=reverse)
r.stdout += "\n".join(lines)
return r

def _cmd_uniq(self, args):
r = CommandResult()
count = "-c" in args
paths = [a for a in args if not a.startswith("-")]
for p in paths:
content = self.vfs.read_file(p)
if content is None:
continue
lines = content.decode("utf-8", errors="replace").split("\n")
prev = None
n = 1
output = []
for line in lines:
if line == prev:
n += 1
else:
if prev is not None:
output.append(f"{n} {prev}" if count else prev)
prev = line
n = 1
if prev is not None:
output.append(f"{n} {prev}" if count else prev)
r.stdout += "\n".join(output) + "\n"
return r

def _cmd_touch(self, args):
r = CommandResult()
for p in args:
if not self.vfs.exists(p):
self.vfs.write_file(p, b"")
return r

def _cmd_find(self, args):
r = CommandResult()
start = "."
name_pattern = None
i = 0
while i < len(args):
if args[i] == "-name" and i + 1 < len(args):
name_pattern = args[i + 1].strip("'\"")
i += 2
elif not args[i].startswith("-"):
start = args[i]
i += 1
else:
i += 1
start = self.vfs.normalize_path(start)
files = []
def walk(path):
f = self.vfs.get_file(path)
if not f: return
if name_pattern:
if re.search(name_pattern.replace("*", ".*"), f.name):
files.append(path)
else:
files.append(path)
if f.is_directory and f.children:
for c in f.children:
walk(os.path.join(path, c))
walk(start)
r.stdout = "\n".join(files) + ("\n" if files else "")
return r

def _cmd_tree(self, args):
r = CommandResult()
start = args[0] if args else "."
def walk(path, prefix=""):
f = self.vfs.get_file(path)
if not f: return
if f.is_directory:
r.stdout += f"{prefix}{f.name}/\n"
children = sorted((f.children or {}).keys())
for i, c in enumerate(children):
is_last = (i == len(children) - 1)
walk(os.path.join(path, c), prefix + ("└── " if is_last else "├── "))
walk(start)
return r

def _cmd_stat(self, args):
r = CommandResult()
for p in args:
f = self.vfs.get_file(p)
if not f:
r.stderr += f"stat: cannot stat '{p}'\n"
r.exit_code = 1
continue
r.stdout += f" File: {f.name}\n Size: {f.size}\n Type: {f.file_type.value}\n"
return r

def _cmd_file(self, args):
r = CommandResult()
for p in args:
f = self.vfs.get_file(p)
if not f:
r.stdout += f"{p}: cannot open\n"
elif f.is_directory:
r.stdout += f"{p}: directory\n"
else:
r.stdout += f"{p}: ASCII text\n"
return r

def _cmd_du(self, args):
r = CommandResult()
paths = [a for a in args if not a.startswith("-")] or ["."]
def size_of(path):
f = self.vfs.get_file(path)
if not f: return 0
if f.is_file: return f.size
return sum(size_of(os.path.join(path, c)) for c in (f.children or {}))
for p in paths:
r.stdout += f"{size_of(p) // 1024}\t{p}\n"
return r

def _cmd_rev(self, args):
r = CommandResult()
for p in args:
content = self.vfs.read_file(p)
if content:
for line in content.decode("utf-8", errors="replace").split("\n"):
r.stdout += line[::-1] + "\n"
return r

def _cmd_tac(self, args):
r = CommandResult()
for p in args:
content = self.vfs.read_file(p)
if content:
lines = content.decode("utf-8", errors="replace").split("\n")
r.stdout += "\n".join(reversed(lines)) + "\n"
return r

def _cmd_nl(self, args):
r = CommandResult()
for p in args:
content = self.vfs.read_file(p)
if content:
for i, line in enumerate(content.decode("utf-8", errors="replace").split("\n"), 1):
r.stdout += f" {i:>4} {line}\n"
return r

# ─── Système ───
def _cmd_whoami(self, args):
r = CommandResult()
r.stdout = "user\n"
return r

def _cmd_hostname(self, args):
r = CommandResult()
r.stdout = "nexus-mental\n"
return r

def _cmd_date(self, args):
r = CommandResult()
if args and args[0].startswith("+"):
r.stdout = datetime.datetime.now().strftime(args[0][1:]) + "\n"
else:
r.stdout = datetime.datetime.now().strftime("%a %b %d %H:%M:%S %Z %Y") + "\n"
return r

def _cmd_uptime(self, args):
r = CommandResult()
r.stdout = " 12:00:00 up 1 day, 0:00, 1 user, load average: 0.15, 0.10, 0.05\n"
return r

def _cmd_id(self, args):
r = CommandResult()
r.stdout = "uid=1000(user) gid=1000(user) groups=1000(user),27(sudo),999(docker)\n"
return r

def _cmd_env(self, args):
r = CommandResult()
for k, v in sorted(self.env.items()):
r.stdout += f"{k}={v}\n"
return r

def _cmd_export(self, args):
r = CommandResult()
for arg in args:
if "=" in arg:
k, v = arg.split("=", 1)
self.env[k] = v
return r

def _cmd_set(self, args):
return self._cmd_env(args)

def _cmd_unset(self, args):
r = CommandResult()
for k in args:
self.env.pop(k, None)
return r

def _cmd_alias(self, args):
r = CommandResult()
for arg in args:
if "=" in arg:
k, v = arg.split("=", 1)
self.aliases[k] = v.strip("'\"")
return r

def _cmd_history(self, args):
r = CommandResult()
for i, cmd in enumerate(self.history, 1):
r.stdout += f" {i:>4} {cmd}\n"
return r

def _cmd_clear(self, args):
r = CommandResult()
r.stdout = "\033[2J\033[H"
return r

def _cmd_which(self, args):
r = CommandResult()
for cmd in args:
if cmd in self.commands:
r.stdout += f"/usr/bin/{cmd}\n"
else:
r.exit_code = 1
return r

def _cmd_type(self, args):
r = CommandResult()
for cmd in args:
if cmd in self.commands:
r.stdout += f"{cmd} is /usr/bin/{cmd}\n"
else:
r.exit_code = 1
return r

def _cmd_true(self, args):
return CommandResult()

def _cmd_false(self, args):
r = CommandResult()
r.exit_code = 1
return r

def _cmd_sleep(self, args):
r = CommandResult()
try:
if args: time.sleep(min(float(args[0]), 5.0))
except: pass
return r

def _cmd_seq(self, args):
r = CommandResult()
try:
if len(args) == 1:
for i in range(1, int(args[0]) + 1):
r.stdout += f"{i}\n"
elif len(args) >= 2:
for i in range(int(args[0]), int(args[1]) + 1):
r.stdout += f"{i}\n"
except: pass
return r

def _cmd_yes(self, args):
r = CommandResult()
msg = args[0] if args else "y"
r.stdout = (msg + "\n") * 50
return r

def _cmd_exit(self, args):
r = CommandResult()
r.stdout = "exit\n"
return r

def _cmd_help(self, args):
r = CommandResult()
r.stdout = f"""
NEXUS MENTAL TERMINAL v{VERSION} — Commandes disponibles

═══ FICHIERS ═══
ls, cd, pwd, mkdir, rmdir, rm, cp, mv, cat, touch
tree, stat, file, du, find

═══ TEXTE ═══
echo, printf, head, tail, wc, grep, sort, uniq, rev, tac, nl

═══ SYSTÈME ═══
whoami, hostname, uname, date, uptime, id, getpid, getuid, getgid
ps, top, df, free, env, export, set, unset, alias, history, clear

═══ UBUNTU/UNIX (NEW) ═══
apt, apt-get, apt-cache, dpkg, add-apt-repository
snap, flatpak
systemctl, journalctl, service

═══ PYTHON ═══
python3, python, pip

═══ HASH / CRYPTO ═══
md5sum, sha256sum, base64

═══ MATH ═══
expr, bc, factor

═══ DIVERS ═══
uuidgen, cal, basename, dirname, readlink
which, type, true, false, sleep, seq, yes, exit, help

═══ EXEMPLES UBUNTU ═══
apt install nginx
apt list
apt show docker.io
apt search python
add-apt-repository ppa:canonical-kernel-team/unstable
apt list-ppas
snap install firefox
snap list
flatpak install org.gimp.GIMP
systemctl status docker
systemctl start nginx
"""
return r

# ─── APT ───
def _cmd_apt(self, args):
if not args:
return CommandResult(stdout="apt: missing command\n")
sub = args[0]
rest = args[1:]
if sub in ("install", "add"):
return self.apt.install(rest)
elif sub in ("remove", "purge"):
return self.apt.remove(rest)
elif sub == "update":
return self.apt.update()
elif sub in ("upgrade", "full-upgrade"):
return self.apt.upgrade()
elif sub == "search":
return self.apt.search(rest[0] if rest else "")
elif sub == "show":
return self.apt.show(rest[0] if rest else "")
elif sub == "list":
if rest and rest[0] == "--installed":
return self.apt.list_installed()
elif rest and rest[0] == "ppas":
return self.apt.list_ppas()
else:
return self.apt.list_installed()
elif sub in ("list-ppas", "ppas"):
return self.apt.list_ppas()
else:
return CommandResult(stdout=f"apt: unknown command '{sub}'\n")

def _cmd_apt_cache(self, args):
if not args:
return CommandResult(stdout="apt-cache: missing command\n")
sub = args[0]
rest = args[1:]
if sub == "search":
return self.apt.search(rest[0] if rest else "")
elif sub == "show":
return self.apt.show(rest[0] if rest else "")
elif sub == "policy":
if rest:
r = CommandResult()
pkg = rest[0]
if pkg in self.apt.available:
r.stdout = f"{pkg}:\n Installed: (none)\n Candidate: {self.apt.available[pkg]}\n"
else:
r.stdout = f"{pkg}: Not found\n"
return r
return CommandResult(stdout="apt-cache: unknown command\n")

def _cmd_dpkg(self, args):
r = CommandResult()
if not args:
r.stdout = "dpkg: need an action option\n"
return r
if args[0] == "-l":
r.stdout = "Desired=Unknown/Install/Remove/Purge/Hold\n"
r.stdout += "||/ Name Version Architecture Description\n"
r.stdout += "+++-==============-==============-============-===========\n"
for pkg, ver in sorted(self.apt.installed.items()):
r.stdout += f"ii {pkg:<15}{ver:<15}amd64 {pkg}\n"
elif args[0] == "-i":
if len(args) > 1:
return self.apt.install([args[1]])
return r

def _cmd_add_ppa(self, args):
r = CommandResult()
if not args:
r.stderr = "add-apt-repository: missing PPA\n"
r.exit_code = 1
return r
ppa = args[-1]
return self.apt.add_ppa(ppa)

# ─── SNAP ───
def _cmd_snap(self, args):
if not args:
return CommandResult(stdout="snap: missing command\n")
sub = args[0]
rest = args[1:]
if sub == "install":
return self.snap.install(rest)
elif sub == "remove":
return self.snap.remove(rest)
elif sub == "list":
return self.snap.list_installed()
elif sub == "find":
return self.snap.find(rest[0] if rest else "")
return CommandResult(stdout=f"snap: unknown command '{sub}'\n")

# ─── FLATPAK ───
def _cmd_flatpak(self, args):
if not args:
return CommandResult(stdout="flatpak: missing command\n")
sub = args[0]
rest = args[1:]
if sub == "install":
return self.flatpak.install(rest)
elif sub == "remove":
return self.flatpak.remove(rest)
elif sub in ("list", "list-installed"):
return self.flatpak.list_installed()
elif sub == "remotes":
return self.flatpak.list_remotes()
return CommandResult(stdout=f"flatpak: unknown command '{sub}'\n")

# ─── SYSTEMD ───
def _cmd_systemctl(self, args):
if not args:
return CommandResult(stdout="systemctl: missing command\n")
sub = args[0]
rest = args[1:]
if sub == "start":
return self.systemd.start(rest[0] if rest else "")
elif sub == "stop":
return self.systemd.stop(rest[0] if rest else "")
elif sub == "restart":
return self.systemd.restart(rest[0] if rest else "")
elif sub == "enable":
return self.systemd.enable(rest[0] if rest else "")
elif sub == "disable":
return self.systemd.disable(rest[0] if rest else "")
elif sub == "status":
return self.systemd.status(rest[0] if rest else "")
elif sub in ("list-units", "list-unit-files"):
return self.systemd.list_units()
return CommandResult(stdout=f"systemctl: unknown command '{sub}'\n")

def _cmd_journalctl(self, args):
return self.systemd.journalctl(args)

def _cmd_service(self, args):
if not args:
return CommandResult(stdout="service: missing command\n")
if len(args) >= 2:
service = args[0]
action = args[1]
if action == "start":
return self.systemd.start(service)
elif action == "stop":
return self.systemd.stop(service)
elif action == "restart":
return self.systemd.restart(service)
elif action == "status":
return self.systemd.status(service)
return CommandResult(stdout="service: unknown command\n")

# ─── Python ───
def _cmd_python3(self, args):
r = CommandResult()
if "-c" in args:
idx = args.index("-c")
if idx + 1 < len(args):
code = args[idx + 1]
try:
buf = io.StringIO()
with redirect_stdout(buf):
exec(code, {"__builtins__": __builtins__})
r.stdout = buf.getvalue()
except Exception as e:
r.stderr = f"{type(e).__name__}: {e}\n"
r.exit_code = 1
return r

def _cmd_pip(self, args):
r = CommandResult()
r.stdout = "pip: simulated\n"
return r

# ─── Network ───
def _cmd_curl(self, args):
return CommandResult(stdout="curl: simulated (no network in mental terminal)\n")

def _cmd_wget(self, args):
return CommandResult(stdout="wget: simulated (no network)\n")

def _cmd_ping(self, args):
return CommandResult(stdout="PING simulated (no network)\n")

# ─── Process ───
def _cmd_ps(self, args):
r = CommandResult()
r.stdout = "PID TTY TIME CMD\n 1 ? 00:00:00 init\n 42 ? 00:00:01 bash\n 88 ? 00:00:00 ps\n"
return r

def _cmd_top(self, args):
return self._cmd_ps(args)

def _cmd_df(self, args):
r = CommandResult()
r.stdout = "Filesystem 1K-blocks Used Available Use% Mounted on\n"
r.stdout += "/dev/mental 102400 51200 51200 50% /\n"
return r

def _cmd_free(self, args):
r = CommandResult()
r.stdout = " total used free\n"
r.stdout += "Mem: 7864320 4718592 3145728\n"
r.stdout += "Swap: 2097152 0 2097152\n"
return r

# ─── Hash ───
def _cmd_md5sum(self, args):
r = CommandResult()
for p in args:
content = self.vfs.read_file(p)
if content is None: continue
r.stdout += f"{hashlib.md5(content).hexdigest()} {p}\n"
return r

def _cmd_sha256sum(self, args):
r = CommandResult()
for p in args:
content = self.vfs.read_file(p)
if content is None: continue
r.stdout += f"{hashlib.sha256(content).hexdigest()} {p}\n"
return r

def _cmd_base64(self, args):
r = CommandResult()
decode = "-d" in args
paths = [a for a in args if not a.startswith("-")]
if decode:
for p in paths:
try:
content = self.vfs.read_file(p) or p.encode()
r.stdout += base64.b64decode(content).decode("utf-8", errors="replace") + "\n"
except Exception as e:
r.stderr = f"base64: {e}\n"
r.exit_code = 1
else:
for p in paths:
content = self.vfs.read_file(p)
if content:
r.stdout += base64.b64encode(content).decode() + "\n"
return r

# ─── Math ───
def _cmd_expr(self, args):
r = CommandResult()
try:
expr = " ".join(args)
r.stdout = str(eval(expr, {"__builtins__": {}}, {})) + "\n"
except Exception as e:
r.stderr = f"expr: {e}\n"
r.exit_code = 1
return r

def _cmd_bc(self, args):
return CommandResult()

def _cmd_factor(self, args):
r = CommandResult()
for a in args:
try:
n = int(a)
if n < 2:
r.stdout += f"{n}:\n"
continue
orig = n
factors = []
d = 2
while d * d <= n:
while n % d == 0:
factors.append(d)
n //= d
d += 1
if n > 1:
factors.append(n)
r.stdout += f"{orig}: {' '.join(map(str, factors))}\n"
except: pass
return r

# ─── Divers ───
def _cmd_uuidgen(self, args):
return CommandResult(stdout=str(uuid.uuid4()) + "\n")

def _cmd_cal(self, args):
r = CommandResult()
import calendar
now = datetime.datetime.now()
r.stdout = calendar.month(now.year, now.month)
return r

def _cmd_basename(self, args):
r = CommandResult()
if args:
r.stdout = os.path.basename(args[0]) + "\n"
return r

def _cmd_dirname(self, args):
r = CommandResult()
if args:
r.stdout = os.path.dirname(args[0]) + "\n"
return r

def _cmd_readlink(self, args):
r = CommandResult()
for p in args:
f = self.vfs.get_file(p)
if f and f.file_type == FileType.SYMLINK:
r.stdout += f.target + "\n"
else:
r.exit_code = 1
return r


# ══════════════════════════════════════════════════════════════════════════════
# PYTHON REPL
# ══════════════════════════════════════════════════════════════════════════════

class MentalPython:
def __init__(self, vfs: VirtualFileSystem):
self.vfs = vfs
self.globals: Dict[str, Any] = {
"__name__": "__mental__",
"os": os, "sys": sys, "json": json, "math": math,
"time": time, "random": random, "re": re,
"datetime": datetime, "hashlib": hashlib,
"base64": base64, "statistics": statistics,
}
self.locals: Dict[str, Any] = {}

def execute(self, code: str) -> CommandResult:
start = time.time()
r = CommandResult(command=f"python3 -c '{code}'")
try:
buf_out = io.StringIO()
buf_err = io.StringIO()
try:
tree = ast.parse(code, mode="eval")
expr = compile(tree, "<mental>", "eval")
with redirect_stdout(buf_out), redirect_stderr(buf_err):
result = eval(expr, self.globals, self.locals)
if result is not None:
r.stdout = str(result) + "\n"
except SyntaxError:
with redirect_stdout(buf_out), redirect_stderr(buf_err):
exec(code, self.globals, self.locals)
r.stdout += buf_out.getvalue()
r.stderr = buf_err.getvalue()
except Exception as e:
r.stderr = f"{type(e).__name__}: {e}\n"
r.exit_code = 1
r.duration_ms = (time.time() - start) * 1000
return r


# ══════════════════════════════════════════════════════════════════════════════
# TERMINAL MENTAL PRINCIPAL
# ══════════════════════════════════════════════════════════════════════════════

class MentalTerminal:
def __init__(self):
self.vfs = VirtualFileSystem()
self.bash = MentalBash(self.vfs)
self.python_engine = MentalPython(self.vfs)
self.session_id = str(uuid.uuid4())[:8]
self.command_history: List[Dict[str, Any]] = []
self.start_time = time.time()

def execute(self, command: str, shell: str = "auto") -> CommandResult:
command = command.strip()
if shell == "auto":
shell = "python" if command.startswith(("python", "py ")) else "bash"
result = self.python_engine.execute(command) if shell == "python" else self.bash.execute(command)
self.command_history.append({
"command": command,
"shell": shell,
"result": result.to_dict(),
"timestamp": datetime.datetime.now().isoformat(),
})
return result

def python(self, code: str) -> CommandResult:
return self.python_engine.execute(code)

def bash(self, command: str) -> CommandResult:
return self.bash.execute(command)

def read_file(self, path: str) -> Optional[str]:
c = self.vfs.read_file(path)
return c.decode("utf-8", errors="replace") if c else None

def write_file(self, path: str, content: str) -> bool:
return self.vfs.write_file(path, content.encode())

def list_dir(self, path: str = ".") -> Optional[List[str]]:
return self.vfs.list_dir(path)

def mkdir(self, path: str) -> bool:
return self.vfs.mkdir_p(path)

def rm(self, path: str) -> bool:
return self.vfs.rm(path)

def get_state(self) -> Dict[str, Any]:
return {
"session_id": self.session_id,
"uptime": time.time() - self.start_time,
"cwd": self.vfs.current_dir,
"env": dict(self.bash.env),
"history_count": len(self.command_history),
"aliases": dict(self.bash.aliases),
"installed_packages": len(self.bash.apt.installed),
"installed_ppas": self.bash.apt.installed_ppas,
}

def reset(self):
self.vfs = VirtualFileSystem()
self.bash = MentalBash(self.vfs)
self.python_engine = MentalPython(self.vfs)
self.command_history = []
self.start_time = time.time()

def stats(self) -> Dict[str, Any]:
total = len(self.command_history)
successful = sum(1 for h in self.command_history if h["result"]["success"])
return {
"session_id": self.session_id,
"uptime_seconds": round(time.time() - self.start_time, 2),
"total_commands": total,
"successful": successful,
"failed": total - successful,
"success_rate": round(successful / total * 100, 1) if total else 0,
}


# ══════════════════════════════════════════════════════════════════════════════
# TOOL WRAPPER POUR IA
# ══════════════════════════════════════════════════════════════════════════════

class MentalTerminalTool:
def __init__(self):
self.terminal = MentalTerminal()

@staticmethod
def get_tool_schema() -> List[Dict[str, Any]]:
return [
{"type": "function", "function": {
"name": "mental_bash",
"description": "Exécute une commande bash/Ubuntu VIRTUELLE. Supporte apt, snap, flatpak, systemctl, add-apt-repository.",
"parameters": {"type": "object", "properties": {
"command": {"type": "string"}
}, "required": ["command"]}
}},
{"type": "function", "function": {
"name": "mental_python",
"description": "Exécute du Python dans un REPL persistant.",
"parameters": {"type": "object", "properties": {
"code": {"type": "string"}
}, "required": ["code"]}
}},
{"type": "function", "function": {
"name": "mental_read_file",
"description": "Lit un fichier virtuel.",
"parameters": {"type": "object", "properties": {
"path": {"type": "string"}
}, "required": ["path"]}
}},
{"type": "function", "function": {
"name": "mental_write_file",
"description": "Écrit dans un fichier virtuel.",
"parameters": {"type": "object", "properties": {
"path": {"type": "string"},
"content": {"type": "string"}
}, "required": ["path", "content"]}
}},
]

def execute_tool(self, name: str, args: Dict[str, Any]) -> Dict[str, Any]:
if name == "mental_bash":
return self.terminal.bash(args["command"]).to_dict()
elif name == "mental_python":
return self.terminal.python(args["code"]).to_dict()
elif name == "mental_read_file":
content = self.terminal.read_file(args["path"])
return {"path": args["path"], "content": content, "success": content is not None}
elif name == "mental_write_file":
return {"path": args["path"], "success": self.terminal.write_file(args["path"], args["content"])}
return {"error": f"Unknown tool: {name}"}


# ══════════════════════════════════════════════════════════════════════════════
# DÉMO CLI
# ══════════════════════════════════════════════════════════════════════════════

def demo():
terminal = MentalTerminal()
print(f"""
╔══════════════════════════════════════════════════════════════════════════════╗
║ ║
║ 🧠 NEXUS MENTAL TERMINAL v{VERSION} — Ubuntu/Unix Edition ║
║ ║
║ Bash + Python + apt + snap + flatpak + systemd ║
║ AUCUN accès au système réel. ║
║ ║
║ Auteur : {AUTHOR} ║
║ ║
╚══════════════════════════════════════════════════════════════════════════════╝

Session : {terminal.session_id}
CWD : {terminal.vfs.current_dir}

Tape 'help' pour les commandes.
Tape 'exit' pour quitter.
Tape 'PY: code' pour Python.

Commandes Ubuntu à essayer :
apt list
apt list-ppas
apt install nginx
add-apt-repository ppa:canonical-kernel-team/unstable
snap install firefox
flatpak install org.gimp.GIMP
systemctl status docker

""")
while True:
try:
cwd = terminal.vfs.current_dir
prompt = f"\033[92muser@nexus\033[0m:\033[94m{cwd}\033[0m$ "
line = input(prompt)
if not line.strip():
continue
if line.strip().lower() in ("exit", "quit"):
print("\n👋 À bientôt\n")
break
if line.startswith("PY:"):
result = terminal.python(line[3:].strip())
else:
result = terminal.bash(line)
if result.stdout:
print(result.stdout, end="")
if result.stderr:
print(f"\033[91m{result.stderr}\033[0m", end="")
except (KeyboardInterrupt, EOFError):
print("\n\n👋 À bientôt\n")
break


if __name__ == "__main__":
demo()
