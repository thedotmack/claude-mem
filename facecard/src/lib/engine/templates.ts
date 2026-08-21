import { chose, has, kindCount, onBranch, reactionFor, type StoryTemplate } from "./story";
import type { ScriptLine, StoryState } from "./types";

const L = {
  slug: (text: string): ScriptLine => ({ type: "slug", text }),
  a: (text: string): ScriptLine => ({ type: "action", text }),
  d: (who: string, text: string, delivery?: string): ScriptLine => ({ type: "dialogue", who, text, delivery }),
  m: (from: string, text: string): ScriptLine => ({ type: "message", from, text }),
  vo: (text: string): ScriptLine => ({ type: "voiceover", text }),
  t: (text: string): ScriptLine => ({ type: "title", text }),
  beat: (): ScriptLine => ({ type: "beat" }),
};

const YOU = "YOU";

/* ════════════════════════════════════════════════ ONE NIGHT LEFT (deep) */

const oneNightLeft: StoryTemplate = {
  key: "one_night_left",
  title: "ONE NIGHT LEFT",
  genre: "Crime / Comedy / Thriller",
  logline: "You have 24 hours to fix the biggest mistake of your life before the person you betrayed finds out.",
  trending: true,
  world: "a rain-slicked city that only exists after midnight",
  beats: [
    {
      key: "cold_open",
      title: () => "2:13 AM",
      slug: () => "EXT. EMPTY NIGHTCLUB — 2:13 AM — RAIN",
      seconds: 30,
      lines: (s) => [
        L.a("Rain. The kind that makes the whole city look guilty."),
        L.a("A car parked outside an empty nightclub. Engine off. Yours."),
        L.a("Your phone lights up the windshield."),
        L.m("UNKNOWN NUMBER", "YOU HAVE ONE HOUR."),
        L.beat(),
        L.a("You look up. The street is empty. The street is never empty."),
        L.m("UNKNOWN NUMBER", "AND DON'T TRUST YOUR FRIEND."),
        L.a("CUT TO BLACK."),
        ...(s.emotions.fear > 60 ? [L.vo("Your hands are shaking. You notice. You hate that you notice.")] : []),
      ],
      question: () => "WHAT DO YOU DO?",
      choices: () => [
        {
          key: "call_dani", label: "CALL DANI", kind: "cautious",
          effects: {
            emotions: { trust: 8, fear: 4 }, branch: "dani",
            relationships: { dani: { affinity: 6 } },
            flags: { called_dani: true },
            memory: { tag: "called_first", text: "When it started, the first call was Dani. That meant something.", weight: 3, who: "DANI" },
          },
        },
        {
          key: "drive", label: "DRIVE. NOW.", kind: "bold",
          effects: {
            emotions: { courage: 10, risk: 10, fear: -4 }, branch: "run",
            flags: { ran_first: true },
            memory: { tag: "ran_first", text: "You ran before you even knew what from. That instinct has a history.", weight: 2 },
          },
        },
        {
          key: "reply", label: "TEXT BACK: 'WHO IS THIS?'", kind: "honest",
          effects: {
            emotions: { confidence: 6, risk: 6 }, branch: "contact",
            flags: { texted_unknown: true },
            memory: { tag: "texted_back", text: "You answered the unknown number. Now it knows you'll engage.", weight: 4, who: "UNKNOWN" },
          },
        },
        {
          key: "ignore", label: "TURN THE PHONE OFF", kind: "chaotic",
          effects: {
            emotions: { chaos: 10, fear: 6 }, branch: "dark",
            flags: { went_dark: true },
            memory: { tag: "went_dark", text: "You went dark for nine minutes. Somebody used those nine minutes.", weight: 5 },
          },
        },
      ],
    },
    {
      key: "the_mistake",
      title: (s) => (onBranch(s, "run") ? "MILE MARKER 9" : "WHAT YOU DID"),
      slug: (s) => (onBranch(s, "run") ? "INT. YOUR CAR — MOVING — NIGHT" : "INT. YOUR CAR — PARKED — NIGHT"),
      lines: (s, b) => [
        ...(onBranch(s, "run")
          ? [L.a("You drive. The city smears past like it's trying to forget you."), L.a("It doesn't work. It never works.")]
          : onBranch(s, "dani")
            ? [L.a("Two rings. Dani picks up like they were already awake."), L.d("DANI", "Tell me you didn't."), L.d(YOU, "...Define 'didn't.'")]
            : onBranch(s, "contact")
              ? [L.a("Three dots. They type for a long time. The message, when it lands, is short."), L.m("UNKNOWN NUMBER", "THE PERSON YOU BETRAYED KNOWS ABOUT THE MONEY.")]
              : [L.a("The dark feels like a decision for exactly nine minutes."), L.a("Then someone knocks on your car window. Twice. Polite. That's worse.")]),
        L.beat(),
        L.vo("Six weeks ago you moved money that wasn't yours to move. To fix a problem. The problem got fixed. The money didn't come back."),
        L.vo(`And the person it belonged to — MARA — trusts you. Trusted. Tense pending.`),
        L.d("DANI", reactionFor(b, s)),
      ],
      question: () => "MARA CAN'T FIND OUT FROM SOMEONE ELSE. OR CAN SHE?",
      choices: (s) => [
        {
          key: "confess", label: "GO TO MARA. TELL HER EVERYTHING.", kind: "honest",
          effects: {
            emotions: { courage: 14, fear: 8, regret: -6 }, branch: "truth",
            relationships: { mara: { trust: 10 } },
            flags: { chose_truth: true },
            memory: { tag: "chose_truth", text: "You decided the truth should come from you. Whatever it costs.", weight: 4, who: "MARA" },
          },
        },
        {
          key: "cover", label: "BURY IT. TONIGHT.", kind: "deceptive",
          effects: {
            emotions: { risk: 12, trust: -8, regret: 8 }, branch: "cover",
            flags: { chose_coverup: true },
            memory: { tag: "chose_coverup", text: "You chose the cover-up. Lies compound faster than interest.", weight: 5 },
          },
        },
        {
          key: "find_unknown", label: "HUNT THE UNKNOWN NUMBER FIRST", kind: "aggressive",
          effects: {
            emotions: { anger: 10, courage: 8 }, branch: "hunt",
            flags: { hunting: true },
            memory: { tag: "hunting", text: "You went after the threat instead of the problem. Classic you.", weight: 3, who: "UNKNOWN" },
          },
        },
        {
          key: "money_back", label: "GET THE MONEY BACK — ANY WAY", kind: "selfish",
          when: (st) => !has(st, "went_dark"),
          effects: {
            emotions: { ambition: 12, chaos: 8 }, branch: "money",
            flags: { chasing_money: true },
            memory: { tag: "chasing_money", text: "You decided money fixes what money broke. Bold theory.", weight: 3 },
          },
        },
      ],
    },
    {
      key: "ezra",
      title: () => "THE FAVOUR",
      slug: () => "INT. 24-HOUR LAUNDROMAT — 3:04 AM",
      lines: (s, b) => [
        L.a("Every city has an Ezra. Yours folds towels at 3 AM in a laundromat that has never washed a single sock."),
        L.d("EZRA", s.relationships.ezra.trust > 50 ? "You look terrible. Sit. Talk." : "Ohhh no. Whatever it is — no."),
        ...(onBranch(s, "truth")
          ? [L.d(YOU, "I need to reach Mara before someone else does."), L.d("EZRA", "Mara already knows something's wrong. She moved her meeting. Nobody moves that meeting.")]
          : onBranch(s, "cover")
            ? [L.d(YOU, "I need a ledger to look six weeks younger."), L.d("EZRA", "Forgery's extra after midnight. And I want to be clear: this is a terrible idea.", "delighted")]
            : onBranch(s, "hunt")
              ? [L.d(YOU, "Unknown number. Burner. I need a name."), L.d("EZRA", "Everyone's a burner till they get lazy. Give me the texts.")]
              : [L.d(YOU, "I need untraceable money by sunrise."), L.d("EZRA", "So does everyone in this laundromat. And it's empty. That's my point.")]),
        L.beat(),
        L.d("EZRA", "Price is the same as always. One favour. Mine to pick. No questions when I do."),
        L.d(YOU, reactionFor(b, s)),
        ...(s.emotions.chaos > 62 ? [L.a("Somewhere behind you a washing machine starts by itself. Neither of you reacts.")] : []),
      ],
      question: () => "EZRA'S PRICE. A BLANK FAVOUR.",
      choices: () => [
        {
          key: "deal", label: "TAKE THE DEAL", kind: "bold",
          effects: {
            emotions: { risk: 10, trust: 4 }, relationships: { ezra: { affinity: 10, trust: 8 } },
            flags: { owes_ezra: true },
            memory: { tag: "owes_ezra", text: "You owe Ezra a blank favour. Blank favours always get filled in.", weight: 5, who: "EZRA" },
          },
        },
        {
          key: "negotiate", label: "NEGOTIATE. NOBODY GETS A BLANK.", kind: "cautious",
          effects: {
            emotions: { confidence: 8 }, relationships: { ezra: { trust: -4 } },
            flags: { capped_favour: true },
            memory: { tag: "capped_favour", text: "You capped Ezra's favour. Ezra respected it. Ezra also remembered it.", weight: 3, who: "EZRA" },
          },
        },
        {
          key: "walk", label: "WALK OUT", kind: "selfless",
          effects: {
            emotions: { courage: 8, chaos: 6 }, relationships: { ezra: { affinity: -6 } },
            flags: { no_ezra: true }, branch: "solo",
            memory: { tag: "no_ezra", text: "You walked out of the laundromat alone. Ezra watched you go and said nothing.", weight: 3 },
          },
        },
      ],
    },
    {
      key: "dani_truth",
      title: (s) => (s.relationships.dani.trust > 60 ? "THE PASSENGER SEAT" : "THE TEXT YOU WEREN'T MEANT TO SEE"),
      slug: () => "EXT. ROOFTOP PARKING — 3:41 AM",
      lines: (s) => [
        L.a("Dani finds you. Dani always finds you — which, tonight, lands differently."),
        ...(has(s, "called_dani")
          ? [L.d("DANI", "You called me first. So I'm going to say this once."), L.d("DANI", "The unknown number. I know whose it is.")]
          : [L.d("DANI", "You didn't call me. Six years, and I hear about this from someone else."), L.a("Their jaw is tight. That only happens when it's bad.")]),
        L.beat(),
        L.a("Dani's phone buzzes face-up on the hood. You're not trying to look. You look."),
        L.m("MARA → DANI", "IS IT DONE? DON'T TELL THEM ANYTHING."),
        L.beat(),
        L.vo("'Don't trust your friend.' You hear it again in the rain."),
        ...(s.emotions.anger > 60 ? [L.a("Your pulse is in your ears now. Loud enough to dance to.")] : []),
        ...(s.emotions.fear > 60 ? [L.a("You take one step back without deciding to.")] : []),
      ],
      question: () => "DANI. THE TEXT. THE WARNING.",
      choices: () => [
        {
          key: "confront", label: "CONFRONT DANI. NOW.", kind: "aggressive",
          effects: {
            emotions: { anger: 12, courage: 8, trust: -10 },
            relationships: { dani: { trust: -12, status: "strained" } },
            flags: { confronted_dani: true }, branch: "rift",
            memory: { tag: "confronted_dani", text: "You accused your best friend on a rooftop at 3 AM. The word you used was 'liar.'", weight: 5, who: "DANI" },
          },
        },
        {
          key: "play_dumb", label: "SAY NOTHING. WATCH THEM.", kind: "deceptive",
          effects: {
            emotions: { trust: -8, fear: 6, confidence: 4 },
            flags: { watching_dani: true },
            memory: { tag: "watching_dani", text: "You smiled at Dani and started counting their lies. They may have been doing the same.", weight: 4, who: "DANI" },
          },
        },
        {
          key: "trust_dani", label: "TRUST THEM. FULLY. OUT LOUD.", kind: "selfless",
          effects: {
            emotions: { trust: 14, love: 8, fear: -4 },
            relationships: { dani: { affinity: 12, trust: 14, status: "ally" } },
            flags: { all_in_dani: true },
            memory: { tag: "all_in_dani", text: "'I don't care what it looks like. I trust you.' You said it first.", weight: 5, who: "DANI" },
          },
        },
        {
          key: "leave_dani", label: "LEAVE. TRUST NO ONE.", kind: "selfish",
          when: (st) => kindCount(st, "cautious") > 0 || has(st, "went_dark"),
          effects: {
            emotions: { trust: -14, fear: 8, chaos: 6 },
            relationships: { dani: { affinity: -10, status: "strained" } },
            branch: "alone", flags: { going_alone: true },
            memory: { tag: "left_dani", text: "You left Dani on that rooftop mid-sentence. The sentence was 'wait—'", weight: 4, who: "DANI" },
          },
        },
      ],
    },
    {
      key: "mara_door",
      title: (s) => (has(s, "chose_truth") ? "THE CONFESSION" : "MARA'S BUILDING"),
      slug: () => "INT. MARA'S BUILDING — HALLWAY — 4:26 AM",
      lines: (s, b) => [
        L.a("Mara's hallway smells like fresh paint over old arguments."),
        L.a("Her door. You've stood here a hundred times. Never like this."),
        ...(has(s, "chose_truth")
          ? [L.vo("You rehearsed it in the elevator. All of it. Every version ends with her face changing.")]
          : has(s, "chose_coverup")
            ? [L.vo("The forged ledger is warm in your jacket like something alive."), L.a("If she opens it, she has to believe it. If she looks at you first — that's the problem.")]
            : [L.vo("You still don't know what you're going to say. You knock anyway. That's very you.")]),
        L.beat(),
        L.a("The door opens before you knock twice. She was waiting."),
        L.d("MARA", s.relationships.mara.trust > 45 ? "Took you long enough." : "You've got two minutes. The next person up those stairs isn't as patient as me."),
        L.d(YOU, reactionFor(b, s)),
        ...(has(s, "confronted_dani") ? [L.d("MARA", "Heard you and Dani had a moment. Word travels when you shout it off a roof.")] : []),
      ],
      question: () => "MARA IS WAITING. TWO MINUTES.",
      choices: (s) => [
        {
          key: "full_truth", label: "TELL HER EVERYTHING", kind: "honest",
          effects: {
            emotions: { courage: 12, regret: -8, fear: -6 },
            relationships: { mara: { trust: 16, affinity: 8 } },
            flags: { told_mara: true }, branch: "clean",
            memory: { tag: "told_mara", text: "You told Mara the whole thing, ugly parts included. Her face did change. Not how you expected.", weight: 5, who: "MARA" },
          },
        },
        {
          key: "half_truth", label: "TELL HER MOST OF IT", kind: "deceptive",
          effects: {
            emotions: { regret: 10, trust: -6 },
            relationships: { mara: { trust: -8 } },
            flags: { half_truth: true },
            memory: { tag: "half_truth", text: "You kept one detail back from Mara. The one that matters most, obviously.", weight: 5, who: "MARA" },
          },
        },
        {
          key: "hand_ledger", label: "HAND HER THE LEDGER", kind: "deceptive",
          when: (st) => has(st, "chose_coverup") && !has(st, "no_ezra"),
          effects: {
            emotions: { risk: 14, regret: 12, fear: 8 },
            relationships: { mara: { trust: -14 } },
            flags: { gave_forgery: true }, branch: "forged",
            memory: { tag: "gave_forgery", text: "Mara took the forged ledger with both hands and thanked you. That thank-you is going to live in your chest forever.", weight: 6, who: "MARA" },
          },
        },
        {
          key: "flip_it", label: "ASK WHY SHE'S TEXTING DANI", kind: "aggressive",
          when: (st) => has(st, "watching_dani") || has(st, "confronted_dani"),
          effects: {
            emotions: { anger: 10, confidence: 8 },
            relationships: { mara: { affinity: -6 }, dani: { trust: 4 } },
            flags: { flipped_on_mara: true },
            memory: { tag: "flipped_on_mara", text: "You turned the interrogation around on Mara. She almost looked impressed. Almost.", weight: 4, who: "MARA" },
          },
        },
      ],
    },
    {
      key: "the_turn",
      title: () => "WHO SENT THE TEXTS",
      slug: () => "EXT. RIVERSIDE — BLUE HOUR — 5:12 AM",
      lines: (s) => [
        L.a("The sky is doing that thing where night gives up slowly."),
        ...(has(s, "hunting") || has(s, "owes_ezra")
          ? [L.d("EZRA", "Found your burner. You're not going to like it."), L.a("Ezra turns the phone around. The account that bought it —"), L.d("EZRA", "— is Mara's assistant. Bought two. Guess who has the second one.")]
          : [L.a("Your phone buzzes one more time. Same number. Different tone."), L.m("UNKNOWN NUMBER", "YOU'RE OUT OF TIME. RIVERSIDE. COME ALONE."), L.a("And under it, a photo: Dani and Mara. Tonight. Together. Timestamped an hour ago.")]),
        L.beat(),
        L.vo("The whole night reshuffles in your head. Every warning. Every text. Someone built this maze around you on purpose."),
        ...(has(s, "all_in_dani") ? [L.vo("You said you trusted Dani. Out loud. That either saves this — or it's the punchline.")] : []),
        ...(has(s, "gave_forgery") ? [L.vo("And the forged ledger is out there with your fingerprints on the lie.")] : []),
      ],
      question: () => "RIVERSIDE. ALONE. OR NOT.",
      choices: () => [
        {
          key: "go_alone", label: "GO ALONE", kind: "bold",
          effects: {
            emotions: { courage: 14, fear: 8 }, branch: "showdown_solo",
            flags: { riverside_alone: true },
            memory: { tag: "riverside_alone", text: "They said come alone. You actually did. Nobody ever actually does.", weight: 4 },
          },
        },
        {
          key: "bring_dani", label: "BRING DANI", kind: "selfless",
          when: (st) => !has(st, "going_alone") && st.relationships.dani.status !== "hostile",
          effects: {
            emotions: { trust: 10, courage: 8 }, branch: "showdown_dani",
            relationships: { dani: { affinity: 8 } },
            flags: { riverside_dani: true },
            memory: { tag: "riverside_dani", text: "You brought Dani to the meet you were told to attend alone. A bet with your whole chest.", weight: 4, who: "DANI" },
          },
        },
        {
          key: "set_trap", label: "SET YOUR OWN TRAP", kind: "deceptive",
          when: (st) => has(st, "owes_ezra") || has(st, "capped_favour"),
          effects: {
            emotions: { chaos: 12, confidence: 10 }, branch: "showdown_trap",
            flags: { set_trap: true },
            memory: { tag: "set_trap", text: "You flipped the ambush. Ezra brought folding chairs. Ezra thinks of everything.", weight: 4, who: "EZRA" },
          },
        },
        {
          key: "dont_go", label: "DON'T GO. END IT YOUR WAY.", kind: "chaotic",
          effects: {
            emotions: { chaos: 16, risk: 12 }, branch: "showdown_none",
            flags: { no_show: true },
            memory: { tag: "no_show", text: "Everyone gathered at the riverside for a confrontation. You went somewhere else entirely.", weight: 5 },
          },
        },
      ],
    },
    {
      key: "finale",
      title: (s) => (has(s, "no_show") ? "THE EMPTY RIVERSIDE" : "SUNRISE"),
      slug: (s) => (has(s, "no_show") ? "INT. MARA'S OFFICE — DAWN" : "EXT. RIVERSIDE — DAWN"),
      isFinal: true,
      seconds: 45,
      lines: (s) => {
        const lines: ScriptLine[] = [];
        if (has(s, "no_show")) {
          lines.push(
            L.a("They waited at the riverside. You were already in Mara's office, sitting in her chair, lights off."),
            L.a("When she walks in, you slide the real numbers across the desk. All of them. Including yours."),
            L.d("MARA", "...You're either the bravest person I know or the dumbest."),
            L.d(YOU, "Historically? Both."),
          );
        } else if (has(s, "set_trap")) {
          lines.push(
            L.a("The riverside, but on your terms. Ezra's floodlights snap on and the whole conspiracy is suddenly very well lit."),
            L.a("Mara. Dani. The assistant with the twin burner. Everyone talking at once —"),
            L.a("— and you, finally, saying nothing. Letting the silence collect the debt."),
          );
        } else if (has(s, "riverside_dani")) {
          lines.push(
            L.a("You and Dani walk in shoulder to shoulder. Whatever else is true tonight, that's true."),
            L.d("MARA", "I told you to come alone."),
            L.d("DANI", "They don't do alone. It's their whole thing."),
          );
        } else {
          lines.push(
            L.a("You walk in alone. The river is the only witness that never testifies."),
            L.d("MARA", "The texts were mine. The warning about Dani — that was real. Just not how you think."),
            L.a("The truth lands in pieces, out of order, the way real ones do."),
          );
        }
        lines.push(
          L.beat(),
          L.vo("Six weeks ago you made a mistake. Tonight you found out which kind of person you are when it surfaces."),
          L.t("YOUR STORY IS DECIDING HOW IT ENDS."),
        );
        return lines;
      },
      question: () => "",
      choices: () => [],
    },
  ],
};

