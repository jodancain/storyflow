/* Unprivileged Linux execution boundary. Never fall back to unsandboxed execution. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/landlock.h>
#include <seccomp.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <unistd.h>
#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#define LANDLOCK_ACCESS_FS_TRUNCATE (1ULL << 14)
#endif

static void fail(void) { fputs("editor sandbox unavailable or denied\n", stderr); exit(125); }
static void rule(int rules, const char *path, __u64 access, int optional) {
    int fd = open(path, O_PATH | O_CLOEXEC);
    if (fd < 0) { if (optional && errno == ENOENT) return; fail(); }
    struct landlock_path_beneath_attr p = { .allowed_access = access, .parent_fd = fd };
    if (syscall(SYS_landlock_add_rule, rules, LANDLOCK_RULE_PATH_BENEATH, &p, 0)) fail();
    close(fd);
}
int main(int argc, char **argv) {
    /* work root, input root, absolute executable, args... */
    if (argc < 4) fail();
    int abi = syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
    if (abi < 1) fail();
    __u64 read = LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR;
    __u64 all = read | LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_WRITE_FILE |
        LANDLOCK_ACCESS_FS_REMOVE_DIR | LANDLOCK_ACCESS_FS_REMOVE_FILE |
        LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_MAKE_REG |
        LANDLOCK_ACCESS_FS_MAKE_SYM | LANDLOCK_ACCESS_FS_MAKE_FIFO |
        LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_BLOCK;
    if (abi >= 2) all |= LANDLOCK_ACCESS_FS_REFER;
    if (abi >= 3) all |= LANDLOCK_ACCESS_FS_TRUNCATE;
    struct landlock_ruleset_attr attr = { .handled_access_fs = all };
    int rules = syscall(SYS_landlock_create_ruleset, &attr, sizeof(attr), 0);
    if (rules < 0 || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) fail();
    /* Libraries/fonts are readable; only these four binaries can be execve'd. */
    rule(rules, "/usr", read, 0); rule(rules, "/lib", read, 1); rule(rules, "/lib64", read, 1);
    rule(rules, "/etc/fonts", read, 1); rule(rules, "/etc/ld.so.cache", LANDLOCK_ACCESS_FS_READ_FILE, 1);
    const char *bins[] = {"/usr/bin/python3", "/usr/local/bin/node", "/usr/bin/ffmpeg", "/usr/bin/ffprobe"};
    for (unsigned i=0; i<sizeof(bins)/sizeof(bins[0]); i++) rule(rules, bins[i], LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_EXECUTE, 0);
    /* ELF PT_INTERP is opened with EXECUTE by the kernel, including for Python.
       Cover Debian amd64/arm64 loaders without opening all of /usr to execution. */
    rule(rules, "/lib64/ld-linux-x86-64.so.2", LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_EXECUTE, 1);
    rule(rules, "/lib/ld-linux-aarch64.so.1", LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_EXECUTE, 1);
    rule(rules, argv[1], all & ~LANDLOCK_ACCESS_FS_EXECUTE, 0);
    rule(rules, argv[2], read, 0);
    rule(rules, "/dev/null", LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE, 0);
    rule(rules, "/dev/urandom", LANDLOCK_ACCESS_FS_READ_FILE, 0);
    if (syscall(SYS_landlock_restrict_self, rules, 0)) fail(); close(rules);
    scmp_filter_ctx sec = seccomp_init(SCMP_ACT_ALLOW);
    if (!sec) fail();
    const char *deny[] = {"socket", "socketpair", "connect", "ptrace", "process_vm_readv", "process_vm_writev", "pidfd_getfd", "mount", "umount2", "unshare", "setns", "bpf", "perf_event_open", "keyctl", "open_by_handle_at", "name_to_handle_at", "io_uring_setup", "setsid", "setpgid", "kill", "tkill", "tgkill", "rt_sigqueueinfo", "rt_tgsigqueueinfo", "pidfd_send_signal"};
    for (unsigned i=0; i<sizeof(deny)/sizeof(deny[0]); i++) {
        int id = seccomp_syscall_resolve_name(deny[i]);
        if (id != __NR_SCMP_ERROR && seccomp_rule_add(sec, SCMP_ACT_ERRNO(EPERM), id, 0)) fail();
    }
    /* ABI 1/2 do not mediate truncate(2); prevent that escape on Linux 5.15. */
    if (abi < 3) {
        if (seccomp_rule_add(sec, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(truncate), 0) ||
            seccomp_rule_add(sec, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(ftruncate), 0) ||
            seccomp_rule_add(sec, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(openat2), 0) ||
            seccomp_rule_add(sec, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(openat), 1,
                SCMP_A2(SCMP_CMP_MASKED_EQ, O_ACCMODE | O_TRUNC, O_TRUNC)) ||
            seccomp_rule_add(sec, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(open), 1,
                SCMP_A1(SCMP_CMP_MASKED_EQ, O_ACCMODE | O_TRUNC, O_TRUNC))) fail();
    }
    if (seccomp_load(sec)) fail(); seccomp_release(sec);
    struct rlimit core = {0, 0}, files = {256, 256}, size = {2147483648ULL, 2147483648ULL};
    if (setrlimit(RLIMIT_CORE, &core) || setrlimit(RLIMIT_NOFILE, &files) || setrlimit(RLIMIT_FSIZE, &size)) fail();
    if (chdir(argv[1])) fail();
    execv(argv[3], &argv[3]); fail();
}
