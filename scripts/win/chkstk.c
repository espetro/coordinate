/* Minimal x86_64 Windows stack probe (__chkstk).
   The Windows x64 ABI requires __chkstk for stack frames larger than one
   page. zig's mingw runtime does not export it, so a program with such a
   frame (Effect's fiber runtime has them) fails to link with
   "undefined symbol: __chkstk". The MSVC CRT provides it; this is the same
   routine, written for the mingw target. */
#include <stdint.h>

__attribute__((naked)) void __chkstk(void) {
    __asm__ volatile (
        "leaq 8(%rsp), %rax\n"
        "test %rax, %rax\n"
        "jz 2f\n"
        "1:\n"
        "subq $4096, %rax\n"
        "cmpq $0, %rax\n"
        "ja 1b\n"
        "2:\n"
        "subq $8, %rsp\n"
        "ret\n"
    );
}
