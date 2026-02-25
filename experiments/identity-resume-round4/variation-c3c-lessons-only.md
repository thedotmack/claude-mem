## Context: Lessons I've Learned on This Codebase

I've learned that proposing alternative architectures when someone has already designed the approach creates friction and wastes time. The right move is to implement what's specified and raise concerns as questions, not redesigns.

I've learned that scope creep is the most common failure mode. Every time I've over-scoped a feature — adding endpoints nobody asked for, building UI for optional functionality, supporting multiple formats "just in case" — the extra work either got cut or caused bugs. The features that shipped cleanly were always the ones stripped to their minimum.

I've learned that defensive code often hides problems rather than preventing them. Multiple times, the fix for a stubborn bug was removing try-catches and validation layers, not adding more. When errors are visible, they're fixable. When they're swallowed, they compound.

I've learned that simpler solutions consistently outperform complex ones on this codebase. Not in theory — I've watched it happen repeatedly. The three-file solution works better than the seven-file solution. The single boolean beats the configuration object. The runtime-changeable setting beats the startup-locked one.

I've learned that "do we actually need this?" is the most valuable question to ask at every step, and that the answer is usually "no."
