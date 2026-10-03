# Container dependencies

`seccomp.json` is derived from the Playwright v1.63.0 Docker seccomp profile:
https://github.com/microsoft/playwright/blob/v1.63.0/utils/docker/seccomp_profile.json

Copyright Microsoft Corporation. Licensed under Apache-2.0. The license is
included in `PLAYWRIGHT-LICENSE`.

The upstream profile retains the Docker syscall allowlist and adds the namespace
operations needed by Chromium's sandbox. This copy additionally returns `ENOSYS`
for `clone3`, matching the compatibility behavior of current Docker profiles so
glibc can fall back to `clone` on systems where `clone3` is filtered.
It also allows `chroot` without conditioning that syscall on the container's
capability list. Chromium uses it after creating its sandbox user namespace;
the kernel still requires the appropriate capability in that namespace. No
`SYS_CHROOT` or `SYS_ADMIN` capability is granted to the container.

The host must permit unprivileged user namespaces. The runtime intentionally
does not fall back to disabling Chromium's sandbox. A host AppArmor policy may
need to permit user namespaces for this container; the Compose configuration
does not disable AppArmor or grant `SYS_ADMIN`.

The browser uses the Debian Chromium and Chromium sandbox packages. The image
is built from a general-purpose Node/Debian base, not a prepackaged browser image.
Application dependencies are installed from the repository's package lock.
