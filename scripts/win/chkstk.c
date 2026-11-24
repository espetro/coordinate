/* Minimal x86_64 Windows stack probe (__chkstk).
   The Windows x64 ABI requires __chkstk for stack frames larger than one
   page: the caller passes the frame size in %rax and the probe must touch
   each page below %rsp and leave %rsp adjusted by the frame size. zig's
   mingw runtime does not export the symbol (the MSVC CRT does), so a
   program with such a frame (Effect's fiber runtime has them) fails to
   link with "undefined symbol: __chkstk". This is the same routine zig
   ships in compiler_rt/stack_probe.zig, written for the mingw target. */
#include <stdint.h>

__attribute__((naked)) void __chkstk(void) {
    __asm__ volatile (
        "push %rcx\n"
        "push %rax\n"
        "cmp $0x1000, %rax\n"
        "lea 24(%rsp), %rcx\n"
        "jb 1f\n"
        "2:\n"
        "sub $0x1000, %rcx\n"
        "test %rcx, (%rcx)\n"
        "sub $0x1000, %rax\n"
        "cmp $0x1000, %rax\n"
        "ja 2b\n"
        "1:\n"
        "sub %rax, %rcx\n"
        "test %rcx, (%rcx)\n"
        "pop %rax\n"
        "pop %rcx\n"
        "ret\n"
    );
}
