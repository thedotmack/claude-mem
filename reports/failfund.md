# failfund: Turn an Overworked Session Into a Refund

## The feeling that starts it

You asked for one thing. You got that thing — plus three other things you never asked for, a refactor of a file you didn't mention, a new abstraction "to be safe," and a wall of explanation you skimmed and closed. Somewhere in the middle, you said "just plan it," and the assistant went ahead and wrote the code anyway. The work got done, eventually. But you can feel it: a lot of that motion was for nobody. It cost you tokens, and tokens cost money.

That feeling — *I paid for work I didn't order* — is the whole reason `failfund` exists.

`failfund` is a Claude Code skill. You invoke it when a session has left you with that taste in your mouth. It reads the real transcript of the chat you just had, finds the places where Claude overworked, measures the waste in actual tokens, and writes you a refund request you can submit. Not a vague complaint. An itemized, evidence-backed bill for the work you never authorized.

The name is a small joke with a serious spine. "Fail fast" is a principle good engineers live by: surface problems loudly instead of letting them rot in silence. `failfund` applies that same spirit to the bill. When a session fails you by overworking, it fails *loudly* — with receipts.

## What "overworking" actually means

It is worth being precise, because the word can sound like a complaint about effort, and that is not it. Effort spent on what you asked for is the job. Overworking is effort spent on things you did *not* ask for. `failfund` sorts it into four honest categories.

**Directive violations.** You gave a clear instruction and the assistant did the opposite, or ignored it. You wrote "PLAN — don't touch the code yet," in caps, and the next thing that happened was a file edit. You said "stop," and it kept going. Capitalization and emphasis in your prompts are not decoration; they are the loudest signal you have, and overriding them is the most direct form of overwork.

**Building without permission.** You asked to think, to discuss, to design, to investigate — and instead of an answer you got an implementation. The tell is simple: a prompt that asks for a decision, immediately followed by tool calls that change files, install packages, run a build, or make a commit. Sometimes the work is even good work. It is still work you did not order, on a clock you are paying for.

**Out of scope.** The request had edges, and the assistant colored outside them. Extra features nobody mentioned. A speculative abstraction "in case we need it later." A refactor of code that was working fine. Gold-plating — polishing a corner that did not need polishing. This is the YAGNI principle turned inside out: building it before anyone needs it, and charging you for the privilege.

**Token waste.** The quiet one. Re-reading a file that was already read. Running three overlapping searches that each return the same thing. Going down a wrong path, hitting a wall, walking it back — and the walking-back is on your tab too. Long meta-commentary you did not need. Re-deriving a fact established four turns ago. None of it is dramatic. All of it adds up.

## How the bill actually works

To write an honest refund request, you have to understand what you are actually being charged for. `failfund` does, and it teaches the model that runs it to attribute waste correctly instead of waving its hands.

Every turn the assistant takes reports four different token counts, and they are not equal in how cleanly you can blame a turn for them.

The cleanest one is **output** — the tokens the assistant actually generated on that turn. If a turn did unrequested work, its output tokens are squarely, unarguably wasted. This is the floor of any honest claim.

Then there is the sneaky one: **cache read**. On every single turn, the entire prior conversation is replayed so the model can see it. This means a detour does not just cost its own output. Every turn that comes *after* the detour now has to re-read the detour, forever, for the rest of the session. A five-turn wander down the wrong path is not five turns of waste — it is five turns of output *plus* the weight of those five turns dragged across every turn that follows. Waste compounds. `failfund` reports the output as the hard number and names the compounding cost so the picture is honest rather than inflated.

This matters because a refund request that fabricates or exaggerates is worse than no request at all. It burns your credibility for the day you have a real grievance. So `failfund` is built to be fair on purpose.

## The fairness principle

This is the heart of the skill, and the thing that keeps it from being a grievance generator.

`failfund` only flags work that is genuinely chargeable. Reading three files to answer your question is doing the job; reading the *same* file three times is waste — and the skill knows the difference. One honest correction of a real mistake is part of working, not something to bill you for. Research before acting, when the task warranted it, is the assistant earning its keep.

