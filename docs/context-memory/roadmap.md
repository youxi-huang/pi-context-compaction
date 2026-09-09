# Roadmap

This document states where the project is going and how each step will be judged. It is a statement of intent, not a schedule. Release dates are not promised, and the order of the middle steps may change once daily use shows which problems matter most.

## Version policy

Patch releases (0.x.y) carry adaptation only: ports to new Pi releases, interface changes, dependency and security updates, and CI fixes. They do not change compaction behavior or add capabilities.

Minor releases (0.x.0) each answer one question about the project. A minor release ships when its acceptance criterion is met, not when a date arrives.

A major release (1.0.0) marks a change in what the project is, not an accumulation of features. The first major release is reserved for the point at which this project stops being a modified Pi distribution and becomes an extension plus a small set of upstream changes.

## Goals and how they are measured

The long-term aim is compaction that is small, precise and unobtrusive: little token overhead, notes that let the next model continue the task without asking again, and no visible pause or interruption when things work. Unobtrusive does not mean silent on failure. The project deliberately reports a failed compaction and stops requests rather than substituting a different writer or a weaker summary, because a note whose sources cannot be trusted is worse than no note. That choice stays.

Four measurements track the goals:

- Compaction pause: wall-clock time from the compaction trigger to the next provider request.
- Recovery accuracy: the share of probe questions a model answers correctly after compaction, using replayable synthetic sessions.
- Token overhead: writer tokens and note size relative to the original records they replace.
- Host footprint: lines changed against upstream Pi.

## Planned minor releases

**0.2.0, daily use.** Released 2026-09-09. The maintainer's own Pi installation runs this build as its only compactor, and the local event log records every compaction attempt. The deliverable of the 0.2.x period is a list of what feels slow, wrong or noisy in ordinary work; the first real two-checkpoint session already produced three changes that shipped in 0.2.0 itself. Every later release is shaped by that list.

**0.3.0, measurement.** A replayable evaluation enters CI: synthetic session fixtures, probe questions, and the four measurements above. The fixtures include multi-checkpoint sessions: a standing constraint planted before the first checkpoint, two compactions, then a probe after the second, because a real two-checkpoint session on 2026-09-09 showed the newest note dropping every fact from the first phase and a single-checkpoint probe cannot see that. This release changes no compaction behavior. It establishes the baseline that later releases are compared against.

**0.4.0, latency.** Increment notes are written in the background before the threshold is reached, so the compaction itself becomes a validation and commit step. The writer is tiered: a smaller model handles increments and a larger one handles boundaries or failed validation. Accepted when compaction pause falls without a drop in recovery accuracy.

**0.5.0, note quality.** Note structure is revised from evaluation failures rather than from intuition, and history retrieval gains a typed index over decisions, file changes and errors so a model pages less. Accepted when recovery accuracy rises and average retrieval calls fall.

**0.6.0, footprint.** Note size and writer budget adapt to task length, and serialized checkpoint size joins the evaluation report. Accepted when token overhead falls while recovery accuracy holds.

**0.7.0 to 0.9.0, thinner host.** Each change to the Pi host is classified as one that could become an upstream hook, one that could move into the extension, or one that must remain. Each release removes one class and proposes the corresponding hooks upstream. The only measurement for these releases is host footprint.

**1.0.0, independence.** The remaining host changes are small enough to submit upstream as a few focused pull requests, or have been accepted. The project becomes an ordinary extension. Packaging for npm and the Pi package directory begins here, not earlier, because before this point every Pi release would invalidate a package.

## External baseline

Each evaluation report includes, where it can be run, the same probe set against the provider's native compaction. The project exists because it recovers tasks better than that baseline. If a release loses to the baseline on recovery accuracy, that release's notes will say so and open the question of whether the project should continue.

## After 1.0

Once the project is an ordinary extension, its default state is maintenance: patch releases for adaptation and a periodic run of the evaluation against native compaction. Two directions would justify further minor releases. One is portability, since the note, history and grant model does not depend on Pi and could serve other agent hosts through thin adapters. The other is a broader memory scope. The second is explicitly outside the current design, and adding it would change what the project is; it would belong in a separate project or a second major release, decided at that time rather than assumed now.