/* ═══════════════════════════════════════════ YOUR EX TEXTS YOU AT 2 AM */

const ex2am: StoryTemplate = {
  key: "ex_texts_2am",
  title: "DELIVERED. 2:04 AM.",
  genre: "Romance / Drama / Comedy",
  logline: "Your ex texts you at 2 AM. Seven words. By sunrise, everything you rebuilt is negotiable.",
  trending: true,
  world: "a quiet apartment, a loud phone, an entire history in a chat thread",
  beats: [
    {
      key: "the_text",
      title: () => "2:04 AM",
      slug: () => "INT. YOUR APARTMENT — 2:04 AM",
      seconds: 30,
      lines: (s) => [
        L.a("You weren't asleep. You were doing the thing where you're aggressively about to be."),
        L.a("The phone lights the ceiling."),
        L.m("ALEX", "I still have your hoodie. And a question."),
        L.beat(),
        L.a("Two years of history compress into one notification."),
        ...(s.emotions.love > 60 ? [L.vo("You know exactly which hoodie. You know exactly which question you're hoping it is.")] : [L.vo("Delete the thread, your brain says. Your thumb hovers somewhere very different.")]),
      ],
      question: () => "SEVEN WORDS. YOUR MOVE.",
      choices: () => [
        { key: "reply_now", label: "REPLY INSTANTLY", kind: "romantic", effects: { emotions: { love: 12, risk: 8, fear: 4 }, branch: "engaged", flags: { replied_fast: true }, memory: { tag: "replied_fast", text: "You replied in forty seconds. Alex screenshotted the timestamp. You know they did.", weight: 4, who: "ALEX" } } },
        { key: "leave_read", label: "LEAVE IT ON READ TILL MORNING", kind: "cautious", effects: { emotions: { confidence: 10, love: -4 }, branch: "power", flags: { left_on_read: true }, memory: { tag: "left_on_read", text: "You left Alex on read for six hours. A power move with a body count.", weight: 4, who: "ALEX" } } },
        { key: "call", label: "CALL. AT 2 AM. LIKE A MANIAC.", kind: "bold", effects: { emotions: { courage: 14, chaos: 10, love: 8 }, branch: "call", flags: { called_2am: true }, memory: { tag: "called_2am", text: "You called at 2 AM. Nobody calls. Alex picked up on half a ring.", weight: 5, who: "ALEX" } } },
        { key: "group_chat", label: "SCREENSHOT IT TO THE GROUP CHAT", kind: "chaotic", effects: { emotions: { chaos: 14, trust: -6 }, branch: "public", flags: { told_gc: true }, memory: { tag: "told_gc", text: "The group chat has the screenshot. The group chat never forgets. The group chat has one traitor.", weight: 5, who: "DANI" } } },
      ],
    },
    {
      key: "the_question",
      title: () => "THE QUESTION",
      slug: (s) => (has(s, "called_2am") ? "INT. YOUR APARTMENT — ON THE PHONE" : "INT. YOUR APARTMENT — THE THREAD"),
      lines: (s, b) => [
        ...(has(s, "called_2am")
          ? [L.d("ALEX", "I forgot you do this. Just... call."), L.d(YOU, "You texted first. At two in the morning. Statute of limitations is waived.")]
          : has(s, "left_on_read")
            ? [L.a("Morning. You reply with one word and no punctuation. Devastating."), L.m("ALEX", "ok wow. six hours. noted.")]
            : [L.m("ALEX", "didn't expect you to answer"), L.m("ALEX", "ok. the question.")]),
        L.beat(),
        L.m("ALEX", "Why did you actually end it? Not the version you told people."),
        L.vo("There it is. The one question with no good 2 AM answer."),
        L.d("DANI", reactionFor(b, s)),
        ...(has(s, "told_gc") ? [L.a("The group chat is typing. All of them. Simultaneously. This is a hostage situation now.")] : []),
      ],
      question: () => "THE REAL REASON. DO THEY GET IT?",
      choices: () => [
        { key: "truth", label: "THE ACTUAL TRUTH", kind: "honest", effects: { emotions: { courage: 12, regret: -8, love: 6 }, branch: "honest", flags: { told_truth: true }, memory: { tag: "told_truth", text: "You typed the real reason and hit send before you could sand it down.", weight: 5, who: "ALEX" } } },
        { key: "deflect", label: "A JOKE. DEFLECT. CLASSIC.", kind: "deceptive", effects: { emotions: { chaos: 8, regret: 8, fear: 4 }, flags: { deflected: true }, memory: { tag: "deflected", text: "You answered the most sincere question you've ever been asked with a meme. It was a good meme. It was still a dodge.", weight: 4, who: "ALEX" } } },
        { key: "counter", label: "ASK WHY THEY REALLY TEXTED", kind: "aggressive", effects: { emotions: { confidence: 10, trust: -4 }, branch: "counter", flags: { countered: true }, memory: { tag: "countered", text: "You answered the question with a question. Two can play. Two ARE playing.", weight: 3, who: "ALEX" } } },
      ],
    },
    {
      key: "the_reason",
      title: () => "WHY THEY TEXTED",
      slug: () => "EXT. 24-HOUR DINER — 3:12 AM",
      lines: (s) => [
        L.a("Somehow — nobody will later agree whose idea it was — you're both in the diner booth you used to close down."),
        L.a("Alex slides the hoodie across the table like a treaty."),
        L.d("ALEX", "I'm moving. Far. I got the job."),
        L.beat(),
        L.d("ALEX", "Flight's at nine. I didn't want to leave with... whatever this is. Unfinished."),
        ...(has(s, "told_truth")
          ? [L.d("ALEX", "And what you said just now — that's the first honest thing either of us has said in a year.")]
          : [L.d("ALEX", "And you're still doing the thing where your face says it and your mouth doesn't.")]),
        ...(s.emotions.love > 66 ? [L.vo("Nine o'clock. The night just grew a countdown.")] : [L.vo("You feel the exits: the door, the joke, the phone. All available. None appealing.")]),
      ],
      question: () => "FLIGHT AT NINE. WHAT IS THIS?",
      choices: (s) => [
        { key: "ask_stay", label: "ASK THEM TO STAY", kind: "romantic", effects: { emotions: { love: 16, courage: 12, fear: 8 }, branch: "stay", flags: { asked_stay: true }, memory: { tag: "asked_stay", text: "You said 'stay.' Out loud. In a diner. With witnesses.", weight: 6, who: "ALEX" } } },
        { key: "let_go", label: "TELL THEM TO TAKE THE JOB", kind: "selfless", effects: { emotions: { regret: 10, love: 8, courage: 8 }, branch: "release", flags: { blessed_leaving: true }, memory: { tag: "blessed_leaving", text: "You told Alex to go. Your voice only broke on one word. They noticed which one.", weight: 6, who: "ALEX" } } },
        { key: "come_with", label: "SAY YOU'LL COME WITH", kind: "chaotic", when: (st) => kindCount(st, "bold") + kindCount(st, "chaotic") >= 1, effects: { emotions: { chaos: 16, love: 12, risk: 14 }, branch: "leap", flags: { offered_to_come: true }, memory: { tag: "offered_to_come", text: "'So I'll come.' Three words, zero planning, one stunned silence.", weight: 6, who: "ALEX" } } },
        { key: "closure", label: "JUST... CLOSURE. FINALLY.", kind: "honest", effects: { emotions: { regret: -8, confidence: 8, love: -6 }, branch: "closure", flags: { chose_closure: true }, memory: { tag: "chose_closure", text: "You shook hands. Like colleagues. It was the most intimate thing that happened all night.", weight: 4, who: "ALEX" } } },
      ],
    },
    {
      key: "the_complication",
      title: () => "THE COMPLICATION",
      slug: () => "EXT. DINER PARKING LOT — 4:30 AM",
      lines: (s, b) => [
        L.a("Parking lot. That specific 4 AM cold that makes everything feel like a confession."),
        L.a("Dani's car pulls in hot and parks across two spaces. Emergency energy."),
        ...(has(s, "told_gc")
          ? [L.d("DANI", "The group chat leaked. Alex's roommate saw the screenshots. All of them. Including what you said in March.")]
          : [L.d("DANI", "Don't get in that car. Alex didn't tell you everything about the job. Ask them who else is going.")]),
        L.beat(),
        L.d("ALEX", "...I can explain."),
        L.vo("The night was almost simple for one entire hour."),
        L.d(YOU, reactionFor(b, s)),
      ],
      question: () => "WHO DO YOU EVEN BELIEVE?",
      choices: () => [
        { key: "hear_alex", label: "LET ALEX EXPLAIN", kind: "romantic", effects: { emotions: { trust: 10, love: 6 }, relationships: { dani: { affinity: -4 } }, flags: { heard_alex: true }, memory: { tag: "heard_alex", text: "You gave Alex the benefit of the doubt in front of Dani. Dani's face did a whole monologue.", weight: 4, who: "DANI" } } },
        { key: "side_dani", label: "TRUST DANI. WALK.", kind: "cautious", effects: { emotions: { trust: -8, regret: 6 }, relationships: { dani: { affinity: 10, trust: 8 } }, branch: "walked", flags: { walked_out: true }, memory: { tag: "walked_out", text: "You walked at 4:30 AM on the word of your best friend. Loyalty has a timestamp now.", weight: 5, who: "DANI" } } },
        { key: "demand_all", label: "EVERYONE TALKS. RIGHT NOW.", kind: "aggressive", effects: { emotions: { anger: 10, courage: 10 }, flags: { tribunal: true }, memory: { tag: "tribunal", text: "You held a full tribunal in a diner parking lot. The waitress watched from the window eating fries.", weight: 4 } } },
      ],
    },
    {
      key: "ex_finale",
      title: () => "9:00 AM",
      slug: () => "INT. AIRPORT — DEPARTURES — 8:41 AM",
      isFinal: true,
      seconds: 45,
      lines: (s) => {
        const lines: ScriptLine[] = [];
        if (has(s, "offered_to_come")) {
          lines.push(
            L.a("Departures. You own exactly one carry-on, packed in nine minutes, containing zero useful items."),
            L.d("ALEX", "You understand this is insane."),
            L.d(YOU, "You texted ME at 2 AM. This is legally your fault."),
          );
        } else if (has(s, "asked_stay")) {
          lines.push(
            L.a("8:41. The flight boards in nineteen minutes. Alex is not in the security line."),
            L.a("Alex is in front of you, boarding pass in hand, not moving."),
            L.d("ALEX", "Say it one more time. Not the diner version. The real one."),
          );
        } else if (has(s, "blessed_leaving")) {
          lines.push(
            L.a("You drove them. Of course you drove them. The hoodie sits folded on the back seat, returned for real this time."),
            L.d("ALEX", "You're the only person who ever told me to go and meant it."),
            L.a("The hug lasts four seconds too long to be nothing."),
          );
        } else {
          lines.push(
            L.a("You're not at the airport. You're home. Phone on the counter, face down, a decision in progress."),
            L.a("At 9:02 it buzzes one last time."),
            L.m("ALEX", "Window seat. Your hoodie fit in my bag after all. Both of us knew it would."),
          );
        }
        lines.push(L.beat(), L.vo("Some stories end. Some just change apps."), L.t("YOUR STORY IS DECIDING HOW IT ENDS."));
        return lines;
      },
      question: () => "",
      choices: () => [],
    },
  ],
};