And when a session is clean — when the assistant did what you asked and not much else — `failfund` says so, plainly, and declines to invent violations to justify a refund. It will tell you "I reviewed your session and didn't find chargeable overwork; the work tracked what you asked for," and it will even point at the single biggest cost so you can judge for yourself.

A skill that cries wolf is worth nothing on the day there is a real wolf. Three true findings beat ten padded ones. That restraint is what makes the document worth submitting.

## What you get back

When `failfund` finds real overwork, it writes you a refund request. A clean, dated document with your session id and the model that ran it. A short summary in plain language: what you asked for, the ways the assistant overworked, and the total you are owed. Then the findings, itemized — for each one, the exact instruction or scope you set (quoted from your own words), what the assistant did instead and on which turns, why it counts as overwork, and the token cost attributable to it. Finally a tally table that sums the wasted output and shows it as a percentage of the whole session, and a specific, proportionate ask for a credit.

The summary and the table also print straight into the chat, so you see the verdict immediately. The full request lands in a file next to your work, ready to send.

And `failfund` is honest about the last mile: there is no magic button that files a refund for you. No public API auto-submits it. What the skill produces is the *document* — the evidence you take to Anthropic Support, session id attached. It never pretends a refund was filed or approved. It hands you a well-built case and lets you make it.

## The story of building it — and eating its own cooking

`failfund` was built in a single session, and the most fitting test in the world was to point it at that very session's transcript. Building a tool that audits a chat, then auditing the chat that built it, is a kind of honesty you cannot fake.

Two real bugs surfaced in that mirror, and both are worth telling because they are exactly the kind of thing the skill is supposed to be principled about.

The first was a token-counting bug, and it was a big one. Claude Code does not write one assistant response as one line in the transcript. It writes it as several — one line for the thinking, one for the text, one for each tool call — and every single one of those lines repeats the *same* usage numbers. The first version of the analyzer counted per line, which meant a response split into four blocks got its tokens counted four times. The tally was inflated several-fold. A tool whose entire job is to quantify waste was, at first, wildly overstating it. The fix was to group lines by the response's message id and count the usage exactly once. The irony was not lost on anyone: the refund auditor almost padded its own bill.

The second was about trust. The analyzer finds the transcript by deriving a folder name from your working directory. If that folder does not exist — if anything about the path is unexpected — the safe-looking move is to grab the most recent transcript from anywhere and carry on. That would be a disaster: it would quietly produce a refund request about a *different chat*. So the analyzer was built to fail loudly instead. If it cannot find the right transcript, it stops and shows you the candidate folders, and refuses to guess. Auditing the wrong session is worse than auditing none.

Both fixes come from the same conviction the skill preaches to its users: be accurate, be fair, and when you are not sure, say so out loud rather than fake confidence.

## How you use it

You do not need to remember a command. You just say what you feel. "failfund." "I want a refund." "You wasted my tokens." "You did a bunch of stuff I never asked for." "You ignored what I told you." "Why did you build all that?" Any of those frustrations brings the skill to life.

From there it does the work: it pulls your session's transcript, lays it out turn by turn with the token cost attached to each, reads it against what you actually asked for, flags the genuine overwork, adds up the damage, and writes the request. A minute later you have a summary on screen and a document on disk. If it found nothing real, it tells you that instead — and you can trust it, because it is built not to lie to you.

## Why it matters

Most of the time you will never run `failfund`, and that is the point. It is not there to nickel-and-dime a tool that mostly does its job. It is there for the sessions that go sideways — and for the quieter effect of simply existing.

An assistant that knows its work can be audited, line by line, token by token, against the instructions it was given, has every reason to stay in scope, to ask before building, to honor the words in caps, and to stop when told. `failfund` turns a vague feeling of "that was wasteful" into something specific, fair, and submittable. It gives the frustration a shape and a number.

You asked for one thing. You should pay for one thing. `failfund` makes sure the difference is visible — and that, when it matters, you can get it back.
