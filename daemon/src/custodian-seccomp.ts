/**
 * The seccomp filter Linux wraps the round in, in both bwrap modes (DESIGN.md, "The custodian's seat", "Contained").
 * The WSL drill (2026-11-14) found `AF_VSOCK` open from inside the round's sandbox: a network namespace does not cover
 * vsock, and srt's own seccomp filter is off under `allowAllUnixSockets` (and knows only `AF_UNIX` when on), so a round
 * connected to the Windows host (CID 2). An LXC container (2026-11-15) reached its host kernel's vsock loopback the same
 * way. The launch script runs claude under an outer `bwrap --seccomp` with this
 * filter; a seccomp filter is inherited by every child and no child can lift it, srt's inner bwrap included.
 *
 * Classic BPF over `seccomp_data`: `socket`/`socketpair` with family `AF_VSOCK` fail `EAFNOSUPPORT`; `io_uring_setup`
 * fails `EPERM`, since `IORING_OP_SOCKET` creates a socket no syscall filter sees; and every syscall of another ABI
 * fails `ENOSYS` (x86_64's x32 numbers and i386's `int 0x80`, arm64's compat arm), since `socketcall` and the other
 * ABI's numbers would get past a filter written for the native ones. Everything else is allowed.
 */

const LD_W_ABS = 0x20;
const JEQ_K = 0x15;
const JGE_K = 0x35;
const RET_K = 0x06;
const SECCOMP_RET_ALLOW = 0x7fff0000;
const SECCOMP_RET_ERRNO = 0x00050000;
const EPERM = 1;
const ENOSYS = 38;
const EAFNOSUPPORT = 97;
const AF_VSOCK = 40;
const X32_SYSCALL_BIT = 0x40000000;

/** `seccomp_data`'s offsets: `nr`, `arch`, then `args[0]`'s low word (little-endian on both arches below). */
const NR = 0;
const ARCH = 4;
const ARG0_LOW = 16;

interface ArchTable {
  readonly audit: number;
  readonly socket: number;
  readonly socketpair: number;
  readonly ioUringSetup: number;
  readonly x32: boolean;
}

const ARCHES: Readonly<Record<string, ArchTable>> = {
  x64: { audit: 0xc000003e, socket: 41, socketpair: 53, ioUringSetup: 425, x32: true },
  arm64: { audit: 0xc00000b7, socket: 198, socketpair: 199, ioUringSetup: 425, x32: false },
};

type Insn = readonly [code: number, jt: number, jf: number, k: number];

/** The filter for `arch` (`process.arch`), or null where none is written: such a host runs no Linux round. */
export function vsockFilter(arch: string): Uint8Array | null {
  const table = ARCHES[arch];
  if (table === undefined) return null;
  const errno = (e: number): Insn => [RET_K, 0, 0, SECCOMP_RET_ERRNO | e];
  const program: Insn[] = [
    [LD_W_ABS, 0, 0, ARCH],
    [JEQ_K, 1, 0, table.audit],
    errno(ENOSYS),
    [LD_W_ABS, 0, 0, NR],
    ...(table.x32 ? ([[JGE_K, 0, 1, X32_SYSCALL_BIT], errno(ENOSYS)] satisfies Insn[]) : []),
    [JEQ_K, 3, 0, table.ioUringSetup],
    [JEQ_K, 3, 0, table.socket],
    [JEQ_K, 2, 0, table.socketpair],
    [RET_K, 0, 0, SECCOMP_RET_ALLOW],
    errno(EPERM),
    [LD_W_ABS, 0, 0, ARG0_LOW],
    [JEQ_K, 0, 1, AF_VSOCK],
    errno(EAFNOSUPPORT),
    [RET_K, 0, 0, SECCOMP_RET_ALLOW],
  ];
  const out = new Uint8Array(program.length * 8);
  const view = new DataView(out.buffer);
  program.forEach(([code, jt, jf, k], i) => {
    view.setUint16(i * 8, code, true);
    view.setUint8(i * 8 + 2, jt);
    view.setUint8(i * 8 + 3, jf);
    view.setUint32(i * 8 + 4, k, true);
  });
  return out;
}