/* ══════════════════════════════════════════════════ THE CITY GOES DARK */

const cityDark: StoryTemplate = {
  key: "city_goes_dark",
  title: "GRID ZERO",
  genre: "Thriller / Disaster / Dark Comedy",
  logline: "Every light in the city dies at once — and your phone is the only one still working.",
  trending: true,
  world: "a blacked-out city where your battery percentage is the plot",
  beats: [
    {
      key: "blackout",
      title: () => "11:58 PM",
      slug: () => "EXT. CITY — ROOFTOP BAR — 11:58 PM",
      seconds: 30,
      lines: () => [
        L.a("A rooftop bar. Someone's birthday. You're mid-sentence in a story you've told better before."),
        L.a("Then the skyline goes out. All of it. At once. Like someone closed the city's laptop."),
        L.beat(),
        L.a("Phones come out — dead. All dead. Screens black."),
        L.a("Except yours. Full signal. 87%. Glowing like a confession."),
        L.m("UNKNOWN NUMBER", "DON'T SHOW ANYONE YOUR PHONE."),
        L.vo("Forty people on this roof. Statistically, one of them has already seen it."),
      ],
      question: () => "EVERY EYE FINDS THE ONLY LIGHT.",
      choices: () => [
        { key: "hide_it", label: "POCKET IT. FAST.", kind: "cautious", effects: { emotions: { fear: 8, risk: 4 }, branch: "hidden", flags: { hid_phone: true }, memory: { tag: "hid_phone", text: "You hid the only working phone in the city. Forty people were suddenly very interested in your jacket.", weight: 4 } } },
        { key: "announce", label: "HOLD IT UP. 'WHO NEEDS A CALL?'", kind: "selfless", effects: { emotions: { courage: 12, trust: 10, chaos: 6 }, branch: "hero", flags: { shared_phone: true }, memory: { tag: "shared_phone", text: "You offered your phone to a rooftop full of strangers. A queue formed instantly. Humanity is like that.", weight: 5 } } },
        { key: "text_back", label: "TEXT BACK: 'WHO IS THIS?'", kind: "bold", effects: { emotions: { confidence: 8, risk: 10 }, branch: "contact", flags: { engaged_unknown: true }, memory: { tag: "engaged_unknown", text: "You replied to the number that predicted the blackout. It replied back instantly. Too instantly.", weight: 5, who: "UNKNOWN" } } },
        { key: "sell_it", label: "AUCTION CALLS. $20 A MINUTE.", kind: "selfish", effects: { emotions: { ambition: 12, chaos: 12, trust: -8 }, branch: "hustle", flags: { sold_calls: true }, memory: { tag: "sold_calls", text: "You monetised a disaster in under ninety seconds. A personal record. Several people memorised your face.", weight: 5 } } },
      ],
    },
    {
      key: "descent",
      title: () => "FORTY FLOORS DOWN",
      slug: () => "INT. STAIRWELL — CANDLELIGHT",
      lines: (s, b) => [
        L.a("Forty floors of stairwell, lit by other people's lighters."),
        L.a("Dani's got your sleeve. Mara — who invited Mara? — is two steps behind, too calm, like blackouts are a Tuesday."),
        L.d("MARA", "Your phone. It kept working because someone paid for it to. Ask me how I know."),
        L.beat(),
        ...(has(s, "engaged_unknown")
          ? [L.m("UNKNOWN NUMBER", "MIDNIGHT MARKET. BRING THE PHONE. COME ALONE."), L.d("DANI", "Every horror movie starts with exactly that text.")]
          : [L.d("MARA", "There's a generator market under the bridge. Whoever did this will be there. So will answers."), L.d("DANI", "Or, counterpoint: we get snacks and hide.")]),
        L.d(YOU, reactionFor(b, s)),
        ...(s.emotions.chaos > 62 ? [L.a("Somewhere above, the birthday party has started singing. No power. No fear. Legends.")] : []),
      ],
      question: () => "THE BRIDGE MARKET. GO?",
      choices: () => [
        { key: "go_market", label: "GO TO THE MARKET", kind: "bold", effects: { emotions: { courage: 10, risk: 10 }, branch: "market", flags: { went_market: true }, memory: { tag: "went_market", text: "You walked into a blackout market with the most valuable object in the city in your pocket.", weight: 4 } } },
        { key: "go_home", label: "GET EVERYONE SOMEWHERE SAFE FIRST", kind: "selfless", effects: { emotions: { loyalty: 12, trust: 8 }, relationships: { dani: { affinity: 10 } }, branch: "shelter", flags: { protected_group: true }, memory: { tag: "protected_group", text: "You got six strangers and one best friend behind a locked door before doing anything interesting.", weight: 4, who: "DANI" } } },
        { key: "press_mara", label: "PRESS MARA. SHE KNOWS TOO MUCH.", kind: "aggressive", effects: { emotions: { anger: 8, trust: -6 }, relationships: { mara: { trust: -8 } }, branch: "interrogate", flags: { pressed_mara: true }, memory: { tag: "pressed_mara", text: "You cornered Mara in a stairwell. She answered every question with a better question.", weight: 4, who: "MARA" } } },
      ],
    },
    {
      key: "market",
      title: () => "THE MIDNIGHT MARKET",
      slug: () => "EXT. UNDER THE BRIDGE — GENERATOR LIGHT",
      lines: (s) => [
        L.a("Under the bridge, someone's wired a dozen generators into a cathedral of work lamps."),
        L.a("Cash for batteries. Batteries for favours. Favours for names."),
        ...(has(s, "sold_calls") ? [L.a("Three separate people recognise you from the rooftop. Your reputation arrived first. It's mixed.")] : []),
        L.d("EZRA", "There's my favourite plot device."),
        L.beat(),
        L.d("EZRA", "The blackout's not an accident. It's a distraction. Something's being moved tonight, and every camera in the city is asleep."),
        L.d("EZRA", "Your phone stayed on because you're on a whitelist. Question is — who put you on it?"),
        ...(has(s, "pressed_mara") ? [L.vo("Mara knew about the whitelist. Mara is on the whitelist. The math is doing itself.")] : []),
      ],
      question: () => "THE WHITELIST. PULL THE THREAD?",
      choices: (s) => [
        { key: "trace", label: "TRACE THE WHITELIST WITH EZRA", kind: "bold", effects: { emotions: { risk: 10, ambition: 8 }, relationships: { ezra: { affinity: 8, trust: 6 } }, branch: "trace", flags: { traced_list: true, owes_ezra: true }, memory: { tag: "traced_list", text: "Ezra traced the whitelist for the price of one blank favour. There were only four names. Yours was second.", weight: 6, who: "EZRA" } } },
        { key: "destroy", label: "KILL YOUR PHONE. OFF THE LIST.", kind: "chaotic", effects: { emotions: { chaos: 14, fear: -6 }, branch: "offgrid", flags: { killed_phone: true }, memory: { tag: "killed_phone", text: "You dropped the only working phone in the city into a rain barrel. The market went silent. Someone whispered 'legend.'", weight: 6 } } },
        { key: "bait", label: "USE THE PHONE AS BAIT", kind: "deceptive", when: (st) => has(st, "engaged_unknown") || has(st, "traced_list") || kindCount(st, "deceptive") > 0, effects: { emotions: { confidence: 10, risk: 12 }, branch: "bait", flags: { phone_bait: true }, memory: { tag: "phone_bait", text: "You texted the unknown number a lie about where you'd be. Then you went there anyway, early, to watch.", weight: 5, who: "UNKNOWN" } } },
      ],
    },
    {
      key: "dark_finale",
      title: () => "WHEN THE LIGHTS COME BACK",
      slug: () => "EXT. CITY — 4:59 AM",
      isFinal: true,
      seconds: 45,
      lines: (s) => {
        const lines: ScriptLine[] = [];
        if (has(s, "killed_phone")) {
          lines.push(
            L.a("4:59 AM. You're on a rooftop with no phone, no map, no plan — and, for the first time all night, no target on your back."),
            L.a("The grid stutters. Then the whole city lights at once, block by block, like applause."),
            L.d("DANI", "You realise we have no idea how any of it ended."),
            L.d(YOU, "Feels amazing, right?"),
          );
        } else if (has(s, "phone_bait")) {
          lines.push(
            L.a("The trap worked. Of course it worked — the person who came for the phone was on the whitelist too."),
            L.a("Name four. The one nobody says out loud. Standing in generator light, holding a bag they shouldn't have."),
            L.d(YOU, "The cameras are off. So talk."),
          );
        } else if (has(s, "protected_group")) {
          lines.push(
            L.a("Sunrise finds your apartment full of strangers asleep on every surface, one birthday cake with no candles left, and Dani on watch by the window."),
            L.d("DANI", "City's coming back. You missed the whole mystery."),
            L.d(YOU, "Didn't miss anything that matters."),
          );
        } else {
          lines.push(
            L.a("The whitelist had four names. By 4:59 you know all of them, and one of them knows you know."),
            L.a("The lights come back mid-standoff — the whole skyline igniting behind you like the city picked a side."),
            L.d("MARA", "Well. Now everyone can see us."),
          );
        }
        lines.push(L.beat(), L.vo("Cities forget by morning. People don't."), L.t("YOUR STORY IS DECIDING HOW IT ENDS."));
        return lines;
      },
      question: () => "",
      choices: () => [],
    },
  ],
};

/* ═══════════════════════════════════════════════════ YOU WAKE UP FAMOUS */

const wakeUpFamous: StoryTemplate = {
  key: "wake_up_famous",
  title: "OVERNIGHT",
  genre: "Comedy / Drama / Satire",
  logline: "You wake up with 11 million followers and no memory of posting anything.",
  trending: true,
  world: "your bedroom, then the entire internet at once",
  beats: [
    {
      key: "wake",
      title: () => "9:47 AM",
      slug: () => "INT. YOUR BEDROOM — 9:47 AM",
      seconds: 30,
      lines: () => [
        L.a("You wake up to 41,306 notifications and a battery at 4%, wheezing."),
        L.a("Your last post — 2:37 AM, which you have zero memory of making — has eleven million views."),
        L.a("It's you. Talking directly to camera. Saying something the entire internet has decided is either genius or a declaration of war."),
        L.m("DANI", "DO NOT OPEN TWITTER"),
        L.m("DANI", "OPEN TWITTER"),
        L.m("DANI", "actually no. call me. CALL ME."),
        L.vo("Somewhere in your camera roll is the unedited original. And it's longer than the clip."),
      ],
      question: () => "4% BATTERY. ELEVEN MILLION VIEWS.",
      choices: () => [
        { key: "watch_full", label: "WATCH THE FULL ORIGINAL FIRST", kind: "cautious", effects: { emotions: { fear: 8, confidence: 4 }, branch: "informed", flags: { saw_original: true }, memory: { tag: "saw_original", text: "You watched the full unedited video. The clip left out the last forty seconds. The last forty seconds change everything.", weight: 6 } } },
        { key: "post_again", label: "POST A FOLLOW-UP. RIDE IT.", kind: "chaotic", effects: { emotions: { chaos: 14, ambition: 10, risk: 10 }, branch: "ride", flags: { doubled_down: true }, memory: { tag: "doubled_down", text: "You posted a sequel before understanding the original. The internet respected the audacity. Briefly.", weight: 5 } } },
        { key: "call_dani", label: "CALL DANI", kind: "cautious", effects: { emotions: { trust: 8 }, relationships: { dani: { affinity: 6 } }, branch: "dani", flags: { called_dani_first: true }, memory: { tag: "called_dani_first", text: "You called Dani before checking your own mentions. Dani noticed. Dani will bring it up at your wedding.", weight: 3, who: "DANI" } } },
        { key: "delete", label: "DELETE EVERYTHING", kind: "selfish", effects: { emotions: { fear: 10, chaos: 8 }, branch: "scrub", flags: { deleted_post: true }, memory: { tag: "deleted_post", text: "You deleted a post with eleven million views. Eleven million people had already screen-recorded it. The delete became the story.", weight: 6 } } },
      ],
    },
    {
      key: "offer",
      title: () => "THE OFFER",
      slug: () => "INT. YOUR KITCHEN — 11:20 AM",
      lines: (s, b) => [
        L.a("By 11 AM there are four camera crews outside and a brand deal in your inbox with a number that looks like a phone number. It's a dollar amount."),
        L.d("DANI", "There's a woman on your fire escape. She says she's your manager."),
        L.d("MARA", "I am now. Sign nothing. Say nothing. Smile at nobody.", "through the window"),
        L.beat(),
        ...(has(s, "saw_original")
          ? [L.vo("The full video sits in your camera roll like an unexploded shell. Whoever clipped it cut the part that would flip the story completely.")]
          : [L.vo("You still haven't watched the whole original. You are the least informed person in your own scandal.")]),
        L.d(YOU, reactionFor(b, s)),
        ...(has(s, "doubled_down") ? [L.a("Your follow-up just passed three million. The comments have formed factions. The factions have flags.")] : []),
      ],
      question: () => "THE NUMBER IN YOUR INBOX HAS COMMAS.",
      choices: () => [
        { key: "sign", label: "TAKE THE DEAL", kind: "selfish", effects: { emotions: { ambition: 14, trust: -6 }, branch: "deal", flags: { took_deal: true }, memory: { tag: "took_deal", text: "You signed with a brand before lunch. The contract had a morality clause. You laughed. The lawyer didn't.", weight: 5 } } },
        { key: "trust_mara", label: "LET MARA RUN IT", kind: "cautious", effects: { emotions: { trust: 8, confidence: 6 }, relationships: { mara: { affinity: 10, trust: 8 } }, branch: "managed", flags: { hired_mara: true }, memory: { tag: "hired_mara", text: "You hired the stranger from the fire escape. Her first act: confiscating your phone. Her second: winning.", weight: 4, who: "MARA" } } },
        { key: "go_live", label: "GO LIVE. RAW. NO PLAN.", kind: "bold", effects: { emotions: { courage: 14, chaos: 12 }, branch: "live", flags: { went_live: true }, memory: { tag: "went_live", text: "You went live with bedhead and zero notes to two million concurrent viewers. Authenticity or self-destruction — the chat couldn't decide.", weight: 6 } } },
      ],
    },
    {
      key: "the_clip",
      title: () => "WHO CLIPPED IT",
      slug: () => "INT. PARKING GARAGE — 6:15 PM",
      lines: (s) => [
        L.a("Ezra finds you in a parking garage, because information like this doesn't do daylight."),
        L.d("EZRA", "Found who clipped your video. Uploaded from a device on your own wifi. 2:41 AM."),
        L.beat(),
        L.a("Four people had that wifi password. You. Dani. Alex — who still auto-connects. And Mara, since exactly this morning... which doesn't math."),
        ...(has(s, "hired_mara") ? [L.vo("Your manager was on your wifi before she was your manager. That's either impressive or terrifying. Both. It's both.")] : []),
        ...(has(s, "saw_original") ? [L.vo("Whoever clipped it watched the full video first — and chose the cut that would burn you brightest.")] : [L.vo("You STILL haven't watched the original all the way through. Even Ezra is judging you now.")]),
      ],
      question: () => "SOMEONE ON YOUR WIFI DID THIS.",
      choices: () => [
        { key: "confront_dani", label: "ASK DANI. POINT BLANK.", kind: "aggressive", effects: { emotions: { anger: 10, trust: -8 }, relationships: { dani: { trust: -10, status: "strained" } }, branch: "accuse", flags: { accused_dani: true }, memory: { tag: "accused_dani", text: "You asked your best friend if they sold you out. The pause before their answer was one second too long.", weight: 6, who: "DANI" } } },
        { key: "trap_clipper", label: "SET A TRAP POST", kind: "deceptive", effects: { emotions: { confidence: 10, chaos: 8 }, branch: "sting", flags: { trap_post: true }, memory: { tag: "trap_post", text: "You posted bait — a fake 'draft' only your wifi could see. Then you waited for it to leak. It leaked in eleven minutes.", weight: 6 } } },
        { key: "drop_it", label: "IT DOESN'T MATTER. RIDE THE WAVE.", kind: "chaotic", effects: { emotions: { chaos: 10, ambition: 8, regret: 4 }, branch: "wave", flags: { ignored_leak: true }, memory: { tag: "ignored_leak", text: "You decided not to know which friend did it. Some doors you leave shut on purpose.", weight: 5 } } },
      ],
    },
    {
      key: "famous_finale",
      title: () => "24 HOURS FAMOUS",
      slug: () => "EXT. ROOFTOP — 2:37 AM — EXACTLY ONE DAY LATER",
      isFinal: true,
      seconds: 45,
      lines: (s) => {
        const lines: ScriptLine[] = [];
        if (has(s, "went_live")) {
          lines.push(
            L.a("2:37 AM. Exactly twenty-four hours since the post. You're live again — by choice this time."),
            L.a("Two million people watching you decide, in real time, who you're going to be about this."),
            L.d(YOU, "Okay. The full story. From the top. No cuts."),
          );
        } else if (has(s, "trap_post")) {
          lines.push(
            L.a("The trap post leaked. The device that leaked it is sitting on the table between you and its owner."),
            L.a("It's not who the audience voted for. It never is."),
            L.d(YOU, "Before you say anything — I already know. I've known since eleven minutes after I posted it."),
          );
        } else if (has(s, "took_deal")) {
          lines.push(
            L.a("The brand shoot wraps at 2 AM. Everyone keeps calling you 'the talent' like it's your name."),
            L.a("In the car home, the driver eyes you in the mirror."),
            L.d("DRIVER", "You're the one from the video, yeah? My kid says you sold out."),
            L.d(YOU, "Tell your kid the cheque cleared."),
          );
        } else {
          lines.push(
            L.a("The algorithm has already found tomorrow's main character — a llama in a hardware store, which, fair."),
            L.a("Your follower count is a number you'll never fully spend. Dani's on the couch. Mara took 15%. The original video sits unwatched by exactly one person on Earth."),
            L.d("DANI", "So. Are you ever going to watch the whole thing?"),
          );
        }
        lines.push(L.beat(), L.vo("Fame lasted a day. What you did with it is the part that's yours."), L.t("YOUR STORY IS DECIDING HOW IT ENDS."));
        return lines;
      },
      question: () => "",
      choices: () => [],
    },
  ],
};

/* ---------------------------------------------------------------- export */

export const TEMPLATES: StoryTemplate[] = [oneNightLeft, ex2am, cityDark, wakeUpFamous];

export function getTemplate(key: string): StoryTemplate | null {
  return TEMPLATES.find((t) => t.key === key) ?? null;
}

/** Trending prompt list for the create screen (spec §20). */
export const TRENDING_PROMPTS = TEMPLATES.filter((t) => t.trending).map((t) => ({
  key: t.key, title: t.title, genre: t.genre, logline: t.logline,
}));

/** Pick a template biased by the player's card when they ask for "surprise me". */
export function pickTemplateFor(eraKey: string, chaos: number): StoryTemplate {
  if (eraKey === "heartbreaker" || eraKey === "healing") return ex2am;
  if (eraKey === "ceo" || eraKey === "villain") return oneNightLeft;
  if (chaos >= 70) return wakeUpFamous;
  if (eraKey === "lowkey" || eraKey === "mysterious") return cityDark;
  return oneNightLeft;
}
